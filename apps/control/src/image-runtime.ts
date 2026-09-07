import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { CloudError, type ImageBuildId } from '@agent-cloud/contracts';
import { databaseTime, type Connection } from '@agent-cloud/db';
import {
  createHetznerRequest,
  HetznerImageProvider,
  readHetznerCatalog,
  readHetznerImagePrice,
} from '@agent-cloud/hetzner';
import { imageReleaseKeyId, verifyImageInputs } from '@agent-cloud/images';
import { createPublicKey } from 'node:crypto';
import { createGuestProbe, createImageBuilder } from '@agent-cloud/remote';
import { advanceImageBuild, cleanupImageBuild } from './advance-image-build.js';
import { createImageAccessStore } from './image-access.js';
import { inspectImageBuild, requestImageCleanup, type ImageBuild } from './image-builds.js';
import { createImageRenderer } from './image-renderer.js';
import { createImageVerifierEnrollment } from './image-verifier-enrollment.js';
import { createImageVerifierRuntime } from './image-verifier-runtime.js';
import { readPrivateFile } from './private-file.js';
import { createImageReleaseKeySource, readRuntimeIdentity } from './runtime-identity.js';
import { readPublishedImage } from './image-publication.js';
import { imageEnrollmentUrl, type ImageRuntimeConfig } from './runtime-config.js';
import { readRuntimeSigner } from './runtime-pki.js';
import type { Config } from './config.js';

/** Composes real ports; construction does not create or start any provider resource. */
export async function createImageRuntime(input: {
  connection: Connection;
  config: Extract<Config, { provider: 'hetzner' }>;
  runtime: ImageRuntimeConfig;
  transport?: typeof fetch;
}) {
  const { connection, config, runtime } = input;
  const enrollmentUrl = imageEnrollmentUrl(config.publicUrl);
  if (runtime.images.limits.currency !== config.limits.currency)
    throw new Error('Runtime image limits and provider currency must agree.');
  const token = await readPrivateFile(config.providerTokenFile);
  const request = createHetznerRequest({
    token,
    ...(input.transport ? { transport: input.transport } : {}),
  });
  const access = createImageAccessStore({ directory: runtime.images.accessDirectory });
  // Load signing material only when needed. Cancelled/expired jobs must still clean up after key loss.
  const provider: HetznerImageProvider = new HetznerImageProvider({
    token,
    ...(input.transport ? { transport: input.transport } : {}),
    renderBoot: async (context) => {
      const loaded = await authorizeBuild(
        await inspectImageBuild(connection.db, context.command.labels.build_id),
      );
      return createImageRenderer(connection.db, access, loaded.identity.seal)(context);
    },
  });
  const remote = createImageBuilder();
  const probe = createGuestProbe();
  // Keep credential caches within the running process; they avoid spending signing budgets on polling.
  let ports: Promise<Awaited<ReturnType<typeof loadPorts>>> | undefined;
  async function loadPorts() {
    const [identity, signer] = await Promise.all([
      readRuntimeIdentity(runtime.identityDirectory),
      readRuntimeSigner(runtime.pki),
    ]);
    return {
      identity,
      signer,
      enrollment: createImageVerifierEnrollment({
        connection,
        provider,
        seal: identity.seal,
        signer,
        probe,
      }),
      verifier: createImageVerifierRuntime({ connection, provider, signer, probe }),
    };
  }
  function getPorts() {
    ports ??= loadPorts().catch((error: unknown) => {
      ports = undefined;
      throw error;
    });
    return ports;
  }

  async function authorizeBuild(build: ImageBuild) {
    const loaded = await getPorts();
    const keys = await loaded.identity.publication.readKeys();
    const keyId = imageReleaseKeyId(loaded.identity.publication.privateKey);
    const now = (await databaseTime(connection.db)).getTime();
    const trusted = keys.some(
      (key) =>
        key.kind === 'trusted' &&
        imageReleaseKeyId(createPublicKey(key.publicKey)) === keyId &&
        Date.parse(key.signedFrom) <= now &&
        now < Date.parse(key.signedUntil),
    );
    if (!trusted || keys.some((key) => key.kind === 'revoked' && key.keyId === keyId))
      throw new CloudError('permission_denied', 'The active image signing key is not authorized.');
    if (!isDeepStrictEqual(build.admission.source.manifest.trust, loaded.signer.trust))
      throw new CloudError(
        'permission_denied',
        'Image input trust differs from the configured CA.',
      );
    return loaded;
  }
  async function advance(buildId: ImageBuildId) {
    const build = await inspectImageBuild(connection.db, buildId);
    const now = (await databaseTime(connection.db)).getTime();
    const expired =
      build.state.kind === 'retained' && build.admission.retention.kind === 'retain'
        ? Date.parse(build.admission.retention.deleteAfter) <= now
        : build.state.kind !== 'retained' && Date.parse(build.admission.deadlineAt) <= now;
    if (expired && build.state.kind !== 'cleaning' && build.state.kind !== 'cleaned')
      await requestImageCleanup(connection.db, buildId, 'expired');
    if (expired || build.state.kind === 'cleaning' || build.state.kind === 'cleaned')
      return cleanupImageBuild({ connection, buildId, provider, access });
    if (build.state.kind === 'running' && !build.runRequestedAt) return { kind: 'waiting' };
    if (build.state.kind === 'retained')
      return readPublishedImage({
        connection,
        buildId,
        provider,
        readKeys: createImageReleaseKeySource(runtime.identityDirectory),
      });
    let loaded;
    try {
      loaded = await authorizeBuild(build);
      if (build.state.kind === 'running' && build.effects.length === 0) {
        try {
          await verifyImageInputs(
            join(runtime.images.inputsDirectory, build.admission.source.manifestDigest),
            build.admission.source.manifestDigest,
          );
          await access.recover(build.admission);
        } catch {
          throw new CloudError(
            'permission_denied',
            'Admitted image inputs are unavailable or changed.',
          );
        }
      }
    } catch (error) {
      if (!(error instanceof CloudError) || error.failure.retryable) throw error;
      await requestImageCleanup(connection.db, buildId, 'failed');
      return cleanupImageBuild({ connection, buildId, provider, access });
    }
    return advanceImageBuild({
      connection,
      buildId,
      provider,
      access,
      remote,
      sourceDirectory: join(runtime.images.inputsDirectory, build.admission.source.manifestDigest),
      limits: runtime.images.limits,
      pricing: async () => {
        const [catalog, storagePrice] = await Promise.all([
          readHetznerCatalog({ request, configuration: config.offers }),
          readHetznerImagePrice(request),
        ]);
        return { catalog, storagePrice };
      },
      publication: loaded.identity.publication,
      verification: { seal: loaded.identity.seal, enrollmentUrl, runtime: loaded.verifier },
    });
  }
  return {
    provider,
    advance,
    enrollment: {
      enroll: async (
        value: Parameters<ReturnType<typeof createImageVerifierEnrollment>['enroll']>[0],
      ) => (await getPorts()).enrollment.enroll(value),
    },
    checkConfiguration: async () => {
      await (await getPorts()).identity.publication.readKeys();
    },
  };
}

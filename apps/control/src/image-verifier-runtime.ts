import { isDeepStrictEqual } from 'node:util';
import { eq } from 'drizzle-orm';
import {
  CloudError,
  imageVerifierRuntimeSchema,
  imageVerificationResultSchema,
  type ImageBuildId,
  type ImageProvider,
  type ImageVerificationResult,
} from '@agent-cloud/contracts';
import {
  imageVerifierResults,
  databaseTime,
  imageVerifierIdentities,
  withImageBuildLock,
  type Connection,
} from '@agent-cloud/db';
import type { Signer, ProbeCredential } from '@agent-cloud/pki';
import type { createGuestProbe } from '@agent-cloud/remote';
import { inspectImageBuild } from './image-builds.js';
import { observeImageVerifier } from './image-verifier.js';
import { requireActiveImageBuild, reserveImageVerifierSigning } from './image-verifier-records.js';

type RuntimeResult = { kind: 'waiting' } | { kind: 'verified'; result: ImageVerificationResult };

export function createImageVerifierRuntime(ports: {
  connection: Connection;
  provider: ImageProvider;
  signer: Pick<Signer, 'issueRuntimeCredential'>;
  probe: Pick<ReturnType<typeof createGuestProbe>, 'readRuntime'>;
}) {
  const credentials = new Map<ImageBuildId, ProbeCredential<'runtime'>>();
  return {
    async check(buildId: ImageBuildId) {
      return withImageBuildLock({
        pool: ports.connection.pool,
        buildId,
        work: async (db): Promise<RuntimeResult> => {
          const build = await inspectImageBuild(db, buildId);
          if (build.verification.kind === 'verified')
            return { kind: 'verified', result: build.verification.result };
          await db.transaction((tx) => requireActiveImageBuild(tx, buildId));
          const verification = build.verification;
          if (verification.kind !== 'enrolled') return { kind: 'waiting' };
          if (
            build.builderWork.kind !== 'recorded' ||
            build.builderWork.progress.kind !== 'sanitized'
          )
            throw new CloudError(
              'permission_denied',
              'Image verifier has no sanitized builder evidence.',
            );
          const observed = await observeImageVerifier(build, ports.provider);
          const [claim] = await db
            .select()
            .from(imageVerifierIdentities)
            .where(eq(imageVerifierIdentities.buildId, buildId));
          if (
            !claim ||
            claim.serverId !== observed.server.id ||
            claim.effectId !== observed.effectId ||
            observed.snapshotId !== verification.spec.image.providerImage
          )
            throw new CloudError(
              'permission_denied',
              'Image verifier runtime ownership differs from enrollment.',
            );
          const credentialTime = (await databaseTime(db)).getTime();
          for (const [id, credential] of credentials)
            if (Date.parse(credential.expiresAt) <= credentialTime + 35_000) credentials.delete(id);
          let credential = credentials.get(buildId);
          if (!credential) {
            if (credentials.size >= 1024) return { kind: 'waiting' };
            await reserveImageVerifierSigning(db, buildId, 'runtime');
            credential = await ports.signer.issueRuntimeCredential(verification.spec.subject);
            credentials.set(buildId, credential);
          }
          const runtime = imageVerifierRuntimeSchema.parse(
            await ports.probe.readRuntime({
              subject: verification.spec.subject,
              address: observed.address,
              credential,
              trust: { kind: 'host_ca', publicKey: verification.spec.image.sshHostCa },
            }),
          );
          const { proof, checks, manifest } = runtime;
          if (
            proof.subject.id !== buildId ||
            proof.sshHostPublicKey !== verification.identity.sshHostPublicKey ||
            proof.tlsCsr !== verification.identity.tlsCsr ||
            proof.imageVersion !== verification.spec.image.version ||
            proof.manifestDigest !== verification.spec.image.manifestDigest ||
            !isDeepStrictEqual(manifest, build.admission.source.manifest) ||
            runtime.architecture !== manifest.architecture ||
            runtime.machineId === build.builderWork.progress.installation.machineId
          )
            throw new CloudError(
              'permission_denied',
              'Image verifier runtime identity or installed image differs from its admission.',
            );
          for (const name of ['node', 'docker', 'compose', 'caddy', 'step'] satisfies Array<
            'node' | 'docker' | 'compose' | 'caddy' | 'step'
          >) {
            const check = checks[name];
            if (check.kind !== 'ok' || check.version !== manifest.components[name])
              return { kind: 'waiting' };
          }
          if (
            checks.disk.kind !== 'ok' ||
            checks.disk.availableBytes < 1024 ** 3 ||
            checks.disk.availableBytes > checks.disk.totalBytes ||
            checks.proxy.kind !== 'ok' ||
            checks.proxy.subject.id !== buildId ||
            checks.proxy.imageVersion !== manifest.version
          )
            return { kind: 'waiting' };
          const result = imageVerificationResultSchema.parse({
            serverId: observed.server.id,
            effectId: observed.effectId,
            snapshotId: observed.snapshotId,
            runtime,
            verifiedAt: new Date().toISOString(),
          });
          await db.transaction(async (tx) => {
            await requireActiveImageBuild(tx, buildId);
            await tx.insert(imageVerifierResults).values({ buildId, result });
          });
          credentials.delete(buildId);
          return { kind: 'verified', result };
        },
      });
    },
  };
}

import { createInternalReference } from './internal-reference.js';
import { isDeepStrictEqual } from 'node:util';
import { CloudError, accessServiceConfigSchema, type GuestImage } from '@agent-cloud/contracts';
import type { Connection } from '@agent-cloud/db';
import {
  createHetznerRequest,
  HetznerProvider,
  HetznerImageProvider,
  checkCustomerFirewalls,
} from '@agent-cloud/hetzner';
import { createGuestProbe } from '@agent-cloud/remote';
import { createAllocationImageResolver, requireCustomerImage } from './allocation-image.js';
import { readPublishedImage } from './image-publication.js';
import { createGuestRenderer } from './guest-renderer.js';
import { createEnrollmentService } from './guest-enrollment.js';
import { createGuestRenewalService } from './guest-renewal.js';
import { createGuestReadiness } from './guest-readiness.js';
import { prepareGuestBootstrap } from './guest-bootstrap.js';
import { createImageReleaseKeySource, readBootstrapIdentity } from './runtime-identity.js';
import { readRuntimeSigner, readRuntimeCustomerSigner } from './runtime-pki.js';
import { createAccessService } from './access-sessions.js';
import { readPrivateFile } from './private-file.js';
import { guestEnrollmentUrl, type CustomerRuntimeConfig } from './runtime-config.js';
import type { Config } from './config.js';
import type { GuestProvisioning } from './advance-operation.js';

/** All provider mutations still pass through the existing allocation effect journal. */
export async function createCustomerRuntime(input: {
  connection: Connection;
  config: Extract<Config, { provider: 'hetzner' }>;
  runtime: CustomerRuntimeConfig;
  transport?: typeof fetch;
}) {
  const { connection, config, runtime } = input;
  const enrollmentUrl = guestEnrollmentUrl(config.publicUrl);
  const token = await readPrivateFile(config.providerTokenFile);
  const transport = { token, ...(input.transport ? { transport: input.transport } : {}) };
  const request = createHetznerRequest(transport);
  const accessConfig = config.accessConfigFile
    ? accessServiceConfigSchema.parse(JSON.parse(await readPrivateFile(config.accessConfigFile)))
    : undefined;
  const checkNetwork = () =>
    checkCustomerFirewalls(
      request,
      runtime.firewallIds,
      Boolean(config.internalReferenceGrant),
      accessConfig?.gateway.egressCidrs,
    );
  const readKeys = createImageReleaseKeySource(runtime.identityDirectory);
  const images = new HetznerImageProvider({
    ...transport,
    renderBoot: () => {
      throw new CloudError('permission_denied', 'Customer processes cannot build images.');
    },
  });
  const resolvePinnedImage = createAllocationImageResolver({
    connection,
    provider: images,
    readKeys,
  });
  const provider = new HetznerProvider({
    ...transport,
    offers: config.offers,
    access: { firewallIds: runtime.firewallIds },
    renderGuest: async (context) => {
      const { seal } = await getIdentity();
      return createGuestRenderer(connection.db, seal, resolveImage)(context);
    },
  });
  // Private material is lazy so exact-resource reconciliation and destruction survive its loss.
  let identity: ReturnType<typeof readBootstrapIdentity> | undefined;
  function getIdentity() {
    identity ??= readBootstrapIdentity(runtime.identityDirectory).catch((error: unknown) => {
      identity = undefined;
      throw error;
    });
    return identity;
  }
  const probe = createGuestProbe();
  let services: Promise<Awaited<ReturnType<typeof loadServices>>> | undefined;
  async function loadServices() {
    const signer = await readRuntimeSigner(runtime.pki);
    return {
      signer,
      renewal: createGuestRenewalService({ connection, signer, probe, provider }),
      readiness: createGuestReadiness({ signer, probe, provider }),
    };
  }
  function getServices() {
    services ??= loadServices().catch((error: unknown) => {
      services = undefined;
      throw error;
    });
    return services;
  }
  let enrollment: Promise<ReturnType<typeof createEnrollmentService>> | undefined;
  function getEnrollment() {
    enrollment ??= Promise.all([getIdentity(), getServices()])
      .then(([{ seal }, { signer }]) =>
        createEnrollmentService({ connection, seal, signer, probe, provider }),
      )
      .catch((error: unknown) => {
        enrollment = undefined;
        throw error;
      });
    return enrollment;
  }
  async function requireSignerTrust(image: GuestImage) {
    const { signer } = await getServices();
    if (
      !isDeepStrictEqual(
        { sshHostCa: image.sshHostCa, sshUserCa: image.sshUserCa, tlsRoot: image.tlsRoot },
        signer.trust,
      )
    )
      throw new CloudError(
        'permission_denied',
        'The admitted image trust differs from the configured CA.',
      );
  }
  async function resolveImage(allocation: Parameters<typeof resolvePinnedImage>[0]) {
    const image = await resolvePinnedImage(allocation);
    await Promise.all([requireSignerTrust(image), getIdentity()]);
    await checkNetwork();
    return image;
  }
  const guest: GuestProvisioning = {
    kind: 'enabled',
    resolveImage,
    prepareBootstrap: async (tx, context) =>
      prepareGuestBootstrap(tx, {
        ...context,
        seal: (await getIdentity()).seal,
        enrollmentUrl,
      }),
    runtime: { check: async (context) => (await getServices()).readiness.check(context) },
  };
  return {
    provider,
    guest,
    ...(accessConfig
      ? {
          access: createAccessService({
            connection,
            provider,
            config: accessConfig,
            signer: () => readRuntimeCustomerSigner(runtime.pki),
            checkNetwork,
          }),
        }
      : {}),
    ...(config.internalReferenceGrant
      ? {
          internalReference: createInternalReference({
            connection,
            provider,
            grantId: config.internalReferenceGrant,
            signer: async () => (await getServices()).signer,
          }),
        }
      : {}),
    imageRelease: { buildId: runtime.releaseBuildId, readKeys },
    enrollment: {
      enroll: async (value: Parameters<ReturnType<typeof createEnrollmentService>['enroll']>[0]) =>
        (await getEnrollment()).enroll(value),
    },
    renewal: {
      renew: async (value: Parameters<ReturnType<typeof createGuestRenewalService>['renew']>[0]) =>
        (await getServices()).renewal.renew(value),
    },
    checkConfiguration: async () => {
      await Promise.all([getIdentity(), getServices()]);
      await checkNetwork();
      const selected = await readPublishedImage({
        connection,
        provider: images,
        buildId: runtime.releaseBuildId,
        readKeys,
      });
      if (selected.kind === 'busy')
        throw new CloudError('provider_unavailable', 'Configured image release is busy.', true);
      requireCustomerImage(selected.value.release);
      await requireSignerTrust(selected.value.image);
    },
  };
}

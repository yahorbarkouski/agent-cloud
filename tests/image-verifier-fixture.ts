import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { vi } from 'vitest';
import {
  imageVerifierEnrollmentInputSchema,
  imageVerifierProofSchema,
  imageVerifierRuntimeSchema,
  simulatedCatalog,
  type ImageInstallation,
} from '../packages/contracts/dist/index.js';
import type { Connection } from '../packages/db/dist/index.js';
import type { Signer } from '../packages/pki/dist/index.js';
import type { createImageBuilder, createGuestProbe } from '../packages/remote/dist/index.js';
import { createImageAccessStore } from '../apps/control/dist/image-access.js';
import { admitImageBuild, inspectImageBuild } from '../apps/control/dist/image-builds.js';
import { advanceImageBuild } from '../apps/control/dist/advance-image-build.js';
import { recoverImageVerifierBootstrap } from '../apps/control/dist/image-verifier.js';
import { createImageVerifierEnrollment } from '../apps/control/dist/image-verifier-enrollment.js';
import { createImageVerifierRuntime } from '../apps/control/dist/image-verifier-runtime.js';
import { BootstrapSeal } from '../apps/control/dist/bootstrap-seal.js';
import { createApp } from '../apps/control/dist/app.js';
import { imageBuildFixture, imagePricing, ImageProviderFixture } from './image-build-fixture.js';
type Remote = ReturnType<typeof createImageBuilder>;
type Probe = ReturnType<typeof createGuestProbe>;
export async function imageVerifierScenario(
  connection: Connection,
  directory: string,
  retain = false,
  durationMs = 90 * 60_000,
) {
  const sourceDirectory = join(directory, 'inputs');
  const fixture = await imageBuildFixture(sourceDirectory);
  const { admission } = fixture;
  admission.deadlineAt = new Date(Date.parse(admission.admittedAt) + durationMs).toISOString();
  if (retain)
    admission.retention = {
      kind: 'retain',
      deleteAfter: new Date(Date.now() + 86_400_000).toISOString(),
    };
  const buildId = admission.id;
  const access = createImageAccessStore({ directory: join(directory, 'keys') });
  admission.access = await access.prepare({
    buildId,
    manifestDigest: admission.source.manifestDigest,
    managementAddress: admission.access.managementAddress,
  });
  await admitImageBuild({ ...fixture, db: connection.db, sourceDirectory });
  let installation: ImageInstallation = { kind: 'not_started' };
  const installed: ImageInstallation = {
    kind: 'installed',
    receipt: {
      kind: 'builder',
      builderId: buildId,
      manifestDigest: admission.source.manifestDigest,
      machineId: 'a'.repeat(32),
    },
  };
  const remote = {
    inspect: vi.fn<Remote['inspect']>(() => Promise.resolve(installation)),
    upload: vi.fn<Remote['upload']>((input) =>
      Promise.resolve({
        kind: 'uploaded',
        manifestDigest: input.boot.manifestDigest,
        checksumDigest: input.checksumDigest,
      }),
    ),
    install: vi.fn<Remote['install']>(() => {
      installation = installed;
      return Promise.resolve(installed);
    }),
    sanitize: vi.fn<Remote['sanitize']>(() =>
      Promise.resolve({
        kind: 'sanitized',
        builderId: buildId,
        manifestDigest: admission.source.manifestDigest,
      }),
    ),
  };
  const provider = new ImageProviderFixture();
  const seal = new BootstrapSeal(randomBytes(32).toString('base64'));
  const enrollmentUrl = 'https://enrollment.example.test/image/enroll';
  const signer = {
    trust: admission.source.manifest.trust,
    validateTlsRequest: vi.fn<Signer['validateTlsRequest']>().mockResolvedValue(),
    issueProbeCredential: vi.fn<Signer['issueProbeCredential']>((subject) =>
      Promise.resolve({
        kind: 'probe',
        subject,
        privateKey: 'fixture-private',
        certificate: 'fixture-probe',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      }),
    ),
    issueRuntimeCredential: vi.fn<Signer['issueRuntimeCredential']>((subject) =>
      Promise.resolve({
        kind: 'runtime',
        subject,
        privateKey: 'fixture-private',
        certificate: 'fixture-runtime',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      }),
    ),
    signHost: vi.fn<Signer['signHost']>().mockResolvedValue('fixture-host-certificate'),
    signTls: vi.fn<Signer['signTls']>().mockResolvedValue('fixture-tls-certificate'),
  };
  const probe = {
    readIdentity: vi.fn<Probe['readIdentity']>(),
    readRuntime: vi.fn<Probe['readRuntime']>(),
  };
  const ports = { connection: connection, provider, seal, signer, probe };
  const runtimeService = createImageVerifierRuntime(ports);
  const input = {
    ...ports,
    buildId,
    access,
    remote,
    sourceDirectory,
    limits: fixture.limits,
    pricing: () => Promise.resolve(imagePricing()),
    verification: { seal, enrollmentUrl, runtime: runtimeService },
  };
  for (let pass = 0; pass < 11; pass++) await advanceImageBuild(input);
  const bootstrap = await recoverImageVerifierBootstrap(connection.db, { buildId, seal });
  const proposal = imageVerifierEnrollmentInputSchema.parse({
    bootstrap: { version: 2, subject: bootstrap.spec.subject },
    token: bootstrap.token,
    imageVersion: bootstrap.spec.image.version,
    sshHostPublicKey: 'ssh-ed25519 CCCC',
    tlsCsr: 'fixture-csr',
  });
  const proof = imageVerifierProofSchema.parse({
    version: 2,
    subject: bootstrap.spec.subject,
    imageVersion: proposal.imageVersion,
    sshHostPublicKey: proposal.sshHostPublicKey,
    tlsCsr: proposal.tlsCsr,
    manifestDigest: bootstrap.spec.image.manifestDigest,
  });
  probe.readIdentity.mockResolvedValue(proof);
  const manifest = admission.source.manifest;
  const runtime = imageVerifierRuntimeSchema.parse({
    version: 2,
    proof,
    manifest,
    architecture: manifest.architecture,
    machineId: 'b'.repeat(32),
    bootId: randomUUID(),
    checks: {
      node: { kind: 'ok', version: manifest.components.node },
      docker: { kind: 'ok', version: manifest.components.docker },
      compose: { kind: 'ok', version: manifest.components.compose },
      caddy: { kind: 'ok', version: manifest.components.caddy },
      step: { kind: 'ok', version: manifest.components.step },
      disk: { kind: 'ok', availableBytes: 2 * 1024 ** 3, totalBytes: 40 * 1024 ** 3 },
      proxy: { kind: 'ok', subject: bootstrap.spec.subject, imageVersion: manifest.version },
    },
  });
  probe.readRuntime.mockResolvedValue(runtime);
  const service = createImageVerifierEnrollment(ports);
  const app = createApp({
    db: connection.db,
    provider: 'simulated',
    catalog: simulatedCatalog,
    limits: { currency: 'EUR', maxMachines: 1, maxHourlyMicros: 1000 },
    imageEnrollment: service,
  });
  const request = (body: unknown = proposal) =>
    app.request('/image/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return {
    ...fixture,
    ...input,
    ports,
    bootstrap,
    proposal,
    proof,
    runtime,
    service,
    request,
    runtimeService,
    enrollmentUrl,
    inspection: () => inspectImageBuild(connection.db, buildId),
    advance: () => advanceImageBuild(input),
  };
}

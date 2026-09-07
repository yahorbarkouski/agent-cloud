import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  CloudError,
  imageVerifierEnrollmentInputSchema,
  imageVerifierProofSchema,
  imageVerifierRuntimeSchema,
  simulatedCatalog,
  type ImageInstallation,
} from '../packages/contracts/dist/index.js';
import {
  connect,
  imageVerifierBootstraps,
  imageVerifierIdentities,
  imageVerifierSigningAttempts,
  imageVerifierResults,
  allocations,
} from '../packages/db/dist/index.js';
import type { Signer } from '../packages/pki/dist/index.js';
import type { createImageBuilder, createGuestProbe } from '../packages/remote/dist/index.js';
import { createImageAccessStore } from '../apps/control/dist/image-access.js';
import {
  admitImageBuild,
  inspectImageBuild,
  requestImageCleanup,
} from '../apps/control/dist/image-builds.js';
import { advanceImageBuild } from '../apps/control/dist/advance-image-build.js';
import {
  prepareImageVerification,
  recoverImageVerifierBootstrap,
} from '../apps/control/dist/image-verifier.js';
import { createImageVerifierEnrollment } from '../apps/control/dist/image-verifier-enrollment.js';
import { createImageVerifierRuntime } from '../apps/control/dist/image-verifier-runtime.js';
import { createImageRenderer } from '../apps/control/dist/image-renderer.js';
import { BootstrapSeal } from '../apps/control/dist/bootstrap-seal.js';
import { createApp } from '../apps/control/dist/app.js';
import { imageBuildFixture, imagePricing, ImageProviderFixture } from './image-build-fixture.js';
import { testDatabase } from './database.js';

type Remote = ReturnType<typeof createImageBuilder>;
type Probe = ReturnType<typeof createGuestProbe>;
let database: Awaited<ReturnType<typeof testDatabase>>;
let directory: string;
beforeAll(async () => {
  database = await testDatabase();
});
afterAll(async () => {
  await database.close();
});
beforeEach(async () => {
  await database.reset();
  directory = await mkdtemp(join(tmpdir(), 'agent-cloud-verifier-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function scenario() {
  const sourceDirectory = join(directory, 'inputs');
  const fixture = await imageBuildFixture(sourceDirectory);
  const { admission } = fixture;
  const buildId = admission.id;
  const access = createImageAccessStore({ directory: join(directory, 'keys') });
  admission.access = await access.prepare({
    buildId,
    manifestDigest: admission.source.manifestDigest,
    managementAddress: admission.access.managementAddress,
  });
  await admitImageBuild({ ...fixture, db: database.connection.db, sourceDirectory });
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
  const ports = { connection: database.connection, provider, seal, signer, probe };
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
  const bootstrap = await recoverImageVerifierBootstrap(database.connection.db, { buildId, seal });
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
    db: database.connection.db,
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
    inspection: () => inspectImageBuild(database.connection.db, buildId),
    advance: () => advanceImageBuild(input),
  };
}

it('verifies a build-owned snapshot boot, replays across connections, and cleans every resource without customer allocations', async () => {
  const f = await scenario();
  expect(await f.advance()).toMatchObject({
    kind: 'verifier',
    result: { value: { kind: 'waiting' } },
  });
  const response = await f.request();
  expect(response.status).toBe(200);
  const issued: unknown = await response.json();
  const restarted = connect(database.databaseUrl);
  try {
    expect(
      await createImageVerifierEnrollment({ ...f.ports, connection: restarted }).enroll(f.proposal),
    ).toEqual(issued);
  } finally {
    await restarted.pool.end();
  }
  expect(f.signer.signHost).toHaveBeenCalledOnce();
  expect(
    (await database.connection.db.select().from(imageVerifierBootstraps))[0]?.sealedToken,
  ).toBeNull();
  expect(await f.advance()).toMatchObject({
    kind: 'verifier',
    result: { value: { kind: 'verified' } },
  });
  expect(await f.advance()).toEqual({ kind: 'verified' });
  const build = await f.inspection();
  expect(build.verification).toMatchObject({
    kind: 'verified',
    result: { runtime: { machineId: 'b'.repeat(32) } },
  });
  expect(JSON.stringify(build)).not.toContain(f.bootstrap.token);
  expect(await database.connection.db.select().from(allocations)).toEqual([]);
  await requestImageCleanup(database.connection.db, f.buildId);
  for (let pass = 0; pass < 16; pass++) {
    if ((await f.advance()).kind === 'cleaned') break;
  }
  expect((await f.inspection()).state.kind).toBe('cleaned');
  expect(f.provider.resources.size).toBe(0);
  expect(await readdir(join(directory, 'keys'))).toEqual([]);
});

it('preserves the first encrypted intent and refuses changed endpoints, owner references and unauthenticated proposals', async () => {
  const f = await scenario();
  expect(await prepareImageVerification(f)).toMatchObject({
    value: { subject: f.bootstrap.spec.subject },
  });
  expect(await recoverImageVerifierBootstrap(database.connection.db, f)).toEqual(f.bootstrap);
  await expect(
    prepareImageVerification({ ...f, enrollmentUrl: 'https://other.example.test/image/enroll' }),
  ).rejects.toThrow('different intent');
  expect(
    (await f.request({ ...f.proposal, token: randomBytes(32).toString('base64url') })).status,
  ).toBe(401);
  expect(
    (
      await f.request({
        ...f.proposal,
        bootstrap: { version: 2, subject: { kind: 'image_verifier', id: randomUUID() } },
      })
    ).status,
  ).toBe(401);
  expect((await f.request({ ...f.proposal, address: '127.0.0.1' })).status).toBe(400);
  expect(f.signer.issueProbeCredential).not.toHaveBeenCalled();
});

it.each(['server_labels', 'source_image', 'ip_assignment', 'snapshot_source', 'wrong_proof'])(
  'refuses %s before claiming or signing host keys',
  async (change) => {
    const f = await scenario();
    const resource = [...f.provider.resources.values()].find(
      (item) => item.kind === 'server' && item.labels.role === 'verifier',
    );
    const snapshot = [...f.provider.resources.values()].find((item) => item.kind === 'snapshot');
    const ip = [...f.provider.resources.values()].find(
      (item) => item.kind === 'primary_ip' && item.labels.role === 'verifier_ip',
    );
    if (resource?.kind !== 'server' || snapshot?.kind !== 'snapshot' || ip?.kind !== 'primary_ip')
      throw new Error('Missing fixture resources.');
    if (change === 'server_labels')
      f.provider.add({ ...resource, labels: { ...resource.labels, effect_id: randomUUID() } });
    if (change === 'source_image') f.provider.add({ ...resource, imageId: '9999' });
    if (change === 'ip_assignment') f.provider.add({ ...ip, serverId: '9999' });
    if (change === 'snapshot_source') f.provider.add({ ...snapshot, sourceServerId: resource.id });
    if (change === 'wrong_proof')
      f.probe.readIdentity.mockResolvedValueOnce({ ...f.proof, tlsCsr: 'wrong-csr' });
    expect((await f.request()).status).toBe(change === 'wrong_proof' ? 403 : 409);
    expect(f.signer.signHost).not.toHaveBeenCalled();
    expect(await database.connection.db.select().from(imageVerifierIdentities)).toEqual([]);
  },
);

it('serializes enrollment and preserves claims, spent signing attempts and cooldown after lost issuance', async () => {
  const f = await scenario();
  const started = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<typeof f.proof>();
  f.probe.readIdentity.mockImplementationOnce(() => {
    started.resolve(undefined);
    return release.promise;
  });
  const first = f.request();
  await started.promise;
  expect((await f.request()).status).toBe(409);
  f.signer.signTls.mockRejectedValueOnce(
    new CloudError('provider_unavailable', 'Lost response.', true),
  );
  release.resolve(f.proof);
  expect((await first).status).toBe(503);
  expect((await f.request({ ...f.proposal, tlsCsr: 'replacement-csr' })).status).toBe(403);
  await expect(createImageVerifierEnrollment(f.ports).enroll(f.proposal)).rejects.toThrow(
    '30 seconds',
  );
  const history = await database.connection.db.select().from(imageVerifierSigningAttempts);
  expect(history.map((row) => row.purpose).sort()).toEqual(['identity', 'probe']);
  expect(
    (await database.connection.db.select().from(imageVerifierIdentities))[0]?.identity,
  ).toMatchObject({ kind: 'claimed' });
  expect(
    (await database.connection.db.select().from(imageVerifierBootstraps))[0]?.sealedToken,
  ).not.toBeNull();
  await expect(database.connection.db.delete(imageVerifierSigningAttempts)).rejects.toThrow();
  await expect(
    database.connection.db.update(imageVerifierSigningAttempts).set({ sequence: 1 }),
  ).rejects.toThrow();
  await expect(
    database.connection.db
      .insert(imageVerifierSigningAttempts)
      .values({ buildId: f.buildId, purpose: 'probe', sequence: 13 }),
  ).rejects.toThrow();
});

it('honors cancellation during signing without persisting issued credentials or completing verification', async () => {
  const f = await scenario();
  f.signer.signTls.mockImplementationOnce(async () => {
    await requestImageCleanup(database.connection.db, f.buildId);
    return 'fixture-cert';
  });
  expect((await f.request()).status).toBe(403);
  expect(
    (await database.connection.db.select().from(imageVerifierIdentities))[0]?.identity,
  ).toMatchObject({ kind: 'claimed' });
  expect(
    (await database.connection.db.select().from(imageVerifierBootstraps))[0]?.sealedToken,
  ).not.toBeNull();
  await expect(f.runtimeService.check(f.buildId)).rejects.toThrow('no longer active');
});

it('waits for failed services and refuses inherited machine identity before accepting a healthy runtime', async () => {
  const f = await scenario();
  await f.service.enroll(f.proposal);
  f.probe.readRuntime.mockResolvedValueOnce({
    ...f.runtime,
    checks: { ...f.runtime.checks, docker: { kind: 'unavailable' } },
  });
  expect(await f.runtimeService.check(f.buildId)).toMatchObject({ value: { kind: 'waiting' } });
  f.probe.readRuntime.mockResolvedValueOnce({ ...f.runtime, machineId: 'a'.repeat(32) });
  await expect(f.runtimeService.check(f.buildId)).rejects.toThrow('runtime identity');
  expect(await database.connection.db.select().from(imageVerifierResults)).toEqual([]);
  expect(await f.runtimeService.check(f.buildId)).toMatchObject({ value: { kind: 'verified' } });
  expect(f.signer.issueRuntimeCredential).toHaveBeenCalledOnce();
  await expect(database.connection.db.delete(imageVerifierResults)).rejects.toThrow();
  await expect(
    database.connection.db.update(imageVerifierResults).set({ result: { kind: 'fake' } }),
  ).rejects.toThrow();
});

it('keeps bootstrap and key bindings immutable in SQL and refuses late boot rendering', async () => {
  const f = await scenario();
  await expect(
    database.connection.db.update(imageVerifierBootstraps).set({ snapshotId: '9999' }),
  ).rejects.toThrow();
  await expect(
    database.connection.db
      .update(imageVerifierBootstraps)
      .set({ sealedToken: null, consumedAt: new Date() }),
  ).rejects.toThrow();
  await f.service.enroll(f.proposal);
  await expect(
    database.connection.db.update(imageVerifierIdentities).set({ serverId: '9999' }),
  ).rejects.toThrow();
  await expect(database.connection.db.delete(imageVerifierIdentities)).rejects.toThrow();
  await expect(recoverImageVerifierBootstrap(database.connection.db, f)).rejects.toThrow(
    'consumed',
  );
  const effect = (await f.inspection()).effects.find((e) => e.key === 'create:verifier');
  if (!effect || effect.command.kind !== 'create_server')
    throw new Error('Missing verifier effect.');
  await expect(
    createImageRenderer(
      database.connection.db,
      f.access,
      f.seal,
    )({ effectId: effect.id, command: effect.command }),
  ).rejects.toThrow('prepared effect');
});

it('does not save runtime completion when cancellation arrives during the SSH read', async () => {
  const f = await scenario();
  await f.service.enroll(f.proposal);
  f.probe.readRuntime.mockImplementationOnce(async () => {
    await requestImageCleanup(database.connection.db, f.buildId);
    return f.runtime;
  });
  await expect(f.runtimeService.check(f.buildId)).rejects.toThrow('no longer active');
  expect(await database.connection.db.select().from(imageVerifierResults)).toEqual([]);
  expect((await f.inspection()).state.kind).toBe('cleaning');
});

it('refuses expiry during enrollment before consuming bootstrap or issuing a runtime identity', async () => {
  const f = await scenario();
  f.signer.signTls.mockImplementationOnce(() => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.bootstrap.spec.expiresAt));
    return Promise.resolve('fixture-certificate');
  });
  expect((await f.request()).status).toBe(401);
  expect(
    (await database.connection.db.select().from(imageVerifierIdentities))[0]?.identity,
  ).toMatchObject({ kind: 'claimed' });
  expect(
    (await database.connection.db.select().from(imageVerifierBootstraps))[0]?.sealedToken,
  ).not.toBeNull();
});

it('SQL rejects malformed completion evidence that would prevent inspection and cleanup', async () => {
  const f = await scenario();
  await f.service.enroll(f.proposal);
  const build = await f.inspection();
  const verifier = build.resources.find((resource) => resource.role === 'verifier');
  if (!verifier) throw new Error('Expected owned verifier.');
  const insert = (runtime: unknown) =>
    database.connection.db.insert(imageVerifierResults).values({
      buildId: f.buildId,
      result: {
        serverId: verifier.ref.id,
        effectId: verifier.effectId,
        snapshotId: f.bootstrap.spec.image.providerImage,
        runtime,
        verifiedAt: new Date().toISOString(),
      },
    });
  for (const runtime of [
    { ...f.runtime, extra: true },
    { ...f.runtime, bootId: '11111111-1111-9111-1111-111111111111' },
    { ...f.runtime, machineId: null },
    {
      ...f.runtime,
      checks: {
        ...f.runtime.checks,
        disk: { kind: 'ok', availableBytes: 1024 ** 3 + 0.5, totalBytes: 40 * 1024 ** 3 },
      },
    },
    {
      ...f.runtime,
      checks: { ...f.runtime.checks, proxy: { ...f.runtime.checks.proxy, extra: true } },
    },
  ])
    await expect(insert(runtime)).rejects.toThrow();
  expect((await f.inspection()).verification.kind).toBe('enrolled');
  expect(await f.runtimeService.check(f.buildId)).toMatchObject({ value: { kind: 'verified' } });
});

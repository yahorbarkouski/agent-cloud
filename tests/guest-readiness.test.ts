import { createHash, randomUUID } from 'node:crypto';
import { eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  guestImageSchema,
  guestManifestSchema,
  guestRuntimeSchema,
  operationResponseSchema,
  newId,
  type GuestRuntime,
  type OperationId,
} from '../packages/contracts/dist/index.js';
import {
  allocations,
  auditEvents,
  guestIdentities,
  machines,
  operations,
  runtimeSigningAttempts,
  machineRecord,
} from '../packages/db/src/index.js';
import type { Signer } from '../packages/pki/dist/index.js';
import { advanceOperation } from '../apps/control/src/advance-operation.js';
import { createGuestReadiness } from '../apps/control/src/guest-readiness.js';
import { createApp } from '../apps/control/src/app.js';
import { prepareEnrollmentFixture } from '../scripts/support/enrollment-fixture.js';
import { seedAccount, testDatabase } from './database.js';

let database: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  database = await testDatabase();
});
afterAll(async () => {
  await database.close();
});
beforeEach(async () => {
  await database.reset();
});

async function scenario() {
  const db = database.connection.db;
  const manifest = guestManifestSchema.parse({
    format: 2,
    publicInputsDigest: 'd'.repeat(64),
    version: 'runtime-fixture',
    architecture: 'x86',
    components: {
      node: '24.20.0',
      docker: '29.8.0',
      compose: '5.5.1',
      caddy: '2.11.4',
      step: '0.30.6',
      guestctlSha256: 'a'.repeat(64),
    },
    trust: {
      sshUserCa: 'ssh-ed25519 AAAA',
      sshHostCa: 'ssh-ed25519 BBBB',
      tlsRoot: 'fixture-root',
    },
  });
  const image = guestImageSchema.parse({
    ...manifest.trust,
    version: manifest.version,
    architecture: manifest.architecture,
    providerImage: 'fixture',
    manifestDigest: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  });
  const fixture = await prepareEnrollmentFixture({
    connection: database.connection,
    image,
    address: '192.0.2.10',
    enrollmentUrl: 'https://enrollment.example.test/guest/enroll',
  });
  const identity = {
    sshHostPublicKey: 'ssh-ed25519 CCCC',
    tlsCsr: 'fixture-csr',
    imageVersion: image.version,
  };
  // Enrollment has its own protocol tests. Here its immutable DB handoff is the prerequisite.
  await db.insert(guestIdentities).values({
    accountId: fixture.allocation.accountId,
    allocationId: fixture.allocation.id,
    identity: { kind: 'claimed', ...identity },
  });
  await db.update(guestIdentities).set({
    identity: {
      kind: 'issued',
      ...identity,
      sshHostCertificate: 'fixture-host-cert',
      tlsCertificate: 'fixture-tls-cert',
      issuedAt: new Date().toISOString(),
    },
  });
  const evidence = guestRuntimeSchema.parse({
    version: 1,
    architecture: manifest.architecture,
    bootId: randomUUID(),
    manifest,
    proof: {
      version: 1,
      allocationId: fixture.bootstrap.spec.allocationId,
      manifestDigest: image.manifestDigest,
      ...identity,
    },
    checks: {
      node: { kind: 'ok', version: manifest.components.node },
      docker: { kind: 'ok', version: manifest.components.docker },
      compose: { kind: 'ok', version: manifest.components.compose },
      caddy: { kind: 'ok', version: manifest.components.caddy },
      step: { kind: 'ok', version: manifest.components.step },
      disk: { kind: 'ok', availableBytes: 8 * 1024 ** 3, totalBytes: 20 * 1024 ** 3 },
      proxy: {
        kind: 'ok',
        allocationId: fixture.bootstrap.spec.allocationId,
        imageVersion: image.version,
      },
    },
  });
  const signer = {
    issueRuntimeCredential: vi
      .fn<Signer['issueRuntimeCredential']>()
      .mockImplementation((subject) =>
        Promise.resolve({
          kind: 'runtime',
          subject,
          certificate: 'fixture-cert',
          privateKey: 'fixture-key',
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        }),
      ),
  };
  const probe = { readRuntime: vi.fn().mockImplementation(() => Promise.resolve(evidence)) };
  const ports = { provider: fixture.provider, signer, probe };
  let runtime = createGuestReadiness(ports);
  const tick = (operationId: OperationId = fixture.operation.id) =>
    advanceOperation({
      connection: database.connection,
      operationId,
      provider: fixture.provider,
      limits: fixture.limits,
      guest: {
        kind: 'enabled',
        resolveImage: () => Promise.resolve(image),
        seal: fixture.seal,
        enrollmentUrl: fixture.bootstrap.spec.enrollmentUrl,
        runtime,
      },
    });
  async function progress(operationId = fixture.operation.id) {
    return (await db.select().from(operations).where(eq(operations.id, operationId)))[0]?.progress;
  }
  async function machine() {
    const [row] = await db
      .select()
      .from(machines)
      .where(eq(machines.id, fixture.operation.machineId));
    if (!row) throw new Error('Expected machine.');
    return machineRecord(row);
  }
  async function action(kind: 'reboot' | 'power_on' | 'power_off') {
    const current = await machine();
    const app = createApp({
      db,
      provider: fixture.provider.kind,
      catalog: fixture.catalog,
      limits: fixture.limits,
    });
    const response = await app.request(`/v1/machines/${current.id}/actions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${fixture.account.token}`,
        'Idempotency-Key': randomUUID(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ kind, expectedVersion: current.version }),
    });
    expect(response.status).toBe(202);
    return operationResponseSchema.parse(await response.json()).operation;
  }
  return {
    ...fixture,
    evidence,
    signer,
    probe,
    tick,
    progress,
    machine,
    action,
    restart: () => {
      runtime = createGuestReadiness(ports);
    },
  };
}

it('completes from fresh runtime evidence once and records SSH verification atomically', async () => {
  const guest = await scenario();
  await Promise.all([guest.tick(), guest.tick(), guest.tick()]);
  expect(await guest.progress()).toMatchObject({ kind: 'succeeded' });
  expect((await guest.machine()).state).toMatchObject({
    kind: 'allocated',
    guest: {
      kind: 'ssh',
      bootId: guest.evidence.bootId,
      manifestDigest: guest.evidence.proof.manifestDigest,
    },
  });
  await guest.tick();
  expect(guest.signer.issueRuntimeCredential).toHaveBeenCalledTimes(1);
  expect(guest.probe.readRuntime).toHaveBeenCalledTimes(1);
  const events = await database.connection.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.event, 'operation.succeeded'));
  expect(events).toHaveLength(1);
  expect(events[0]?.details).toMatchObject({ verification: 'ssh' });
});

it.each(['docker', 'compose', 'caddy', 'step', 'node', 'proxy', 'disk'] satisfies Array<
  keyof GuestRuntime['checks']
>)('waits for unavailable %s and reuses its signed credential', async (component) => {
  const guest = await scenario();
  const healthy = structuredClone(guest.evidence);
  guest.evidence.checks[component] = { kind: 'unavailable' };
  await guest.tick();
  await guest.tick();
  expect(await guest.progress()).toMatchObject({ kind: 'waiting_guest', stage: 'runtime' });
  guest.probe.readRuntime.mockResolvedValue(healthy);
  await guest.tick();
  expect(await guest.progress()).toMatchObject({ kind: 'succeeded' });
  expect(guest.signer.issueRuntimeCredential).toHaveBeenCalledTimes(1);
});

it('waits for disk headroom, matching component versions and allocation-specific proxy health', async () => {
  const guest = await scenario();
  const healthy = structuredClone(guest.evidence);
  for (const checks of [
    {
      ...healthy.checks,
      disk: { kind: 'ok', availableBytes: 32 * 1024 ** 2, totalBytes: 32 * 1024 ** 2 },
    },
    { ...healthy.checks, docker: { kind: 'ok', version: '1.0.0' } },
    {
      ...healthy.checks,
      proxy: {
        kind: 'ok',
        allocationId: newId.allocation(),
        imageVersion: healthy.manifest.version,
      },
    },
  ]) {
    guest.probe.readRuntime.mockResolvedValue(guestRuntimeSchema.parse({ ...healthy, checks }));
    await guest.tick();
    expect(await guest.progress()).toMatchObject({ kind: 'waiting_guest' });
  }
  guest.probe.readRuntime.mockResolvedValue(healthy);
  await guest.tick();
  expect(await guest.progress()).toMatchObject({ kind: 'succeeded' });
});

it.each(['identity', 'manifest', 'architecture'])(
  'blocks changed %s without releasing resource reservations',
  async (change) => {
    const guest = await scenario();
    if (change === 'identity') guest.evidence.proof.sshHostPublicKey = 'ssh-ed25519 DDDD';
    if (change === 'manifest') guest.evidence.manifest.components.guestctlSha256 = 'b'.repeat(64);
    if (change === 'architecture') guest.evidence.architecture = 'arm';
    await guest.tick();
    expect(await guest.progress()).toEqual({ kind: 'blocked', reason: 'guest_identity_mismatch' });
    expect(
      await database.connection.db.select().from(allocations).where(isNull(allocations.retiredAt)),
    ).toHaveLength(1);
  },
);

it('rechecks provider ownership before issuing a credential', async () => {
  const guest = await scenario();
  const original = guest.provider.getPrimaryIp.bind(guest.provider);
  guest.provider.getPrimaryIp = async (input) => {
    const ip = await original(input);
    return ip && { ...ip, labels: {} };
  };
  await guest.tick();
  expect(await guest.progress()).toMatchObject({ kind: 'waiting_guest' });
  expect(guest.signer.issueRuntimeCredential).not.toHaveBeenCalled();
  expect(guest.probe.readRuntime).not.toHaveBeenCalled();
});

it('persists signing cooldown across restarts and rejects mutable, out-of-order or foreign attempts', async () => {
  const guest = await scenario();
  guest.evidence.checks.docker = { kind: 'unavailable' };
  await guest.tick();
  guest.restart();
  await guest.tick();
  expect(guest.signer.issueRuntimeCredential).toHaveBeenCalledTimes(1);
  const db = database.connection.db;
  const other = await seedAccount(db);
  const attempt = {
    accountId: guest.allocation.accountId,
    allocationId: guest.allocation.id,
    operationId: guest.operation.id,
  };
  await expect(db.delete(runtimeSigningAttempts)).rejects.toThrow();
  await expect(db.update(runtimeSigningAttempts).set({ sequence: 1 })).rejects.toThrow();
  await expect(
    db.insert(runtimeSigningAttempts).values({ ...attempt, sequence: 3 }),
  ).rejects.toThrow();
  await expect(
    db
      .insert(runtimeSigningAttempts)
      .values({ ...attempt, accountId: other.principal.accountId, sequence: 2 }),
  ).rejects.toThrow();
  // Fill the immutable issuance journal through its SQL boundary, then restart the service.
  for (let sequence = 2; sequence <= 12; sequence++)
    await db.insert(runtimeSigningAttempts).values({ ...attempt, sequence });
  await expect(
    db.insert(runtimeSigningAttempts).values({ ...attempt, sequence: 13 }),
  ).rejects.toThrow();
  guest.restart();
  await guest.tick();
  expect(await guest.progress()).toEqual({ kind: 'blocked', reason: 'guest_signing_exhausted' });
  expect(guest.signer.issueRuntimeCredential).toHaveBeenCalledTimes(1);
});

it('blocks expired readiness without signing or freeing the owned allocation', async () => {
  const guest = await scenario();
  await database.connection.db
    .update(operations)
    .set({ createdAt: sql`now() - interval '31 minutes'` })
    .where(eq(operations.id, guest.operation.id));
  await guest.tick();
  expect(await guest.progress()).toEqual({ kind: 'blocked', reason: 'guest_deadline_exceeded' });
  expect(guest.signer.issueRuntimeCredential).not.toHaveBeenCalled();
  expect(
    await database.connection.db.select().from(allocations).where(isNull(allocations.retiredAt)),
  ).toHaveLength(1);
});

it('rechecks the database deadline after SSH returns before committing success', async () => {
  const guest = await scenario();
  guest.probe.readRuntime.mockImplementation(async () => {
    await database.connection.db
      .update(operations)
      .set({ createdAt: sql`now() - interval '31 minutes'` })
      .where(eq(operations.id, guest.operation.id));
    return guest.evidence;
  });
  await guest.tick();
  expect(await guest.progress()).toEqual({ kind: 'blocked', reason: 'guest_deadline_exceeded' });
  expect((await guest.machine()).state).not.toMatchObject({ guest: { kind: 'ssh' } });
  expect(
    await database.connection.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.event, 'operation.succeeded')),
  ).toHaveLength(0);
});

it('does not finish reboot or power-on until the Linux boot ID changes', async () => {
  const guest = await scenario();
  await guest.tick();
  const reboot = await guest.action('reboot');
  for (let i = 0; i < 4; i++) await guest.tick(reboot.id);
  expect(await guest.progress(reboot.id)).toMatchObject({
    kind: 'waiting_guest',
    stage: 'runtime',
  });
  guest.evidence.bootId = randomUUID();
  await guest.tick(reboot.id);
  expect(await guest.progress(reboot.id)).toMatchObject({ kind: 'succeeded' });
  const off = await guest.action('power_off');
  for (let i = 0; i < 4; i++) await guest.tick(off.id);
  expect(await guest.progress(off.id)).toMatchObject({ kind: 'succeeded' });
  const on = await guest.action('power_on');
  for (let i = 0; i < 4; i++) await guest.tick(on.id);
  expect(await guest.progress(on.id)).toMatchObject({ kind: 'waiting_guest', stage: 'runtime' });
  guest.evidence.bootId = randomUUID();
  await guest.tick(on.id);
  expect(await guest.progress(on.id)).toMatchObject({ kind: 'succeeded' });
});

import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq, isNull, sql } from 'drizzle-orm';
import {
  guestImageSchema,
  newId,
  attemptIdSchema,
  operationResponseSchema,
  operationProgressSchema,
  providerCommandSchema,
  simulatedCatalog,
  type MachineProvider,
} from '../packages/contracts/dist/index.js';
import {
  allocations,
  attempts,
  guestBootstraps,
  guestIdentities,
  operations,
  simulatedPrimaryIps,
} from '../packages/db/src/index.js';
import { createApp } from '../apps/control/src/app.js';
import { SimulatedProvider, type SimulationFault } from '../apps/control/src/simulated-provider.js';
import { advanceOperation } from '../apps/control/src/advance-operation.js';
import { BootstrapSeal } from '../apps/control/src/bootstrap-seal.js';
import { recoverGuestBootstrap } from '../apps/control/src/guest-bootstrap.js';
import { createGuestRenderer } from '../apps/control/src/guest-renderer.js';
import { seedAccount, testDatabase } from './database.js';

let fixture: Awaited<ReturnType<typeof testDatabase>>;
const limits = { currency: 'EUR', maxMachines: 100, maxHourlyMicros: 1_000_000 };
const image = guestImageSchema.parse({
  providerImage: 'pinned-snapshot',
  architecture: 'x86',
  version: 'v1',
  manifestDigest: 'a'.repeat(64),
  sshUserCa: 'ssh-ed25519 AAAA',
  sshHostCa: 'ssh-ed25519 BBBB',
  tlsRoot: 'fixture-root',
});
beforeAll(async () => {
  fixture = await testDatabase();
});
afterAll(async () => {
  await fixture.close();
});
beforeEach(async () => {
  await fixture.reset();
});

async function scenario(fault: SimulationFault = { kind: 'none' }) {
  const account = await seedAccount(fixture.connection.db);
  const seal = new BootstrapSeal(randomBytes(32).toString('base64'));
  const render = vi.fn(createGuestRenderer(fixture.connection.db, seal));
  const simulation = new SimulatedProvider({
    db: fixture.connection.db,
    fault,
    catalog: () => ({ ...simulatedCatalog(), provider: 'hetzner' }),
  });
  // Only the provider transport is simulated. Admission, journal, bootstrap and rendering are real.
  const provider: MachineProvider = {
    kind: 'hetzner',
    getCatalog: () => simulation.getCatalog(),
    submit: async (input) => {
      if (input.command.kind === 'create_guest')
        await render({ attemptId: input.attemptId, command: input.command });
      return simulation.submit(input);
    },
    getAction: (input) => simulation.getAction(input),
    getServer: (input) => simulation.getServer(input),
    findServers: (input) => simulation.findServers(input),
    getPrimaryIp: (input) => simulation.getPrimaryIp(input),
    findPrimaryIps: (input) => simulation.findPrimaryIps(input),
  };
  const app = createApp({
    db: fixture.connection.db,
    provider: 'hetzner',
    limits,
    catalog: simulation.catalog,
  });
  const response = await app.request(`/v1/projects/${account.projectId}/machines`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${account.token}`,
      'Idempotency-Key': randomUUID(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'guest', size: 'small', region: 'nbg1' }),
  });
  expect(response.status).toBe(202);
  const { operation } = operationResponseSchema.parse(await response.json());
  const guest = {
    kind: 'enabled',
    runtime: { check: () => Promise.resolve({ kind: 'waiting' }) },
    resolveImage: () => Promise.resolve(image),
    seal,
    enrollmentUrl: 'https://enrollment.example.test/guest/enroll',
  } satisfies NonNullable<Parameters<typeof advanceOperation>[0]['guest']>;
  const tick = () =>
    advanceOperation({
      connection: fixture.connection,
      operationId: operation.id,
      provider,
      limits,
      guest,
    });
  async function state() {
    return operationProgressSchema.parse(
      (
        await fixture.connection.db.select().from(operations).where(eq(operations.id, operation.id))
      )[0]?.progress,
    );
  }
  async function history() {
    return fixture.connection.db
      .select()
      .from(attempts)
      .where(eq(attempts.operationId, operation.id))
      .orderBy(attempts.sequence);
  }
  return { account, operation, provider, guest, tick, state, history, render };
}

it('pins bootstrap rendering to the persisted initial attempt and preserves the runtime phase on worker ticks', async () => {
  const test = await scenario();
  for (let tick = 0; tick < 6; tick++) await test.tick();
  expect(await test.state()).toMatchObject({ kind: 'waiting_guest', stage: 'enrollment' });
  const history = await test.history();
  expect(history.map((attempt) => providerCommandSchema.parse(attempt.command).kind)).toEqual([
    'create_primary_ip',
    'create_guest',
  ]);
  expect(test.render).toHaveBeenCalledTimes(1);
  const rendering = test.render.mock.results[0];
  if (rendering?.type !== 'return') throw new Error('Expected rendered guest.');
  const rendered = await rendering.value;
  expect(rendered.image).toBe(image.providerImage);
  expect(rendered.userData).toContain('agent-cloud-enroll.service');
  const [bootstrap] = await fixture.connection.db.select().from(guestBootstraps);
  if (!bootstrap) throw new Error('Expected bootstrap.');
  const create = history[1];
  const command = providerCommandSchema.parse(create?.command);
  if (!create || command.kind !== 'create_guest') throw new Error('Expected guest create.');
  await expect(test.render({ attemptId: newId.attempt(), command })).rejects.toThrow('prepared');
  const { token } = await recoverGuestBootstrap(fixture.connection.db, {
    reference: command.bootstrap,
    seal: test.guest.seal,
  });
  expect(rendered.userData).toContain(token);
  expect(JSON.stringify(history)).not.toContain(token);
  // Confirmed attempts can be reconciled but can no longer disclose or render their bootstrap.
  await expect(
    test.render({ attemptId: attemptIdSchema.parse(create.id), command }),
  ).rejects.toThrow('prepared');
  await fixture.connection.db.insert(guestIdentities).values({
    accountId: bootstrap.accountId,
    allocationId: bootstrap.allocationId,
    identity: {
      kind: 'claimed',
      sshHostPublicKey: 'ssh-ed25519 CCCC',
      tlsCsr: 'fixture-csr',
      imageVersion: image.version,
    },
  });
  await fixture.connection.db.update(guestIdentities).set({
    identity: {
      kind: 'issued',
      sshHostPublicKey: 'ssh-ed25519 CCCC',
      tlsCsr: 'fixture-csr',
      imageVersion: image.version,
      sshHostCertificate: 'fixture-ssh',
      tlsCertificate: 'fixture-tls',
      issuedAt: new Date().toISOString(),
    },
  });
  for (let tick = 0; tick < 3; tick++) await test.tick();
  expect(await test.state()).toMatchObject({ kind: 'waiting_guest', stage: 'runtime' });
});

it.each<'lose_response' | 'timeout_before_submit' | 'duplicate_create'>([
  'lose_response',
  'timeout_before_submit',
  'duplicate_create',
])('never rerenders or resubmits an uncertain guest create after %s', async (kind) => {
  const test = await scenario(kind === 'lose_response' ? { kind, visibilityDelayMs: 0 } : { kind });
  for (let tick = 0; tick < 9; tick++) await test.tick();
  expect(test.render).toHaveBeenCalledTimes(1);
  expect(
    (await test.history()).map((attempt) => providerCommandSchema.parse(attempt.command).kind),
  ).toEqual(['create_primary_ip', 'create_guest']);
  expect((await test.state()).kind).toBe(kind === 'lose_response' ? 'waiting_guest' : 'blocked');
  expect(
    await fixture.connection.db.select().from(allocations).where(isNull(allocations.retiredAt)),
  ).toHaveLength(1);
  expect(await fixture.connection.db.select().from(simulatedPrimaryIps)).toHaveLength(1);
});

it('refuses unconfigured live provisioning before even allocating an IP', async () => {
  const test = await scenario();
  await advanceOperation({
    connection: fixture.connection,
    operationId: test.operation.id,
    provider: test.provider,
    limits,
  });
  expect((await test.state()).kind).toBe('failed');
  expect(await test.history()).toHaveLength(0);
  expect(test.render).not.toHaveBeenCalled();
  expect(
    await fixture.connection.db.select().from(allocations).where(isNull(allocations.retiredAt)),
  ).toHaveLength(0);
});

it('compensates the owned IP after a definitive guest-create rejection', async () => {
  const test = await scenario({ kind: 'reject' });
  for (let tick = 0; tick < 9; tick++) await test.tick();
  expect((await test.state()).kind).toBe('failed');
  expect(
    (await test.history()).map((attempt) => providerCommandSchema.parse(attempt.command).kind),
  ).toEqual(['create_primary_ip', 'create_guest', 'delete_primary_ip']);
  expect(
    await fixture.connection.db.select().from(allocations).where(isNull(allocations.retiredAt)),
  ).toHaveLength(0);
  expect(await fixture.connection.db.select().from(simulatedPrimaryIps)).toHaveLength(0);
});

it.each([false, true])(
  'expires a queued create without renting a VM, with owned IP: %s',
  async (withIp) => {
    const test = await scenario();
    if (withIp) {
      await test.tick();
      await test.tick();
    }
    await fixture.connection.db
      .update(operations)
      .set({ createdAt: sql`now() - interval '31 minutes'` })
      .where(eq(operations.id, test.operation.id));
    for (let i = 0; i < 6; i++) await test.tick();
    expect(await test.state()).toMatchObject({ kind: 'failed' });
    expect(test.render).not.toHaveBeenCalled();
    expect(
      (await test.history()).map((row) => providerCommandSchema.parse(row.command).kind),
    ).toEqual(withIp ? ['create_primary_ip', 'delete_primary_ip'] : []);
    expect(
      await fixture.connection.db.select().from(allocations).where(isNull(allocations.retiredAt)),
    ).toHaveLength(0);
    expect(await fixture.connection.db.select().from(simulatedPrimaryIps)).toHaveLength(0);
  },
);

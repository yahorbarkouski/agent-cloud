import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { eq, isNull } from 'drizzle-orm';
import {
  CloudError,
  simulatedCatalog,
  operationResponseSchema,
  operationProgressSchema,
  providerCommandSchema,
  providerPrimaryIpSchema,
  effectResolutionSchema,
  type Operation,
  type MachineProvider,
  type Submission,
} from '../packages/contracts/src/index.js';
import {
  allocations,
  attempts,
  grants,
  machines,
  operations,
  providerResources,
  simulatedPrimaryIps,
  simulatedServers,
} from '../packages/db/src/index.js';
import { createApp, advanceOperation, SimulatedProvider } from '../apps/control/src/index.js';
import { seedAccount, testDatabase } from './database.js';

const limits = { currency: 'EUR', maxMachines: 100, maxHourlyMicros: 10_000_000 };
let fixture: Awaited<ReturnType<typeof testDatabase>>;
let account: Awaited<ReturnType<typeof seedAccount>>;
let app: ReturnType<typeof createApp>;
let provider: SimulatedProvider;
beforeAll(async () => {
  fixture = await testDatabase();
});
afterAll(async () => {
  await fixture.close();
});
beforeEach(async () => {
  await fixture.reset();
  account = await seedAccount(fixture.connection.db);
  provider = new SimulatedProvider({ db: fixture.connection.db });
  app = createApp({
    db: fixture.connection.db,
    provider: 'simulated',
    catalog: simulatedCatalog,
    limits,
  });
});
async function post(path: string, body: unknown) {
  const response = await app.request(path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${account.token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(202);
  return operationResponseSchema.parse(await response.json()).operation;
}
function create() {
  return post(`/v1/projects/${account.projectId}/machines`, {
    name: 'resources',
    size: 'small',
    region: 'nbg1',
  });
}
async function destroy(operation: Operation) {
  const [machine] = await fixture.connection.db
    .select()
    .from(machines)
    .where(eq(machines.id, operation.machineId));
  return post(`/v1/machines/${operation.machineId}/actions`, {
    kind: 'destroy',
    expectedVersion: machine?.version,
    allowDataLoss: true,
  });
}
function tick(operation: Operation, source: MachineProvider = provider) {
  return advanceOperation({
    connection: fixture.connection,
    operationId: operation.id,
    provider: source,
    limits,
  });
}
async function progress(operation: Operation) {
  const [row] = await fixture.connection.db
    .select()
    .from(operations)
    .where(eq(operations.id, operation.id));
  return operationProgressSchema.parse(row?.progress);
}
async function settle(
  operation: Operation,
  expected = 'succeeded',
  source: MachineProvider = provider,
) {
  await expect
    .poll(
      async () => {
        await tick(operation, source);
        return (await progress(operation)).kind;
      },
      { timeout: 5000, interval: 20 },
    )
    .toBe(expected);
}
async function history(operation: Operation) {
  return fixture.connection.db
    .select()
    .from(attempts)
    .where(eq(attempts.operationId, operation.id))
    .orderBy(attempts.sequence);
}
async function kinds(operation: Operation) {
  return (await history(operation)).map((row) => providerCommandSchema.parse(row.command).kind);
}
async function reserved() {
  return fixture.connection.db.select().from(allocations).where(isNull(allocations.retiredAt));
}
async function onlyIp() {
  const [row] = await fixture.connection.db.select().from(simulatedPrimaryIps);
  return providerPrimaryIpSchema.parse(row?.value);
}

it('recovers a lost IP response after restart without allocating a second IP', async () => {
  const operation = await create();
  await tick(
    operation,
    new SimulatedProvider({
      db: fixture.connection.db,
      primaryIpFault: { kind: 'lose_response', visibilityDelayMs: 0 },
    }),
  );
  await settle(operation);
  expect(await kinds(operation)).toEqual(['create_primary_ip', 'create']);
  expect(await fixture.connection.db.select().from(simulatedPrimaryIps)).toHaveLength(1);
  expect(await fixture.connection.db.select().from(providerResources)).toHaveLength(2);
});

it.each(['timeout_before_submit', 'duplicate_create', 'delayed'])(
  'holds the reservation and never submits a VM when IP creation is %s',
  async (fault) => {
    const operation = await create();
    await tick(
      operation,
      new SimulatedProvider({
        db: fixture.connection.db,
        primaryIpFault:
          fault === 'delayed'
            ? { kind: 'lose_response', visibilityDelayMs: 60_000 }
            : fault === 'duplicate_create'
              ? { kind: 'duplicate_create' }
              : { kind: 'timeout_before_submit' },
      }),
    );
    for (let step = 0; step < 5; step++) await tick(operation);
    expect((await progress(operation)).kind).toBe('blocked');
    expect(await kinds(operation)).toEqual(['create_primary_ip']);
    expect(await reserved()).toHaveLength(1);
    expect(await fixture.connection.db.select().from(simulatedServers)).toHaveLength(0);
    if (fault === 'delayed') {
      await fixture.connection.db.update(simulatedPrimaryIps).set({ visibleAt: new Date() });
      await settle(operation);
      expect(await kinds(operation)).toEqual(['create_primary_ip', 'create']);
    }
  },
);

it.each(['revoked', 'rejected_vm'])(
  'cleans the IP after %s and retains the full reservation until absence is observed',
  async (cause) => {
    const operation = await create();
    await tick(operation);
    await tick(operation);
    if (cause === 'revoked')
      await fixture.connection.db
        .update(grants)
        .set({ revokedAt: new Date() })
        .where(eq(grants.id, account.principal.grantId));
    else provider = new SimulatedProvider({ db: fixture.connection.db, fault: { kind: 'reject' } });
    await settle(operation, 'cleaning_up');
    expect(await reserved()).toHaveLength(1);
    expect(await fixture.connection.db.select().from(simulatedPrimaryIps)).toHaveLength(1);
    await tick(operation); // Deletion committed, but absence has not yet been reconciled.
    expect(await fixture.connection.db.select().from(simulatedPrimaryIps)).toHaveLength(0);
    expect(await reserved()).toHaveLength(1);
    await settle(operation, 'failed');
    expect(await reserved()).toHaveLength(0);
    expect(await kinds(operation)).toEqual(
      cause === 'revoked'
        ? ['create_primary_ip', 'delete_primary_ip']
        : ['create_primary_ip', 'create', 'delete_primary_ip'],
    );
  },
);

it('does not compensate an IP after an uncertain VM submission even when the grant is revoked', async () => {
  const operation = await create();
  provider = new SimulatedProvider({
    db: fixture.connection.db,
    fault: { kind: 'timeout_before_submit' },
  });
  for (let step = 0; step < 3; step++) await tick(operation);
  await fixture.connection.db
    .update(grants)
    .set({ revokedAt: new Date() })
    .where(eq(grants.id, account.principal.grantId));
  for (let step = 0; step < 4; step++) await tick(operation);
  expect((await progress(operation)).kind).toBe('blocked');
  expect(await kinds(operation)).toEqual(['create_primary_ip', 'create']);
  expect(await fixture.connection.db.select().from(simulatedPrimaryIps)).toHaveLength(1);
  expect(await reserved()).toHaveLength(1);
});

it('reconciles explicit IP deletion after server deletion and a lost cleanup response', async () => {
  const created = await create();
  await settle(created);
  const operation = await destroy(created);
  provider = new SimulatedProvider({
    db: fixture.connection.db,
    retainPrimaryIps: true,
    primaryIpFault: { kind: 'lose_response', visibilityDelayMs: 0 },
  });
  await settle(operation);
  expect(await kinds(operation)).toEqual(['destroy', 'delete_primary_ip']);
  expect(await reserved()).toHaveLength(0);
  expect(await fixture.connection.db.select().from(simulatedPrimaryIps)).toHaveLength(0);
  expect(
    (await fixture.connection.db.select().from(providerResources)).every(
      (row) => row.absentAt !== null,
    ),
  ).toBe(true);
});

it.each(['ownership', 'assignment', 'id'])(
  'blocks cleanup when the IP %s no longer agrees with its allocation',
  async (mismatch) => {
    const operation = await create();
    await tick(operation);
    await tick(operation);
    await fixture.connection.db
      .update(grants)
      .set({ revokedAt: new Date() })
      .where(eq(grants.id, account.principal.grantId));
    await tick(operation);
    const ip = await onlyIp();
    await fixture.connection.db.update(simulatedPrimaryIps).set({
      value: {
        ...ip,
        ...(mismatch === 'ownership' ? { labels: { ...ip.labels, account_id: 'foreign' } } : {}),
        ...(mismatch === 'assignment'
          ? { assignment: { kind: 'server', serverId: 'foreign' } }
          : {}),
        ...(mismatch === 'id' ? { id: 'wrong-resource' } : {}),
      },
    });
    await tick(operation);
    expect(await progress(operation)).toEqual({
      kind: 'blocked',
      reason: 'provider_resource_mismatch',
    });
    expect(await kinds(operation)).toEqual(['create_primary_ip']);
    expect(await reserved()).toHaveLength(1);
  },
);

it('does not release an allocation when a post-submission ownership claim fails', async () => {
  const original = await create();
  await settle(original);
  const [owned] = await fixture.connection.db
    .select()
    .from(providerResources)
    .where(eq(providerResources.kind, 'server'));
  if (!owned) throw new Error('Expected an owned server.');
  const conflictingId = owned.providerId;
  const operation = await post(`/v1/projects/${account.projectId}/machines`, {
    name: 'second',
    size: 'small',
    region: 'nbg1',
  });
  class ConflictingReceipt extends SimulatedProvider {
    override async submit(input: Parameters<MachineProvider['submit']>[0]): Promise<Submission> {
      const result = await super.submit(input);
      return input.command.kind === 'create'
        ? { kind: 'completed', resource: { kind: 'server', id: conflictingId } }
        : result;
    }
  }
  const faulty = new ConflictingReceipt({ db: fixture.connection.db });
  for (let step = 0; step < 5; step++) await tick(operation, faulty);
  expect((await progress(operation)).kind).toBe('blocked');
  expect(await kinds(operation)).toEqual(['create_primary_ip', 'create']);
  expect(await fixture.connection.db.select().from(simulatedServers)).toHaveLength(2);
  expect(await fixture.connection.db.select().from(simulatedPrimaryIps)).toHaveLength(2);
  expect(await reserved()).toHaveLength(2);
});

it('enforces immutable effect resolutions and allocation ownership in PostgreSQL', async () => {
  const operation = await create();
  await settle(operation);
  const [attempt] = await history(operation);
  expect(effectResolutionSchema.parse(attempt?.resolution).kind).toBe('confirmed');
  await expect(
    fixture.connection.db.update(attempts).set({ resolution: { kind: 'pending' } }),
  ).rejects.toThrow();
  const foreign = await seedAccount(fixture.connection.db);
  const [allocation] = await reserved();
  if (!allocation) throw new CloudError('internal_error', 'Expected an allocation.');
  await expect(
    fixture.connection.db.insert(providerResources).values({
      provider: 'simulated',
      kind: 'primary_ip',
      providerId: 'foreign-ip',
      allocationId: allocation.id,
      accountId: foreign.principal.accountId,
      labels: {},
    }),
  ).rejects.toThrow();
});

it.each(['create_primary_ip', 'delete_primary_ip'])(
  'recovers a process exit after %s commits but before its receipt is saved',
  async (kind) => {
    const created = await create();
    let operation = created;
    if (kind === 'delete_primary_ip') {
      await settle(created);
      operation = await destroy(created);
    }
    await expect(
      promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', 'tests/fixtures/crash-after-submit.ts'],
        {
          env: {
            ...process.env,
            CRASH_TEST_DATABASE_URL: fixture.databaseUrl,
            CRASH_TEST_OPERATION_ID: operation.id,
            CRASH_TEST_EFFECT_KIND: kind,
          },
          timeout: 10_000,
        },
      ),
    ).rejects.toMatchObject({ code: 86 });
    const interrupted = (await history(operation)).find(
      (row) => providerCommandSchema.parse(row.command).kind === kind,
    );
    expect(interrupted?.outcome).toEqual({ kind: 'prepared' });
    await settle(operation);
    expect((await kinds(operation)).filter((candidate) => candidate === kind)).toHaveLength(1);
    expect(await reserved()).toHaveLength(kind === 'create_primary_ip' ? 1 : 0);
  },
);

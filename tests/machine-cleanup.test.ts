import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { eq, isNull } from 'drizzle-orm';
import {
  operationResponseSchema,
  operationSchema,
  machineResponseSchema,
  simulatedCatalog,
  providerCommandSchema,
  providerPrimaryIpSchema,
  effectResolutionSchema,
  newId,
  type Operation,
  type MachineProvider,
  type Submission,
} from '../packages/contracts/src/index.js';
import {
  allocations,
  attempts,
  operations,
  operationCleanups,
  providerResources,
  grants,
  simulatedServers,
  simulatedPrimaryIps,
  withMachineLock,
} from '../packages/db/src/index.js';
import { createApp, advanceOperation, SimulatedProvider } from '../apps/control/src/index.js';
import { testDatabase, seedAccount } from './database.js';

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
function post(path: string, body: unknown, key = randomUUID(), token = account.token) {
  return app.request(path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify(body),
  });
}
async function create() {
  const response = await post(`/v1/projects/${account.projectId}/machines`, {
    name: 'cleanup',
    size: 'small',
    region: 'nbg1',
  });
  expect(response.status).toBe(202);
  return operationResponseSchema.parse(await response.json()).operation;
}
async function machine(op: Operation) {
  const response = await app.request(`/v1/machines/${op.machineId}`, {
    headers: { Authorization: `Bearer ${account.token}` },
  });
  return machineResponseSchema.parse(await response.json()).machine;
}
async function destroy(op: Operation, key = randomUUID()) {
  const current = await machine(op);
  const response = await post(
    `/v1/machines/${op.machineId}/actions`,
    { kind: 'destroy', expectedVersion: current.version, allowDataLoss: true },
    key,
  );
  expect(response.status).toBe(202);
  return operationResponseSchema.parse(await response.json()).operation;
}
async function read(op: Operation) {
  const [row] = await fixture.connection.db
    .select()
    .from(operations)
    .where(eq(operations.id, op.id));
  return operationSchema.parse({ ...row, createdAt: row?.createdAt.toISOString() });
}
function tick(op: Operation, source: MachineProvider = provider) {
  return advanceOperation({
    connection: fixture.connection,
    operationId: op.id,
    provider: source,
    limits,
  });
}
async function history() {
  return fixture.connection.db
    .select()
    .from(attempts)
    .orderBy(attempts.createdAt, attempts.sequence);
}
async function until(op: Operation, expected: string, source: MachineProvider = provider) {
  await expect
    .poll(
      async () => {
        await tick(op, source);
        return (await read(op)).progress.kind;
      },
      { timeout: 10_000, interval: 20 },
    )
    .toBe(expected);
}
async function submitVm(op: Operation, source: MachineProvider = provider) {
  await expect
    .poll(
      async () => {
        await tick(op, source);
        return (await history()).filter(
          (row) => providerCommandSchema.parse(row.command).kind === 'create',
        ).length;
      },
      { timeout: 5000, interval: 20 },
    )
    .toBe(1);
}
async function absent() {
  expect(
    await fixture.connection.db.select().from(allocations).where(isNull(allocations.retiredAt)),
  ).toHaveLength(0);
  expect(
    await fixture.connection.db
      .select()
      .from(providerResources)
      .where(isNull(providerResources.absentAt)),
  ).toHaveLength(0);
  expect(await fixture.connection.db.select().from(simulatedServers)).toHaveLength(0);
  expect(await fixture.connection.db.select().from(simulatedPrimaryIps)).toHaveLength(0);
}

it('cancels before the first effect and replays the original key after version changes', async () => {
  const created = await create();
  const key = randomUUID();
  const cancelled = await destroy(created, key);
  expect(cancelled.id).toBe(created.id);
  expect(cancelled.intent).toEqual({ kind: 'cleanup', sourceOperationId: created.id });
  await until(cancelled, 'cancelled');
  expect(await history()).toHaveLength(0);
  expect((await machine(created)).state.kind).toBe('destroyed');
  await absent();
  const replay = await post(
    `/v1/machines/${created.machineId}/actions`,
    { kind: 'destroy', expectedVersion: 1, allowDataLoss: true },
    key,
  );
  expect(replay.status).toBe(202);
  expect(operationResponseSchema.parse(await replay.json()).operation.progress.kind).toBe(
    'cancelled',
  );
  const conflict = await post(
    `/v1/machines/${created.machineId}/actions`,
    { kind: 'destroy', expectedVersion: 2, allowDataLoss: true },
    key,
  );
  expect(conflict.status).toBe(409);
});

it('cleans a confirmed IP without creating a server after cancellation', async () => {
  const created = await create();
  await tick(created);
  const cleanup = await destroy(created);
  await until(cleanup, 'cancelled');
  expect((await history()).map((row) => providerCommandSchema.parse(row.command).kind)).toEqual([
    'create_primary_ip',
    'delete_primary_ip',
  ]);
  await absent();
});

it('finishes accepted cleanup after grant revocation and retains original receipts', async () => {
  const created = await create();
  await submitVm(created);
  const original = (await history()).map((row) => ({
    id: row.id,
    command: row.command,
    outcome: row.outcome,
  }));
  const cleanup = await destroy(created);
  await fixture.connection.db
    .update(grants)
    .set({ revokedAt: new Date() })
    .where(eq(grants.id, account.principal.grantId));
  await until(cleanup, 'cancelled');
  expect(
    (await history())
      .slice(0, original.length)
      .map((row) => ({ id: row.id, command: row.command, outcome: row.outcome })),
  ).toEqual(original);
  await absent();
});

it('destroys a ready machine with a new operation and preserves successful creation', async () => {
  const created = await create();
  await until(created, 'succeeded');
  const cleanup = await destroy(created);
  expect(cleanup.id).not.toBe(created.id);
  expect(cleanup.kind).toBe('machine.destroy');
  await until(cleanup, 'succeeded');
  expect((await read(created)).progress.kind).toBe('succeeded');
  await absent();
});

it('preserves failed source results while recovering their retained allocation', async () => {
  const created = await create();
  const failing = new SimulatedProvider({
    db: fixture.connection.db,
    fault: { kind: 'action_failure' },
  });
  await until(created, 'failed', failing);
  const saved = await read(created);
  const cleanup = await destroy(created);
  expect(cleanup.id).not.toBe(created.id);
  await until(cleanup, 'succeeded');
  expect(await read(created)).toEqual(saved);
  await absent();
});

it('retains unknown source creates, their IP and reservation without resubmission', async () => {
  const created = await create();
  await submitVm(
    created,
    new SimulatedProvider({ db: fixture.connection.db, fault: { kind: 'timeout_before_submit' } }),
  );
  const cleanup = await destroy(created);
  for (let i = 0; i < 5; i++) await tick(cleanup);
  expect((await read(cleanup)).progress).toEqual({
    kind: 'blocked',
    reason: 'provider_outcome_unknown',
  });
  expect((await history()).map((row) => providerCommandSchema.parse(row.command).kind)).toEqual([
    'create_primary_ip',
    'create',
  ]);
  expect(
    await fixture.connection.db.select().from(allocations).where(isNull(allocations.retiredAt)),
  ).toHaveLength(1);
  expect(await fixture.connection.db.select().from(simulatedPrimaryIps)).toHaveLength(1);
});

it('retains duplicate IDs after deleting known servers without inventing source closure', async () => {
  const created = await create();
  await submitVm(
    created,
    new SimulatedProvider({ db: fixture.connection.db, fault: { kind: 'duplicate_create' } }),
  );
  const [ipRow] = await fixture.connection.db.select().from(simulatedPrimaryIps);
  if (!ipRow) throw new Error('Missing source IP.');
  await fixture.connection.db
    .update(simulatedPrimaryIps)
    .set({ value: { ...providerPrimaryIpSchema.parse(ipRow.value), autoDelete: false } })
    .where(eq(simulatedPrimaryIps.id, ipRow.id));
  const cleanup = await destroy(created);
  await expect
    .poll(
      async () => {
        await tick(cleanup);
        return (await fixture.connection.db.select().from(simulatedServers)).length;
      },
      { timeout: 5000, interval: 20 },
    )
    .toBe(0);
  for (let i = 0; i < 4; i++) await tick(cleanup);
  const resources = await fixture.connection.db.select().from(providerResources);
  expect(resources.filter((row) => row.kind === 'server')).toHaveLength(2);
  expect(resources.filter((row) => row.kind === 'server').every((row) => row.absentAt)).toBe(true);
  expect((await read(cleanup)).progress).toEqual({
    kind: 'blocked',
    reason: 'duplicate_provider_resources',
  });
  expect(
    (await history()).filter(
      (row) =>
        providerCommandSchema.parse(row.command).kind === 'create' &&
        effectResolutionSchema.parse(row.resolution).kind === 'pending',
    ),
  ).toHaveLength(1);
  expect(await fixture.connection.db.select().from(simulatedPrimaryIps)).toHaveLength(1);
});

it('requires data-loss scope, the current version and the owning account', async () => {
  const created = await create();
  const path = `/v1/machines/${created.machineId}/actions`;
  expect(
    (await post(path, { kind: 'destroy', expectedVersion: 1, allowDataLoss: false })).status,
  ).toBe(403);
  expect(
    (await post(path, { kind: 'destroy', expectedVersion: 2, allowDataLoss: true })).status,
  ).toBe(409);
  const foreign = await seedAccount(fixture.connection.db);
  expect(
    (
      await post(
        path,
        { kind: 'destroy', expectedVersion: 1, allowDataLoss: true },
        randomUUID(),
        foreign.token,
      )
    ).status,
  ).toBe(404);
  await fixture.connection.db
    .update(grants)
    .set({ policy: { ...account.principal.policy, capabilities: ['machine:destroy'] } })
    .where(eq(grants.id, account.principal.grantId));
  expect(
    (await post(path, { kind: 'destroy', expectedVersion: 1, allowDataLoss: true })).status,
  ).toBe(403);
  expect(await fixture.connection.db.select().from(operationCleanups)).toHaveLength(0);
});

it('conflicts with the worker/enrollment session lock before taking admission locks', async () => {
  const created = await create();
  await withMachineLock({
    pool: fixture.connection.pool,
    machineId: created.machineId,
    work: async () => {
      const response = await post(`/v1/machines/${created.machineId}/actions`, {
        kind: 'destroy',
        expectedVersion: 1,
        allowDataLoss: true,
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: 'resource_busy', retryable: true },
      });
    },
  });
  const cleanup = await destroy(created);
  await until(cleanup, 'cancelled');
});

it('enforces immutable cleanup scope and prevents fresh effects or premature retirement in SQL', async () => {
  const created = await create();
  await submitVm(
    created,
    new SimulatedProvider({ db: fixture.connection.db, fault: { kind: 'timeout_before_submit' } }),
  );
  const cleanup = await destroy(created);
  const [authority] = await fixture.connection.db.select().from(operationCleanups);
  if (!authority) throw new Error('Missing cleanup authority.');
  await expect(
    fixture.connection.db.update(operationCleanups).set({ grantId: newId.grant() }),
  ).rejects.toThrow();
  await expect(fixture.connection.db.delete(operationCleanups)).rejects.toThrow();
  await expect(
    fixture.connection.db
      .update(allocations)
      .set({ retiredAt: new Date() })
      .where(eq(allocations.id, authority.allocationId)),
  ).rejects.toThrow();
  await expect(
    fixture.connection.db
      .update(operations)
      .set({ progress: { kind: 'cancelled', completedAt: new Date().toISOString() } })
      .where(eq(operations.id, cleanup.id)),
  ).rejects.toThrow();
  const source = (await history())[0];
  if (!source) throw new Error('Missing source effect.');
  await expect(
    fixture.connection.db.insert(attempts).values({
      id: newId.attempt(),
      accountId: source.accountId,
      operationId: source.operationId,
      sequence: 3,
      command: source.command,
      outcome: { kind: 'prepared' },
    }),
  ).rejects.toThrow();
});

it('does not implicitly auto-delete an IP through VM deletion while a duplicate create is unresolved', async () => {
  const created = await create();
  await submitVm(
    created,
    new SimulatedProvider({ db: fixture.connection.db, fault: { kind: 'duplicate_create' } }),
  );
  const cleanup = await destroy(created);
  for (let i = 0; i < 4; i++) await tick(cleanup);
  expect((await read(cleanup)).progress).toEqual({
    kind: 'blocked',
    reason: 'duplicate_provider_resources',
  });
  const [ipRow] = await fixture.connection.db.select().from(simulatedPrimaryIps);
  const ip = providerPrimaryIpSchema.parse(ipRow?.value);
  if (ip.assignment.kind !== 'server') throw new Error('Source IP must remain attached.');
  expect(await provider.getServer({ serverId: ip.assignment.serverId })).not.toBeNull();
  const attachedId = ip.assignment.serverId;
  expect(
    (await history()).some((row) => {
      const command = providerCommandSchema.parse(row.command);
      return command.kind === 'destroy' && command.serverId === attachedId;
    }),
  ).toBe(false);
  expect(
    (await fixture.connection.db.select().from(providerResources)).filter(
      (row) => row.kind === 'server',
    ),
  ).toHaveLength(2);
});

it('reconciles a lost deletion response without submitting another delete', async () => {
  const created = await create();
  await until(created, 'succeeded');
  const cleanup = await destroy(created);
  class LostDelete extends SimulatedProvider {
    override async submit(input: Parameters<MachineProvider['submit']>[0]): Promise<Submission> {
      const result = await super.submit(input);
      if (input.command.kind === 'destroy') {
        if (result.kind === 'accepted') await super.getAction({ actionId: result.actionId });
        throw new Error('Response lost after deletion.');
      }
      return result;
    }
  }
  await until(cleanup, 'succeeded', new LostDelete({ db: fixture.connection.db }));
  const deletes = (await history()).filter(
    (row) => providerCommandSchema.parse(row.command).kind === 'destroy',
  );
  expect(deletes).toHaveLength(1);
  expect(deletes[0]).toMatchObject({
    outcome: { kind: 'unknown' },
    resolution: { kind: 'confirmed', observation: { kind: 'absent' } },
  });
  await absent();
});

it('backs off and appends an exact-ID retry after an unknown deletion leaves the target present', async () => {
  const created = await create();
  await until(created, 'succeeded');
  const cleanup = await destroy(created);
  class LoseBeforeDelete extends SimulatedProvider {
    lost = false;
    override async submit(input: Parameters<MachineProvider['submit']>[0]): Promise<Submission> {
      if (input.command.kind === 'destroy' && !this.lost) {
        this.lost = true;
        return { kind: 'unknown', reason: 'No definitive submission response.' };
      }
      return super.submit(input);
    }
  }
  const source = new LoseBeforeDelete({ db: fixture.connection.db });
  await tick(cleanup, source);
  await tick(cleanup, source);
  expect(
    (await history()).filter((row) => providerCommandSchema.parse(row.command).kind === 'destroy'),
  ).toHaveLength(1);
  await until(cleanup, 'succeeded', source);
  const deletes = (await history()).filter(
    (row) => providerCommandSchema.parse(row.command).kind === 'destroy',
  );
  expect(deletes).toHaveLength(2);
  expect(deletes[0]?.outcome).toMatchObject({ kind: 'unknown' });
  expect(deletes[0]?.command).toEqual(deletes[1]?.command);
  expect(
    deletes.every((row) => effectResolutionSchema.parse(row.resolution).kind === 'confirmed'),
  ).toBe(true);
  await absent();
});

it('honors persisted retry exhaustion and still observes authoritative external cleanup', async () => {
  const created = await create();
  await until(created, 'succeeded');
  const cleanup = await destroy(created);
  const [server] = await fixture.connection.db
    .select()
    .from(providerResources)
    .where(eq(providerResources.kind, 'server'));
  if (!server) throw new Error('Missing server.');
  const command = { kind: 'destroy', serverId: server.providerId };
  // Fixture-aged prepared attempts model a restarted controller; history is never rewritten.
  for (let sequence = 1; sequence <= 3; sequence++) {
    const id = newId.attempt();
    await fixture.connection.db.insert(attempts).values({
      id,
      accountId: cleanup.accountId,
      operationId: cleanup.id,
      sequence,
      command,
      outcome: { kind: 'prepared' },
      createdAt: new Date(Date.now() - (4 - sequence) * 60_000),
    });
    const error = {
      code: 'provider_rejected',
      message: 'Provider refused deletion.',
      retryable: true,
    };
    await fixture.connection.db
      .update(attempts)
      .set({ outcome: { kind: 'rejected', error }, resolution: { kind: 'failed', error } })
      .where(eq(attempts.id, id));
  }
  await tick(cleanup);
  expect((await read(cleanup)).progress).toEqual({
    kind: 'blocked',
    reason: 'cleanup_retry_exhausted',
  });
  await expect(
    fixture.connection.db.insert(attempts).values({
      id: newId.attempt(),
      accountId: cleanup.accountId,
      operationId: cleanup.id,
      sequence: 4,
      command,
      outcome: { kind: 'prepared' },
    }),
  ).rejects.toMatchObject({ cause: { code: '23514' } });
  const removed = await provider.submit({
    attemptId: newId.attempt(),
    command: { kind: 'destroy', serverId: server.providerId },
  });
  if (removed.kind === 'accepted') await provider.getAction({ actionId: removed.actionId });
  await until(cleanup, 'succeeded');
  expect(
    (await history()).filter((row) => providerCommandSchema.parse(row.command).kind === 'destroy'),
  ).toHaveLength(3);
  await absent();
});

it('blocks deleting a VM whose current attached IP belongs elsewhere', async () => {
  const created = await create();
  await until(created, 'succeeded');
  const cleanup = await destroy(created);
  const [ip] = await fixture.connection.db.select().from(simulatedPrimaryIps);
  if (!ip) throw new Error('Missing IP.');
  await fixture.connection.db
    .update(simulatedPrimaryIps)
    .set({
      value: { ...providerPrimaryIpSchema.parse(ip.value), labels: { account_id: 'foreign' } },
    })
    .where(eq(simulatedPrimaryIps.id, ip.id));
  await tick(cleanup);
  expect((await read(cleanup)).progress).toEqual({
    kind: 'blocked',
    reason: 'provider_resource_mismatch',
  });
  expect(
    (await history()).filter((row) => providerCommandSchema.parse(row.command).kind === 'destroy'),
  ).toHaveLength(0);
  expect(await fixture.connection.db.select().from(simulatedServers)).toHaveLength(1);
});

it.each([
  { autoDelete: true, assignment: { kind: 'unassigned' } },
  { autoDelete: false, assignment: { kind: 'unassigned' } },
  { autoDelete: true, assignment: { kind: 'server', serverId: 'another-server' } },
  { autoDelete: false, assignment: { kind: 'server', serverId: 'another-server' } },
])(
  'blocks inconsistent attached IP assignment $assignment.kind with autoDelete=$autoDelete',
  async (mismatch) => {
    const created = await create();
    await until(created, 'succeeded');
    const cleanup = await destroy(created);
    const [ip] = await fixture.connection.db.select().from(simulatedPrimaryIps);
    if (!ip) throw new Error('Missing IP.');
    await fixture.connection.db
      .update(simulatedPrimaryIps)
      .set({ value: { ...providerPrimaryIpSchema.parse(ip.value), ...mismatch } })
      .where(eq(simulatedPrimaryIps.id, ip.id));
    await tick(cleanup);
    expect((await read(cleanup)).progress).toEqual({
      kind: 'blocked',
      reason: 'provider_resource_mismatch',
    });
    expect(
      (await history()).filter(
        (row) => providerCommandSchema.parse(row.command).kind === 'destroy',
      ),
    ).toHaveLength(0);
    expect(await fixture.connection.db.select().from(simulatedServers)).toHaveLength(1);
  },
);

it('retains every valid duplicate even when inventory also returns a mismatched entry first', async () => {
  const created = await create();
  await submitVm(
    created,
    new SimulatedProvider({ db: fixture.connection.db, fault: { kind: 'duplicate_create' } }),
  );
  const cleanup = await destroy(created);
  class MixedInventory extends SimulatedProvider {
    override async findServers(input: Parameters<MachineProvider['findServers']>[0]) {
      const owned = await super.findServers(input);
      const first = owned[0];
      if (!first) throw new Error('Expected duplicate fixture resources.');
      return [{ ...first, id: 'unowned-result', labels: {} }, ...owned];
    }
  }
  await tick(cleanup, new MixedInventory({ db: fixture.connection.db }));
  const retained = await fixture.connection.db
    .select()
    .from(providerResources)
    .where(eq(providerResources.kind, 'server'));
  expect(retained).toHaveLength(2);
  expect(retained.some((row) => row.providerId === 'unowned-result')).toBe(false);
  const source = (await history()).find(
    (row) => providerCommandSchema.parse(row.command).kind === 'create',
  );
  expect(source?.resolution).toEqual({ kind: 'pending' });
});

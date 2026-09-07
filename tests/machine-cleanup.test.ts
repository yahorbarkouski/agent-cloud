import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  operatorRecoverySchema,
  type Operation,
  type MachineProvider,
  type Submission,
} from '../packages/contracts/src/index.js';
import {
  allocations,
  attempts,
  operations,
  operationCleanups,
  operatorRecoveries,
  providerResources,
  grants,
  simulatedServers,
  simulatedPrimaryIps,
  withMachineLock,
} from '../packages/db/src/index.js';
import { createApp, advanceOperation, SimulatedProvider } from '../apps/control/src/index.js';
import { testDatabase, seedAccount } from './database.js';
import {
  applyOperatorRecovery,
  inspectOperatorRecovery,
} from '../apps/control/src/operator-recovery.js';

async function recoveryRequest(
  op: Operation,
  kind: 'close_create' | 'retry_delete' = 'close_create',
) {
  const inspected = await inspectOperatorRecovery(fixture.connection, op.id);
  const target =
    kind === 'close_create'
      ? inspected.attempts.find(
          (attempt) =>
            ['create', 'create_guest', 'create_primary_ip'].includes(attempt.command.kind) &&
            attempt.resolution.kind === 'pending',
        )
      : inspected.attempts
          .filter((attempt) => ['destroy', 'delete_primary_ip'].includes(attempt.command.kind))
          .at(-1);
  if (!target) throw new Error('Expected a recovery target.');
  return operatorRecoverySchema.parse({
    id: randomUUID(),
    kind,
    operationId: op.id,
    allocationId: inspected.allocation.id,
    accountId: op.accountId,
    attemptId: target.id,
    expectedState: inspected.stateDigest,
    operator: 'fixture-operator',
    evidence: { reference: 'fixture:provider-confirmation', sha256: 'f'.repeat(64) },
    ...(kind === 'close_create'
      ? {
          providerRequestFinished: true,
          resourceIds: inspected.resources
            .filter(
              (resource) =>
                resource.kind ===
                  (target.command.kind === 'create_primary_ip' ? 'primary_ip' : 'server') &&
                resource.labels.operation_id === target.operationId,
            )
            .map((resource) => resource.providerId),
        }
      : {}),
  });
}

async function uncertainCleanup() {
  const created = await create();
  await submitVm(
    created,
    new SimulatedProvider({ db: fixture.connection.db, fault: { kind: 'timeout_before_submit' } }),
  );
  const cleanup = await destroy(created);
  await tick(cleanup);
  return cleanup;
}

async function exhaustedCleanup() {
  const created = await create();
  await until(created, 'succeeded');
  const cleanup = await destroy(created);
  const [server] = await fixture.connection.db
    .select()
    .from(providerResources)
    .where(eq(providerResources.kind, 'server'));
  if (!server) throw new Error('Expected a server.');
  for (let sequence = 1; sequence <= 3; sequence++) {
    const id = newId.attempt();
    await fixture.connection.db.insert(attempts).values({
      id,
      accountId: cleanup.accountId,
      operationId: cleanup.id,
      sequence,
      command: { kind: 'destroy', serverId: server.providerId },
      outcome: { kind: 'prepared' },
      createdAt: new Date(Date.now() - (4 - sequence) * 60_000),
    });
    const error = {
      code: 'provider_rejected',
      message: 'Fixture deletion failure.',
      retryable: true,
    };
    await fixture.connection.db
      .update(attempts)
      .set({ outcome: { kind: 'rejected', error }, resolution: { kind: 'failed', error } })
      .where(eq(attempts.id, id));
  }
  await tick(cleanup);
  return cleanup;
}

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

it('waits for an owned IP assignment to disappear after its server is authoritatively absent', async () => {
  const created = await create();
  await until(created, 'succeeded');
  const [row] = await fixture.connection.db.select().from(simulatedPrimaryIps);
  if (!row) throw new Error('Missing IP.');
  const stale = providerPrimaryIpSchema.parse(row.value);
  let lagging = true;
  class LaggingAssignment extends SimulatedProvider {
    override async getPrimaryIp(input: { primaryIpId: string }) {
      const current = await super.getPrimaryIp(input);
      return current ?? (lagging && input.primaryIpId === stale.id ? stale : null);
    }
  }
  const lagged = new LaggingAssignment({ db: fixture.connection.db });
  const cleanup = await destroy(created);
  for (let count = 0; count < 5; count++) await tick(cleanup, lagged);
  expect((await read(cleanup)).progress).toEqual({
    kind: 'verifying',
    resource: { kind: 'primary_ip', id: stale.id },
  });
  expect(
    (await history()).filter((row) => providerCommandSchema.parse(row.command).kind === 'destroy'),
  ).toHaveLength(1);
  expect(
    (await history()).filter(
      (row) => providerCommandSchema.parse(row.command).kind === 'delete_primary_ip',
    ),
  ).toHaveLength(0);
  expect(
    await fixture.connection.db.select().from(allocations).where(isNull(allocations.retiredAt)),
  ).toHaveLength(1);
  lagging = false;
  await until(cleanup, 'succeeded', lagged);
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

it('records explicit provider closure without changing the source receipt and completes ordinary cleanup', async () => {
  const cleanup = await uncertainCleanup();
  const request = await recoveryRequest(cleanup);
  const original = (await history()).find((attempt) => attempt.id === request.attemptId);
  const applied = await applyOperatorRecovery({
    connection: fixture.connection,
    provider,
    request,
  });
  const closed = (await history()).find((attempt) => attempt.id === request.attemptId);
  expect(closed?.outcome).toEqual(original?.outcome);
  expect(closed?.resolution).toEqual({ kind: 'operator_closed', recoveryId: request.id });
  expect(await fixture.connection.db.select().from(simulatedPrimaryIps)).toHaveLength(1);
  await until(cleanup, 'cancelled');
  await absent();
  expect(
    await applyOperatorRecovery({ connection: fixture.connection, provider, request }),
  ).toEqual(applied);
  await expect(
    applyOperatorRecovery({
      connection: fixture.connection,
      provider,
      request: { ...request, operator: 'different' },
    }),
  ).rejects.toMatchObject({ failure: { code: 'idempotency_conflict' } });
  expect(
    (await history()).filter(
      (attempt) => providerCommandSchema.parse(attempt.command).kind === 'create',
    ),
  ).toHaveLength(1);
});

it('rejects closure without admitted cleanup, cross-allocation scope, stale state and missing attestation', async () => {
  const created = await create();
  await expect(inspectOperatorRecovery(fixture.connection, created.id)).rejects.toMatchObject({
    failure: { code: 'permission_denied' },
  });
  await submitVm(
    created,
    new SimulatedProvider({ db: fixture.connection.db, fault: { kind: 'timeout_before_submit' } }),
  );
  const cleanup = await destroy(created);
  await tick(cleanup);
  const request = await recoveryRequest(cleanup);
  for (const changed of [
    { ...request, allocationId: newId.allocation() },
    { ...request, accountId: newId.account() },
  ])
    await expect(
      applyOperatorRecovery({ connection: fixture.connection, provider, request: changed }),
    ).rejects.toMatchObject({ failure: { code: 'permission_denied' } });
  await expect(
    applyOperatorRecovery({
      connection: fixture.connection,
      provider,
      request: { ...request, expectedState: '0'.repeat(64) },
    }),
  ).rejects.toMatchObject({ failure: { code: 'version_conflict' } });
  expect(
    operatorRecoverySchema.safeParse({ ...request, providerRequestFinished: false }).success,
  ).toBe(false);
  expect(await fixture.connection.db.select().from(operatorRecoveries)).toHaveLength(0);
});

it('serializes operator recovery with the existing machine lock', async () => {
  const cleanup = await uncertainCleanup();
  const request = await recoveryRequest(cleanup);
  await withMachineLock({
    pool: fixture.connection.pool,
    machineId: cleanup.machineId,
    work: async () => {
      await expect(
        applyOperatorRecovery({ connection: fixture.connection, provider, request }),
      ).rejects.toMatchObject({ failure: { code: 'resource_busy' } });
      await expect(inspectOperatorRecovery(fixture.connection, cleanup.id)).rejects.toMatchObject({
        failure: { code: 'resource_busy' },
      });
    },
  });
});

it('retains newly discovered duplicate IDs before rejecting a stale closure request', async () => {
  const created = await create();
  await submitVm(
    created,
    new SimulatedProvider({ db: fixture.connection.db, fault: { kind: 'duplicate_create' } }),
  );
  const cleanup = await destroy(created);
  const request = await recoveryRequest(cleanup);
  await expect(
    applyOperatorRecovery({ connection: fixture.connection, provider, request }),
  ).rejects.toMatchObject({ failure: { code: 'version_conflict' } });
  expect(
    (await fixture.connection.db.select().from(providerResources)).filter(
      (row) => row.kind === 'server',
    ),
  ).toHaveLength(2);
  expect(await fixture.connection.db.select().from(operatorRecoveries)).toHaveLength(0);
  const fresh = await recoveryRequest(cleanup);
  if (fresh.kind !== 'close_create') throw new Error('Expected closure.');
  await expect(
    applyOperatorRecovery({
      connection: fixture.connection,
      provider,
      request: { ...fresh, resourceIds: [] },
    }),
  ).rejects.toMatchObject({ failure: { code: 'invalid_input' } });
  await applyOperatorRecovery({ connection: fixture.connection, provider, request: fresh });
  await until(cleanup, 'cancelled');
  await absent();
  expect(
    (await fixture.connection.db.select().from(providerResources)).filter(
      (row) => row.kind === 'server',
    ),
  ).toHaveLength(2);
});

it('requires absent duplicate IDs in the closure evidence and keeps their absence records', async () => {
  const created = await create();
  await submitVm(
    created,
    new SimulatedProvider({ db: fixture.connection.db, fault: { kind: 'duplicate_create' } }),
  );
  const [ipRow] = await fixture.connection.db.select().from(simulatedPrimaryIps);
  if (!ipRow) throw new Error('Expected an IP.');
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
      { interval: 20 },
    )
    .toBe(0);
  await tick(cleanup);
  const request = await recoveryRequest(cleanup);
  if (request.kind !== 'close_create') throw new Error('Expected closure.');
  expect(request.resourceIds).toHaveLength(2);
  await expect(
    applyOperatorRecovery({
      connection: fixture.connection,
      provider,
      request: { ...request, resourceIds: [] },
    }),
  ).rejects.toMatchObject({ failure: { code: 'invalid_input' } });
  await applyOperatorRecovery({ connection: fixture.connection, provider, request });
  await until(cleanup, 'cancelled');
  await absent();
});

it('does not turn provider read failures into closure', async () => {
  const cleanup = await uncertainCleanup();
  const request = await recoveryRequest(cleanup);
  class FailedInventory extends SimulatedProvider {
    override findServers(): Promise<never> {
      return Promise.reject(new Error('Read unavailable.'));
    }
  }
  await expect(
    applyOperatorRecovery({
      connection: fixture.connection,
      provider: new FailedInventory({ db: fixture.connection.db }),
      request,
    }),
  ).rejects.toThrow('Read unavailable.');
  expect(await fixture.connection.db.select().from(operatorRecoveries)).toHaveLength(0);
  expect((await history()).find((row) => row.id === request.attemptId)?.resolution).toEqual({
    kind: 'pending',
  });
});

it('prevents forged closure and mutation or removal of admitted recovery evidence in SQL', async () => {
  const cleanup = await uncertainCleanup();
  const request = await recoveryRequest(cleanup);
  await expect(
    fixture.connection.db
      .update(attempts)
      .set({ resolution: { kind: 'operator_closed', recoveryId: request.id } })
      .where(eq(attempts.id, request.attemptId)),
  ).rejects.toMatchObject({ cause: { code: '23514' } });
  await applyOperatorRecovery({ connection: fixture.connection, provider, request });
  await expect(
    fixture.connection.db
      .update(operatorRecoveries)
      .set({ request: { ...request, operator: 'other' } }),
  ).rejects.toThrow();
  await expect(fixture.connection.db.delete(operatorRecoveries)).rejects.toThrow();
  await expect(
    fixture.connection.db
      .update(attempts)
      .set({ resolution: { kind: 'pending' } })
      .where(eq(attempts.id, request.attemptId)),
  ).rejects.toThrow();
});

it('grants one additional exact deletion after exhaustion and replays without another allowance', async () => {
  const cleanup = await exhaustedCleanup();
  const request = await recoveryRequest(cleanup, 'retry_delete');
  const original = await history();
  const saved = await applyOperatorRecovery({ connection: fixture.connection, provider, request });
  expect(await history()).toEqual(original);
  expect(
    await applyOperatorRecovery({ connection: fixture.connection, provider, request }),
  ).toEqual(saved);
  const extra = {
    ...request,
    id: operatorRecoverySchema.parse({ ...request, id: randomUUID() }).id,
    expectedState: (await inspectOperatorRecovery(fixture.connection, cleanup.id)).stateDigest,
  };
  await expect(
    applyOperatorRecovery({ connection: fixture.connection, provider, request: extra }),
  ).rejects.toMatchObject({ failure: { code: 'permission_denied' } });
  await until(cleanup, 'succeeded');
  await absent();
  expect(
    (await history()).filter(
      (attempt) => providerCommandSchema.parse(attempt.command).kind === 'destroy',
    ),
  ).toHaveLength(4);
  expect(await fixture.connection.db.select().from(operatorRecoveries)).toHaveLength(1);
});

it('does not grant deletion retry authority to a source create', async () => {
  const cleanup = await uncertainCleanup();
  const request = await recoveryRequest(cleanup);
  const retry = operatorRecoverySchema.parse({
    kind: 'retry_delete',
    id: request.id,
    accountId: request.accountId,
    allocationId: request.allocationId,
    operationId: request.operationId,
    attemptId: request.attemptId,
    expectedState: request.expectedState,
    operator: request.operator,
    evidence: request.evidence,
  });
  await expect(
    applyOperatorRecovery({ connection: fixture.connection, provider, request: retry }),
  ).rejects.toMatchObject({ failure: { code: 'permission_denied' } });
});

it('runs operator inspection and explicit closure through the actual CLI with private input', async () => {
  const cleanup = await uncertainCleanup();
  const directory = await mkdtemp(join(tmpdir(), 'agent-cloud-recovery-'));
  const run = promisify(execFile);
  const env = {
    ...process.env,
    DATABASE_URL: fixture.databaseUrl,
    HCLOUD_TOKEN_FILE: '/missing/provider-token',
    AGENT_CLOUD_RUNTIME: '/missing/runtime',
  };
  try {
    const result = await run(
      process.execPath,
      ['--import', 'tsx', 'scripts/machine-recover.ts', 'inspect', cleanup.id],
      { env },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      operation: { id: cleanup.id },
      stateDigest: (await inspectOperatorRecovery(fixture.connection, cleanup.id)).stateDigest,
    });
    const request = await recoveryRequest(cleanup);
    const path = join(directory, 'request.json');
    await writeFile(path, JSON.stringify(request), { mode: 0o600 });
    const applied = await run(
      process.execPath,
      ['--import', 'tsx', 'scripts/machine-recover.ts', 'apply', path],
      { env },
    );
    expect(JSON.parse(applied.stdout)).toMatchObject({
      id: request.id,
      attemptId: request.attemptId,
    });
    await until(cleanup, 'cancelled');
    await absent();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('keeps a failed extra deletion bounded until another explicit operator decision', async () => {
  const cleanup = await exhaustedCleanup();
  await applyOperatorRecovery({
    connection: fixture.connection,
    provider,
    request: await recoveryRequest(cleanup, 'retry_delete'),
  });
  const previous = (await history())
    .filter((attempt) => providerCommandSchema.parse(attempt.command).kind === 'destroy')
    .at(-1);
  if (!previous) throw new Error('Expected deletion history.');
  const id = newId.attempt();
  // Age only newly inserted fixture history to exercise persisted limits without a 30-second wait.
  await fixture.connection.db.insert(attempts).values({
    id,
    accountId: cleanup.accountId,
    operationId: cleanup.id,
    sequence: 4,
    command: previous.command,
    outcome: { kind: 'prepared' },
    createdAt: new Date(Date.now() - 35_000),
  });
  const error = { code: 'provider_rejected', message: 'Extra deletion failed.', retryable: true };
  await fixture.connection.db
    .update(attempts)
    .set({ outcome: { kind: 'rejected', error }, resolution: { kind: 'failed', error } })
    .where(eq(attempts.id, id));
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
      sequence: 5,
      command: previous.command,
      outcome: { kind: 'prepared' },
    }),
  ).rejects.toMatchObject({ cause: { code: '23514' } });
  await applyOperatorRecovery({
    connection: fixture.connection,
    provider,
    request: await recoveryRequest(cleanup, 'retry_delete'),
  });
  await until(cleanup, 'succeeded');
  await absent();
  expect(
    (await history()).filter(
      (attempt) => providerCommandSchema.parse(attempt.command).kind === 'destroy',
    ),
  ).toHaveLength(5);
});

it('closes an unknown IP submission without submitting a VM', async () => {
  const created = await create();
  await tick(
    created,
    new SimulatedProvider({
      db: fixture.connection.db,
      primaryIpFault: { kind: 'timeout_before_submit' },
    }),
  );
  const cleanup = await destroy(created);
  await tick(cleanup);
  const request = await recoveryRequest(cleanup);
  await applyOperatorRecovery({ connection: fixture.connection, provider, request });
  await until(cleanup, 'cancelled');
  await absent();
  expect(
    (await history()).map((attempt) => providerCommandSchema.parse(attempt.command).kind),
  ).toEqual(['create_primary_ip']);
});

it('blocks operator closure when a retained exact resource now has foreign labels', async () => {
  const created = await create();
  await submitVm(
    created,
    new SimulatedProvider({ db: fixture.connection.db, fault: { kind: 'duplicate_create' } }),
  );
  const cleanup = await destroy(created);
  for (let index = 0; index < 4; index++) await tick(cleanup);
  const [ipRow] = await fixture.connection.db.select().from(simulatedPrimaryIps);
  const ip = providerPrimaryIpSchema.parse(ipRow?.value);
  if (ip.assignment.kind !== 'server') throw new Error('Expected attached source IP.');
  const server = await provider.getServer({ serverId: ip.assignment.serverId });
  if (!server) throw new Error('Expected retained server.');
  await fixture.connection.db
    .update(simulatedServers)
    .set({ value: { ...server, labels: { ...server.labels, account_id: 'foreign' } } })
    .where(eq(simulatedServers.id, server.id));
  const request = await recoveryRequest(cleanup);
  await expect(
    applyOperatorRecovery({ connection: fixture.connection, provider, request }),
  ).rejects.toMatchObject({ failure: { code: 'provider_outcome_unknown' } });
  expect(await fixture.connection.db.select().from(operatorRecoveries)).toHaveLength(0);
});

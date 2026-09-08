import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  simulatedCatalog,
  newId,
  operationResponseSchema,
  grantPolicySchema,
} from '../packages/contracts/src/index.js';
import {
  allocations,
  grants,
  simulatedServers,
  controlRecoveries,
} from '../packages/db/src/index.js';
import { testDatabase, seedAccount } from './database.js';
import { createApp } from '../apps/control/src/app.js';
import { advanceOperation } from '../apps/control/src/advance-operation.js';
import { SimulatedProvider } from '../apps/control/src/simulated-provider.js';
import { openControlFence } from '../apps/control/src/control-fence.js';
import { admitCustomer, createCustomerLogin } from '../apps/control/src/customer-login.js';
import { generateToken, hashToken } from '../apps/control/src/auth.js';
import {
  applyControlRecovery,
  prepareControlGeneration,
  inspectControlOperation,
  controlRecoveryRequestSchema,
} from '../apps/control/src/control-recovery.js';
import { inspectControlRecovery } from '../apps/control/src/control-recovery-inspection.js';

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let outside: Awaited<ReturnType<typeof testDatabase>>;
let directory: string;
const limits = { currency: 'EUR', maxMachines: 20, maxHourlyMicros: 1_000_000 };
const evidence = {
  sha256: 'e'.repeat(64),
  reference: 'fixture:externally-fenced-provider-confirmation',
};
beforeAll(async () => {
  fixture = await testDatabase();
  outside = await testDatabase();
  directory = await mkdtemp(join(tmpdir(), 'acld-control-recovery-'));
});
beforeEach(async () => {
  await fixture.reset();
  await outside.reset();
  await fixture.connection.pool.query('TRUNCATE control_state, control_recoveries');
});
afterAll(async () => {
  try {
    await fixture.close();
    await outside.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
async function target() {
  const path = join(directory, randomUUID());
  return { path, ...(await prepareControlGeneration(path)) };
}
const inventory = () => new SimulatedProvider({ db: outside.connection.db });
function app(checkControl?: () => Promise<void>) {
  return createApp({
    db: fixture.connection.db,
    provider: 'simulated',
    limits,
    catalog: simulatedCatalog,
    ...(checkControl ? { checkControl } : {}),
  });
}
function beginRequest(generation: string) {
  return controlRecoveryRequestSchema.parse({
    kind: 'begin',
    id: randomUUID(),
    generation,
    operator: 'fixture',
    checkpointSha256: 'c'.repeat(64),
    evidence,
    oldProcessesStopped: true,
    oldProviderCredentialsRevoked: true,
    oldSigningCredentialsRevoked: true,
    oldStorageMutatorsFenced: true,
  });
}
async function operator(request: unknown, path: string) {
  const file = join(directory, randomUUID() + '.json');
  await writeFile(file, JSON.stringify(request), { mode: 0o600, flag: 'wx' });
  return promisify(execFile)(
    process.execPath,
    ['apps/control/dist/control-recovery-main.js', 'apply', file],
    {
      env: {
        DATABASE_URL: fixture.databaseUrl,
        PROVIDER: 'simulated',
        ACLD_CONTROL_GENERATION_FILE: path,
      },
      timeout: 10_000,
      maxBuffer: 16_384,
    },
  );
}
async function begin() {
  const next = await target();
  const request = beginRequest(next.generation);
  await operator(request, next.path);
  return { ...next, request };
}
async function apply(request: unknown, path: string) {
  return applyControlRecovery({
    connection: fixture.connection,
    path,
    provider: inventory(),
    request: controlRecoveryRequestSchema.parse(request),
  });
}
async function resume(next: Awaited<ReturnType<typeof begin>>) {
  const inspection = await inspectControlRecovery({
    db: fixture.connection.db,
    provider: inventory(),
  });
  const request = controlRecoveryRequestSchema.parse({
    kind: 'resume',
    id: randomUUID(),
    generation: next.generation,
    recoveryId: next.request.id,
    operator: 'fixture',
    expectedState: inspection.stateDigest,
    expectedInventory: inspection.inventoryDigest,
    evidence,
    postCheckpointEffectsClosed: true,
  });
  return { inspection, request };
}

it('runs the operator CLI, excludes active execution and keeps restored customer admission revoked after resume', async () => {
  const original = await target();
  await operator(
    { kind: 'initialize', id: randomUUID(), generation: original.generation, operator: 'fixture' },
    original.path,
  );
  const owner = await seedAccount(fixture.connection.db);
  const admitted = await admitCustomer(fixture.connection.db, {
    githubUserId: '123456',
    name: 'restored-customer',
    policy: grantPolicySchema.parse(owner.principal.policy),
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  const fence = await openControlFence(fixture.connection, original.path);
  if (!fence) throw new Error('Expected execution fence');
  try {
    const next = await target();
    await expect(
      app(fence.check).request('/v1/whoami', {
        headers: { Authorization: `Bearer ${owner.token}` },
      }),
    ).resolves.toHaveProperty('status', 200);
    await expect(apply(beginRequest(next.generation), next.path)).rejects.toMatchObject({
      failure: { code: 'resource_busy' },
    });
  } finally {
    await fence.close();
  }
  const next = await begin();
  await expect(openControlFence(fixture.connection, next.path)).rejects.toMatchObject({
    failure: { code: 'provider_unavailable' },
  });
  const ready = await resume(next);
  expect(ready.inspection.blockers).toEqual([]);
  await operator(ready.request, next.path);
  const resumed = await openControlFence(fixture.connection, next.path);
  if (!resumed) throw new Error('Expected resumed fence');
  try {
    expect(
      (
        await app(resumed.check).request('/v1/whoami', {
          headers: { Authorization: `Bearer ${owner.token}` },
        })
      ).status,
    ).toBe(401);
    const login = createCustomerLogin({
      db: fixture.connection.db,
      clientId: 'Ov23Fixture123456',
      verify: () => Promise.resolve(admitted.githubUserId),
    });
    await expect(
      login.login('github-test', { id: randomUUID(), tokenHash: hashToken(generateToken()) }),
    ).rejects.toMatchObject({ failure: { code: 'unauthenticated' } });
    const [anchor] = await fixture.connection.db
      .select()
      .from(grants)
      .where(eq(grants.id, admitted.anchorGrantId));
    expect(anchor?.revokedAt).not.toBeNull();
    const fresh = await seedAccount(fixture.connection.db);
    expect(
      (
        await app(resumed.check).request('/v1/projects', {
          method: 'POST',
          headers: { Authorization: `Bearer ${fresh.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'after-recovery' }),
        })
      ).status,
    ).toBe(201);
  } finally {
    await resumed.close();
  }
  await expect(
    fixture.connection.db
      .update(controlRecoveries)
      .set({ request: {} })
      .where(eq(controlRecoveries.id, next.request.id)),
  ).rejects.toThrow();
});

it('never replays a checkpointed queued create and refuses empty inventory until explicit external closure', async () => {
  const owner = await seedAccount(fixture.connection.db);
  const response = await app().request(`/v1/projects/${owner.projectId}/machines`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${owner.token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify({ name: 'checkpointed', size: 'small', region: 'nbg1' }),
  });
  expect(response.status).toBe(202);
  const { operation } = operationResponseSchema.parse(await response.json());
  const [allocation] = await fixture.connection.db
    .select()
    .from(allocations)
    .where(eq(allocations.machineId, operation.machineId));
  if (!allocation) throw new Error('Missing admitted allocation');
  // Provider state belongs to another database, so restoring control state cannot roll it back.
  const delayed = new SimulatedProvider({
    db: outside.connection.db,
    fault: { kind: 'lose_response', visibilityDelayMs: 60_000 },
  });
  expect(
    (
      await delayed.submit({
        attemptId: newId.attempt(),
        command: {
          kind: 'create',
          name: 'late',
          serverType: 'cx23',
          region: 'nbg1',
          network: { kind: 'legacy' },
          labels: {
            managed_by: 'agent-cloud',
            account_id: operation.accountId,
            machine_id: operation.machineId,
            allocation_id: allocation.id,
            operation_id: operation.id,
          },
        },
      })
    ).kind,
  ).toBe('unknown');
  const next = await begin();
  const blocked = await resume(next);
  expect(blocked.inspection.blockers.length).toBeGreaterThan(0);
  await expect(apply(blocked.request, next.path)).rejects.toMatchObject({
    failure: { code: 'resource_busy' },
  });
  await expect(
    promisify(execFile)(process.execPath, ['apps/control/dist/worker.js'], {
      env: {
        DATABASE_URL: fixture.databaseUrl,
        PROVIDER: 'simulated',
        ACLD_CONTROL_GENERATION_FILE: next.path,
      },
      timeout: 10_000,
    }),
  ).rejects.toHaveProperty('code', 1);
  await outside.connection.db.update(simulatedServers).set({ visibleAt: new Date(0) });
  const servers = await inventory().findServers({ labels: { managed_by: 'agent-cloud' } });
  const server = servers[0];
  if (!server) throw new Error('Missing delayed server');
  const inspected = await inspectControlOperation(fixture.connection.db, operation.id);
  const close = {
    kind: 'close_operation',
    id: randomUUID(),
    generation: next.generation,
    recoveryId: next.request.id,
    operationId: operation.id,
    expectedState: inspected.expectedState,
    operator: 'fixture',
    resourceIds: [{ kind: 'server', id: server.id }],
    providerRequestFinished: true,
    allowDataLoss: true,
    evidence,
  };
  await expect(apply(close, next.path)).rejects.toMatchObject({
    failure: { code: 'resource_busy' },
  });
  const deletion = await inventory().submit({
    attemptId: newId.attempt(),
    command: { kind: 'destroy', serverId: server.id },
  });
  if (deletion.kind === 'accepted')
    expect((await inventory().getAction({ actionId: deletion.actionId })).kind).toBe('succeeded');
  expect(await inventory().getServer({ serverId: server.id })).toBeNull();
  await apply(close, next.path);
  expect((await apply(close, next.path)).replayed).toBe(true);
  const ready = await resume(next);
  expect(ready.inspection.blockers).toEqual([]);
  await apply(ready.request, next.path);
  const state = await fixture.connection.pool.query<{ kind: string }>(
    "SELECT progress->>'kind' AS kind FROM operations WHERE id=$1",
    [operation.id],
  );
  expect(state.rows[0]?.kind).toBe('cancelled');
  expect(await inventory().findServers({ labels: { managed_by: 'agent-cloud' } })).toEqual([]);
  expect(
    (await fixture.connection.db.select().from(allocations)).every((row) => row.retiredAt !== null),
  ).toBe(true);
});

it('refuses adoption of an occupied database and a closure without explicit provider evidence', async () => {
  const next = await target();
  await seedAccount(fixture.connection.db);
  await expect(
    apply(
      { kind: 'initialize', id: randomUUID(), generation: next.generation, operator: 'fixture' },
      next.path,
    ),
  ).rejects.toMatchObject({ failure: { code: 'permission_denied' } });
  expect(
    controlRecoveryRequestSchema.safeParse({
      kind: 'resume',
      id: randomUUID(),
      generation: next.generation,
      recoveryId: randomUUID(),
      operator: 'fixture',
      expectedState: 'a'.repeat(64),
      expectedInventory: 'b'.repeat(64),
    }).success,
  ).toBe(false);
  await expect(prepareControlGeneration(next.path)).rejects.toMatchObject({ code: 'EEXIST' });
  await fixture.connection.db.execute(sql`SELECT 1`);
});

it('cannot commit resume after losing the database session that owns its recovery lease', async () => {
  await seedAccount(fixture.connection.db);
  const next = await begin();
  const ready = await resume(next);
  const provider = inventory();
  const entered = Promise.withResolvers<undefined>();
  const proceed = Promise.withResolvers<undefined>();
  const find = provider.findServers.bind(provider);
  provider.findServers = async (request) => {
    entered.resolve(undefined);
    await proceed.promise;
    return find(request);
  };
  const result = applyControlRecovery({
    connection: fixture.connection,
    path: next.path,
    provider,
    request: ready.request,
  });
  const rejected = expect(result).rejects.toThrow();
  try {
    await entered.promise;
    const clients = await fixture.connection.pool.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction' AND pid<>pg_backend_pid()",
    );
    expect(clients.rows).toHaveLength(1);
    const pid = clients.rows[0]?.pid;
    if (!pid) throw new Error('Missing exact recovery transaction.');
    await fixture.connection.pool.query('SELECT pg_terminate_backend($1)', [pid]);
  } finally {
    proceed.resolve(undefined);
  }
  await rejected;
  const state = await fixture.connection.pool.query<{ kind: string }>(
    "SELECT state->>'kind' AS kind FROM control_state WHERE id=1",
  );
  expect(state.rows[0]?.kind).toBe('recovering');
  expect(
    await fixture.connection.db
      .select()
      .from(controlRecoveries)
      .where(eq(controlRecoveries.id, ready.request.id)),
  ).toEqual([]);
});

it('preserves a stable owned machine through recovery and detects a changed exact resource afterward', async () => {
  const owner = await seedAccount(fixture.connection.db);
  const response = await app().request(`/v1/projects/${owner.projectId}/machines`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${owner.token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify({ name: 'retained-app', size: 'small', region: 'nbg1' }),
  });
  const { operation } = operationResponseSchema.parse(await response.json());
  for (let pass = 0; pass < 12; pass++)
    await advanceOperation({
      connection: fixture.connection,
      operationId: operation.id,
      provider: inventory(),
      limits,
    });
  const next = await begin();
  const ready = await resume(next);
  expect(ready.inspection.blockers).toEqual([]);
  await apply(ready.request, next.path);
  const retained = await inventory().findServers({ labels: { managed_by: 'agent-cloud' } });
  expect(retained).toHaveLength(1);
  const server = retained[0];
  if (!server) throw new Error('Expected retained server');
  await outside.connection.db
    .update(simulatedServers)
    .set({
      value: { ...server, labels: { ...server.labels, allocation_id: 'foreign-allocation' } },
    })
    .where(eq(simulatedServers.id, server.id));
  expect(
    (
      await inspectControlRecovery({ db: fixture.connection.db, provider: inventory() })
    ).blockers.some((row) => row.domain === 'inventory'),
  ).toBe(true);
});

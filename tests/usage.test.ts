import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  newId,
  operationResponseSchema,
  reservationHistoryResponseSchema,
  usageResponseSchema,
  simulatedCatalog,
} from '../packages/contracts/src/index.js';
import { allocations, allocationReservations, projects, grants } from '../packages/db/src/index.js';
import { createApp, advanceOperation, SimulatedProvider } from '../apps/control/src/index.js';
import { generateToken, hashToken } from '../apps/control/src/auth.js';
import { seedAccount, testDatabase } from './database.js';

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let owner: Awaited<ReturnType<typeof seedAccount>>;
let app: ReturnType<typeof createApp>;
const limits = { maxMachines: 100, currency: 'EUR', maxHourlyMicros: 1_000_000 };
beforeAll(async () => {
  fixture = await testDatabase();
});
afterAll(async () => {
  await fixture.close();
});
beforeEach(async () => {
  await fixture.reset();
  owner = await seedAccount(fixture.connection.db);
  app = createApp({
    db: fixture.connection.db,
    provider: 'simulated',
    catalog: simulatedCatalog,
    limits,
  });
});
async function read(path: string, token = owner.token) {
  return app.request(path, { headers: { Authorization: `Bearer ${token}` } });
}
async function create(project = owner.projectId, token = owner.token) {
  const response = await app.request(`/v1/projects/${project}/machines`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': newId.operation(),
    },
    body: JSON.stringify({ name: 'usage', size: 'small', region: 'nbg1' }),
  });
  expect(response.status).toBe(202);
  return operationResponseSchema.parse(await response.json()).operation;
}

it('scopes history to the credential projects and account while reporting shared admission limits', async () => {
  await create();
  const foreign = await seedAccount(fixture.connection.db);
  await create(foreign.projectId, foreign.token);
  const allowed = newId.project();
  await fixture.connection.db
    .insert(projects)
    .values({ id: allowed, accountId: owner.principal.accountId, name: 'selected' });
  const selected = await create(allowed);
  const token = generateToken();
  const grantId = newId.grant();
  await fixture.connection.db.insert(grants).values({
    id: grantId,
    accountId: owner.principal.accountId,
    parentId: owner.principal.grantId,
    tokenHash: hashToken(token),
    name: 'usage only',
    expiresAt: new Date(Date.now() + 60_000),
    policy: {
      ...owner.principal.policy,
      capabilities: ['usage:read'],
      projects: { kind: 'selected', ids: [allowed] },
      maxMachines: 1,
      maxHourlyMicros: 10_000,
    },
  });
  const history = reservationHistoryResponseSchema.parse(
    await (await read('/v1/usage/history', token)).json(),
  );
  expect(history.history.map((event) => event.machineId)).toEqual([selected.machineId]);
  const summary = usageResponseSchema.parse(await (await read('/v1/usage', token)).json()).usage;
  expect(summary).toMatchObject({
    scope: 'account',
    activeReservations: 2,
    hourlyMicros: 19200,
    limits: {
      account: { maxMachines: 20 },
      grant: { maxMachines: 1 },
      effective: { maxMachines: 1, maxHourlyMicros: 10000 },
      remainingMachines: 0,
      remainingHourlyMicros: 0,
    },
    backups: { reservedBytes: 0, limits: null },
  });
  await fixture.connection.db
    .update(grants)
    .set({ revokedAt: new Date() })
    .where(eq(grants.id, owner.principal.grantId));
  expect((await read('/v1/usage/history', token)).status).toBe(401);
  expect((await read('/v1/usage', token)).status).toBe(401);
});

it('keeps reservation history atomic, immutable and paginated without duplicate unchanged writes', async () => {
  await create();
  const [allocation] = await fixture.connection.db.select().from(allocations);
  if (!allocation) throw new Error('Missing allocation');
  await fixture.connection.db.update(allocations).set({ hourlyMicros: allocation.hourlyMicros });
  await expect(
    fixture.connection.db.transaction(async (tx) => {
      await tx.update(allocations).set({ hourlyMicros: 11000 });
      throw new Error('rollback');
    }),
  ).rejects.toThrow('rollback');
  expect(await fixture.connection.db.select().from(allocationReservations)).toHaveLength(1);
  // Concurrent writers serialize on the allocation row; each committed rate is retained.
  await Promise.all(
    Array.from({ length: 105 }, (_, i) =>
      fixture.connection.db
        .update(allocations)
        .set({ hourlyMicros: 12000 + i })
        .where(eq(allocations.id, allocation.id)),
    ),
  );
  const first = reservationHistoryResponseSchema.parse(
    await (await read('/v1/usage/history')).json(),
  );
  expect(first.history).toHaveLength(100);
  const second = reservationHistoryResponseSchema.parse(
    await (await read(`/v1/usage/history?before=${first.nextCursor}`)).json(),
  );
  expect(second.history).toHaveLength(6);
  expect(second.nextCursor).toBeNull();
  expect(new Set([...first.history, ...second.history].map((row) => row.id)).size).toBe(106);
  expect((await read('/v1/usage/history?before=9223372036854775808')).status).toBe(400);
  await expect(
    fixture.connection.db.update(allocationReservations).set({ hourlyMicros: 0 }),
  ).rejects.toMatchObject({
    cause: { code: 'P0001', message: 'Allocation reservation history is append-only' },
  });
  await expect(fixture.connection.db.delete(allocationReservations)).rejects.toMatchObject({
    cause: { code: 'P0001', message: 'Allocation reservation history is append-only' },
  });
});

it('releases a rejected queued reservation and rejects missing usage permission', async () => {
  const operation = await create();
  await advanceOperation({
    connection: fixture.connection,
    operationId: operation.id,
    provider: new SimulatedProvider({ db: fixture.connection.db }),
    limits: { ...limits, maxHourlyMicros: 0 },
  });
  const history = reservationHistoryResponseSchema.parse(
    await (await read('/v1/usage/history')).json(),
  );
  expect(history.history.map((event) => event.kind)).toEqual(['released', 'admitted']);
  expect(
    usageResponseSchema.parse(await (await read('/v1/usage')).json()).usage.activeReservations,
  ).toBe(0);
  await fixture.connection.db
    .update(grants)
    .set({ policy: { ...owner.principal.policy, capabilities: ['machine:read'] } });
  expect((await read('/v1/usage/history')).status).toBe(403);
  expect((await read('/v1/usage')).status).toBe(403);
});

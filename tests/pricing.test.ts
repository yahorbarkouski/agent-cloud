import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { eq, isNull, sql } from 'drizzle-orm';
import {
  simulatedCatalog,
  operationResponseSchema,
  operationProgressSchema,
  catalogItemSchema,
} from '../packages/contracts/src/index.js';
import { allocations, attempts, operations, simulatedServers } from '../packages/db/src/index.js';
import { createApp, advanceOperation, SimulatedProvider } from '../apps/control/src/index.js';
import { seedAccount, testDatabase } from './database.js';

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let account: Awaited<ReturnType<typeof seedAccount>>;
let catalog = simulatedCatalog();
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  fixture = await testDatabase();
});
afterAll(async () => {
  await fixture.close();
});
beforeEach(async () => {
  await fixture.reset();
  account = await seedAccount(fixture.connection.db);
  catalog = simulatedCatalog();
  app = createApp({
    db: fixture.connection.db,
    provider: 'simulated',
    catalog: () => catalog,
    limits: { maxMachines: 100, currency: 'EUR', maxHourlyMicros: 1_000_000 },
  });
});
function create(key = 'fixed-pricing-test-key') {
  return app.request(`/v1/projects/${account.projectId}/machines`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${account.token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify({ name: 'pricing-test', size: 'small', region: 'nbg1' }),
  });
}

it('rejects mixed currencies before reserving and still replays admitted work after catalog expiry', async () => {
  catalog = simulatedCatalog('USD');
  expect((await create()).status).toBe(409);
  expect(await fixture.connection.db.select().from(allocations)).toHaveLength(0);
  catalog = simulatedCatalog();
  const original = operationResponseSchema.parse(await (await create()).json());
  catalog.expiresAt = new Date(Date.now() - 1).toISOString();
  expect(operationResponseSchema.parse(await (await create()).json())).toEqual(original);
  expect((await create('different-pricing-test-key')).status).toBe(409); // same live name
});

it('keeps admitted provider choices after a catalog mapping changes and makes no fresh effect', async () => {
  const { operation } = operationResponseSchema.parse(await (await create()).json());
  const [row] = await fixture.connection.db.select().from(operations);
  expect(catalogItemSchema.parse(row?.offer).serverType).toBe('cx23');
  catalog.items = catalog.items.map((item) => ({ ...item, serverType: 'expensive-fallback' }));
  await advanceOperation({
    limits: { currency: catalog.currency, maxMachines: 100, maxHourlyMicros: 10000000 },
    connection: fixture.connection,
    operationId: operation.id,
    provider: new SimulatedProvider({ db: fixture.connection.db, catalog: () => catalog }),
  });
  const [result] = await fixture.connection.db.select().from(operations);
  expect(operationProgressSchema.parse(result?.progress)).toMatchObject({
    kind: 'failed',
    error: { code: 'capacity_unavailable' },
  });
  expect(await fixture.connection.db.select().from(attempts)).toHaveLength(0);
  expect(
    await fixture.connection.db.select().from(allocations).where(isNull(allocations.retiredAt)),
  ).toHaveLength(0);
});

it('blocks a queued price increase but reconciles submitted work after prices or capacity change', async () => {
  const { operation } = operationResponseSchema.parse(await (await create()).json());
  catalog.items = catalog.items.map((item) => ({
    ...item,
    serverHourlyMicros: item.serverHourlyMicros + 1,
    hourlyMicros: item.hourlyMicros + 1,
  }));
  const provider = new SimulatedProvider({ db: fixture.connection.db, catalog: () => catalog });
  await advanceOperation({
    limits: { currency: catalog.currency, maxMachines: 100, maxHourlyMicros: 10000000 },
    connection: fixture.connection,
    operationId: operation.id,
    provider,
  });
  const [failed] = await fixture.connection.db
    .select()
    .from(operations)
    .where(eq(operations.id, operation.id));
  expect(operationProgressSchema.parse(failed?.progress)).toMatchObject({
    kind: 'failed',
    error: { code: 'budget_exceeded' },
  });
  expect(await fixture.connection.db.select().from(simulatedServers)).toHaveLength(0);

  // A separate allocation crosses the external commit boundary before prices become unavailable.
  await fixture.reset();
  account = await seedAccount(fixture.connection.db);
  catalog = simulatedCatalog();
  const second = operationResponseSchema.parse(await (await create()).json()).operation;
  await advanceOperation({
    limits: { currency: catalog.currency, maxMachines: 100, maxHourlyMicros: 10000000 },
    connection: fixture.connection,
    operationId: second.id,
    provider,
  });
  await advanceOperation({
    connection: fixture.connection,
    operationId: second.id,
    provider,
    limits: { currency: 'EUR', maxMachines: 100, maxHourlyMicros: 10000000 },
  });
  await advanceOperation({
    connection: fixture.connection,
    operationId: second.id,
    provider,
    limits: { currency: 'EUR', maxMachines: 100, maxHourlyMicros: 10000000 },
  });
  catalog.items = [];
  await expect
    .poll(
      async () => {
        await advanceOperation({
          limits: { currency: catalog.currency, maxMachines: 100, maxHourlyMicros: 10000000 },
          connection: fixture.connection,
          operationId: second.id,
          provider,
        });
        const [stored] = await fixture.connection.db
          .select()
          .from(operations)
          .where(eq(operations.id, second.id));
        return operationProgressSchema.parse(stored?.progress).kind;
      },
      { timeout: 5000, interval: 20 },
    )
    .toBe('succeeded');
  expect(
    await fixture.connection.db
      .select()
      .from(attempts)
      .where(sql`${attempts.command}->>'kind' = 'create'`),
  ).toHaveLength(1);
});

it('runs admission and usage in USD without interpreting the amounts as EUR', async () => {
  await fixture.reset();
  account = await seedAccount(fixture.connection.db, { currency: 'USD' });
  catalog = simulatedCatalog('USD');
  app = createApp({
    db: fixture.connection.db,
    provider: 'simulated',
    catalog: () => catalog,
    limits: { maxMachines: 100, currency: 'USD', maxHourlyMicros: 1_000_000 },
  });
  const response = await create();
  expect(response.status).toBe(202);
  const { operation } = operationResponseSchema.parse(await response.json());
  const provider = new SimulatedProvider({ db: fixture.connection.db, catalog: () => catalog });
  await expect
    .poll(
      async () => {
        await advanceOperation({
          limits: { currency: catalog.currency, maxMachines: 100, maxHourlyMicros: 10000000 },
          connection: fixture.connection,
          operationId: operation.id,
          provider,
        });
        const [stored] = await fixture.connection.db.select().from(operations);
        return operationProgressSchema.parse(stored?.progress).kind;
      },
      { timeout: 5000, interval: 20 },
    )
    .toBe('succeeded');
  const usage = await app.request('/v1/usage', {
    headers: { Authorization: `Bearer ${account.token}` },
  });
  expect(await usage.json()).toMatchObject({ usage: { currency: 'USD', hourlyMicros: 9600 } });
});

it('requires an explicit account currency and rejects allocations in another denomination in PostgreSQL', async () => {
  await expect(
    fixture.connection.pool.query(
      "INSERT INTO accounts (id,name,max_machines,max_hourly_micros) VALUES ('missing-currency','invalid',1,1000)",
    ),
  ).rejects.toMatchObject({ code: '23502' });
  await expect(
    fixture.connection.pool.query(
      "INSERT INTO accounts (id,name,max_machines,max_hourly_micros,currency) VALUES ('invalid-currency','invalid',1,1000,'usd')",
    ),
  ).rejects.toMatchObject({ code: '23514' });
  expect((await create()).status).toBe(202);
  await expect(
    fixture.connection.db.update(allocations).set({ currency: 'USD' }),
  ).rejects.toThrow();
  await expect(
    fixture.connection.pool.query('UPDATE accounts SET currency=$1 WHERE id=$2', [
      'USD',
      account.principal.accountId,
    ]),
  ).rejects.toMatchObject({ code: '23503' });
  const [allocation] = await fixture.connection.db.select().from(allocations);
  expect(allocation?.currency).toBe('EUR');
});

it('stops queued fresh effects when the worker deployment budget is lowered after admission', async () => {
  const { operation } = operationResponseSchema.parse(await (await create()).json());
  await advanceOperation({
    connection: fixture.connection,
    operationId: operation.id,
    provider: new SimulatedProvider({ db: fixture.connection.db }),
    limits: { currency: 'EUR', maxMachines: 100, maxHourlyMicros: 0 },
  });
  const [stored] = await fixture.connection.db.select().from(operations);
  expect(operationProgressSchema.parse(stored?.progress)).toMatchObject({
    kind: 'failed',
    error: { code: 'budget_exceeded' },
  });
  expect(await fixture.connection.db.select().from(attempts)).toHaveLength(0);
});

it.each(['type', 'region', 'ownership'])(
  'does not complete an accepted create with mismatched provider %s',
  async (mismatch) => {
    const { operation } = operationResponseSchema.parse(await (await create()).json());
    class WrongServer extends SimulatedProvider {
      override async getServer(input: { serverId: string }) {
        const server = await super.getServer(input);
        if (!server) return null;
        return {
          ...server,
          ...(mismatch === 'type' ? { serverType: 'other-type' } : {}),
          ...(mismatch === 'region' ? { region: 'other-region' } : {}),
          ...(mismatch === 'ownership'
            ? { labels: { ...server.labels, account_id: 'another-account' } }
            : {}),
        };
      }
    }
    const provider = new WrongServer({ db: fixture.connection.db });
    for (let i = 0; i < 5; i++)
      await advanceOperation({
        connection: fixture.connection,
        operationId: operation.id,
        provider,
        limits: { currency: 'EUR', maxMachines: 100, maxHourlyMicros: 10000000 },
      });
    const [stored] = await fixture.connection.db.select().from(operations);
    expect(operationProgressSchema.parse(stored?.progress)).toEqual({
      kind: 'blocked',
      reason: 'provider_resource_mismatch',
    });
    expect(
      await fixture.connection.db.select().from(allocations).where(isNull(allocations.retiredAt)),
    ).toHaveLength(1);
    expect(
      await fixture.connection.db
        .select()
        .from(attempts)
        .where(sql`${attempts.command}->>'kind' = 'create'`),
    ).toHaveLength(1);
  },
);

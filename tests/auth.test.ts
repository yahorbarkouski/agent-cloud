import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { setTimeout as delay } from 'node:timers/promises';
import {
  issuedGrantResponseSchema,
  grantPolicySchema,
  newId,
  simulatedCatalog,
} from '../packages/contracts/src/index.js';
import { databaseTime, grants, projects } from '../packages/db/src/index.js';
import { createApp } from '../apps/control/src/app.js';
import { generateToken, hashToken, loadAuthority } from '../apps/control/src/auth.js';
import { testDatabase, seedAccount } from './database.js';

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let account: Awaited<ReturnType<typeof seedAccount>>;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  fixture = await testDatabase();
});
afterAll(async () => {
  await fixture.close();
});
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(async () => {
  await fixture.reset();
  account = await seedAccount(fixture.connection.db);
  app = createApp({
    db: fixture.connection.db,
    provider: 'simulated',
    catalog: simulatedCatalog,
    limits: { maxMachines: 100, currency: 'EUR', maxHourlyMicros: 1_000_000 },
  });
});

function request(input: { path: string; token?: string; body?: unknown; method?: string }) {
  return app.request(input.path, {
    method: input.method ?? (input.body ? 'POST' : 'GET'),
    headers: {
      Authorization: `Bearer ${input.token ?? account.token}`,
      'Content-Type': 'application/json',
    },
    ...(input.body ? { body: JSON.stringify(input.body) } : {}),
  });
}

async function delegate() {
  const policy = grantPolicySchema.parse({
    ...account.principal.policy,
    capabilities: ['machine:read', 'grant:manage'],
    projects: { kind: 'selected', ids: [account.projectId] },
    sizes: ['small'],
    maxMachines: 1,
    currency: 'EUR',
    maxHourlyMicros: 12_000,
  });
  const response = await request({
    path: '/v1/grants',
    body: {
      name: 'delegated',
      policy,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  expect(response.status).toBe(201);
  return { ...issuedGrantResponseSchema.parse(await response.json()).grant, policy };
}

it('prevents delegated credentials from broadening capabilities, projects, or spending', async () => {
  const child = await delegate();
  for (const policy of [
    { ...child.policy, capabilities: ['machine:create'] },
    { ...child.policy, currency: 'USD' },
    { ...child.policy, projects: { kind: 'all' } },
    { ...child.policy, maxMachines: 2 },
    { ...child.policy, currency: 'EUR', maxHourlyMicros: 20_000 },
  ]) {
    expect(
      (
        await request({
          path: '/v1/grants',
          token: child.token,
          body: {
            name: 'escalation',
            policy,
            expiresAt: new Date(Date.now() + 30_000).toISOString(),
          },
        })
      ).status,
    ).toBe(403);
  }
});

it('hides projects outside a delegated credential even within the same account', async () => {
  const child = await delegate();
  const projectId = newId.project();
  await fixture.connection.db
    .insert(projects)
    .values({ id: projectId, accountId: account.principal.accountId, name: 'private' });
  expect(
    (await request({ path: `/v1/projects/${account.projectId}/machines`, token: child.token }))
      .status,
  ).toBe(200);
  expect(
    (await request({ path: `/v1/projects/${projectId}/machines`, token: child.token })).status,
  ).toBe(404);
});

it('propagates parent revocation to descendants without exposing the root to child revocation', async () => {
  const child = await delegate();
  const response = await request({
    path: '/v1/grants',
    token: child.token,
    body: {
      name: 'grandchild',
      policy: child.policy,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    },
  });
  expect(response.status).toBe(201);
  const grandchild = issuedGrantResponseSchema.parse(await response.json()).grant;
  expect(
    (
      await request({
        path: `/v1/grants/${account.principal.grantId}`,
        token: child.token,
        method: 'DELETE',
      })
    ).status,
  ).toBe(404);
  expect((await request({ path: '/v1/whoami', token: grandchild.token })).status).toBe(200);
  expect((await request({ path: `/v1/grants/${child.id}`, method: 'DELETE' })).status).toBe(200);
  expect((await request({ path: '/v1/whoami', token: grandchild.token })).status).toBe(401);
  expect((await request({ path: '/v1/whoami' })).status).toBe(200);
});

it('rejects expired credentials and delegation beyond the parent lifetime', async () => {
  const child = await delegate();
  expect(
    (
      await request({
        path: '/v1/grants',
        token: child.token,
        body: {
          name: 'too-long',
          policy: child.policy,
          expiresAt: new Date(Date.now() + 90_000).toISOString(),
        },
      })
    ).status,
  ).toBe(400);
  await fixture.connection.db
    .update(grants)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(grants.id, child.id));
  expect((await request({ path: '/v1/whoami', token: child.token })).status).toBe(401);
});

it('stores only a credential hash in PostgreSQL', async () => {
  const child = await delegate();
  const [row] = await fixture.connection.db.select().from(grants).where(eq(grants.id, child.id));
  expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(row)).not.toContain(child.token);
});

it('uses database time for authentication and delegation despite host clock skew', async () => {
  const now = await databaseTime(fixture.connection.db);
  for (const offset of [-86_400_000, 172_800_000]) {
    vi.spyOn(Date, 'now').mockReturnValue(now.getTime() + offset);
    expect((await request({ path: '/v1/whoami' })).status).toBe(200);
    const response = await request({
      path: '/v1/grants',
      body: {
        name: 'database-clock',
        policy: account.principal.policy,
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      },
    });
    expect(response.status).toBe(201);
    expect(
      (
        await request({
          path: '/v1/grants',
          body: {
            name: 'already-expired',
            policy: account.principal.policy,
            expiresAt: new Date(now.getTime() - 1000).toISOString(),
          },
        })
      ).status,
    ).toBe(400);
  }
});

it('bounds authority and new delegation by the earliest ancestor expiry', async () => {
  const child = await delegate();
  const now = await databaseTime(fixture.connection.db);
  const horizon = new Date(now.getTime() + 20_000);
  await fixture.connection.db
    .update(grants)
    .set({ expiresAt: horizon })
    .where(eq(grants.id, account.principal.grantId));
  const authority = await loadAuthority(fixture.connection.db, child.id);
  expect(authority.principal.grantId).toBe(child.id);
  expect(authority.expiresAt).toEqual(horizon);
  expect(authority.checkedAt >= now).toBe(true);
  expect(authority.checkedAt <= (await databaseTime(fixture.connection.db))).toBe(true);
  expect(
    (
      await request({
        path: '/v1/grants',
        token: child.token,
        body: {
          name: 'outlives-grandparent',
          policy: child.policy,
          expiresAt: new Date(now.getTime() + 40_000).toISOString(),
        },
      })
    ).status,
  ).toBe(400);
  await fixture.connection.db
    .update(grants)
    .set({ expiresAt: new Date(now.getTime() - 1000) })
    .where(eq(grants.id, account.principal.grantId));
  vi.spyOn(Date, 'now').mockReturnValue(now.getTime() - 86_400_000);
  expect((await request({ path: '/v1/whoami', token: child.token })).status).toBe(401);
});

it('rejects cyclic authority and prevents cross-account grant ancestry in SQL', async () => {
  const child = await delegate();
  await fixture.connection.db
    .update(grants)
    .set({ parentId: child.id })
    .where(eq(grants.id, account.principal.grantId));
  expect((await request({ path: '/v1/whoami', token: child.token })).status).toBe(401);
  const other = await seedAccount(fixture.connection.db);
  await expect(
    fixture.connection.db
      .update(grants)
      .set({ parentId: other.principal.grantId })
      .where(eq(grants.id, child.id)),
  ).rejects.toThrow();
});

it('reads one ancestry snapshot when a parent is revoked during traversal', async () => {
  const child = await delegate();
  await fixture.connection.db.transaction(async (tx) => {
    const backend = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
    const pid = backend.rows[0]?.pid;
    expect(pid).toBeDefined();
    // A session-local view delays each grants statement without modifying other connections.
    await tx.execute(sql`CREATE TEMP VIEW grants AS
      WITH pause AS MATERIALIZED (SELECT pg_sleep(0.3))
      SELECT g.* FROM public.grants g CROSS JOIN pause`);
    const reading = loadAuthority(tx, child.id);
    try {
      let sleeping = false;
      for (let i = 0; i < 100; i++) {
        const activity = await fixture.connection.pool.query<{ sleeping: boolean }>(
          "SELECT wait_event = 'PgSleep' AS sleeping FROM pg_stat_activity WHERE pid = $1",
          [pid],
        );
        if (activity.rows[0]?.sleeping) {
          sleeping = true;
          break;
        }
        await delay(10);
      }
      expect(sleeping).toBe(true);
      await fixture.connection.db
        .update(grants)
        .set({ revokedAt: await databaseTime(fixture.connection.db) })
        .where(eq(grants.id, account.principal.grantId));
      // The already-running statement observes the complete pre-revocation chain.
      expect((await reading).principal.grantId).toBe(child.id);
    } finally {
      await reading.catch(() => undefined);
      await tx.execute(sql`DROP VIEW pg_temp.grants`);
    }
  });
  // Every subsequent decision must observe the committed revocation.
  await expect(loadAuthority(fixture.connection.db, child.id)).rejects.toMatchObject({
    failure: { code: 'unauthenticated' },
  });
});

it('checks expiry after a delayed database traversal completes', async () => {
  await fixture.connection.db.transaction(async (tx) => {
    await tx.execute(sql`CREATE TEMP VIEW grants AS
      WITH pause AS MATERIALIZED (SELECT pg_sleep(0.3))
      SELECT g.* FROM public.grants g CROSS JOIN pause`);
    const now = await databaseTime(tx);
    await tx.execute(sql`UPDATE public.grants SET expires_at = ${new Date(now.getTime() + 100)}
      WHERE id = ${account.principal.grantId}`);
    try {
      await expect(loadAuthority(tx, account.principal.grantId)).rejects.toMatchObject({
        failure: { code: 'unauthenticated' },
      });
    } finally {
      await tx.execute(sql`DROP VIEW pg_temp.grants`);
    }
  });
});

it('accepts a complete 32-grant chain and refuses a truncated deeper chain', async () => {
  const expiresAt = new Date((await databaseTime(fixture.connection.db)).getTime() + 60_000);
  let parentId = account.principal.grantId;
  for (let depth = 2; depth <= 33; depth++) {
    const id = newId.grant();
    await fixture.connection.db.insert(grants).values({
      id,
      parentId,
      accountId: account.principal.accountId,
      name: `depth-${depth}`,
      tokenHash: hashToken(generateToken()),
      policy: account.principal.policy,
      expiresAt,
    });
    parentId = id;
    if (depth === 32) {
      expect((await loadAuthority(fixture.connection.db, id)).principal.grantId).toBe(id);
    }
  }
  await expect(loadAuthority(fixture.connection.db, parentId)).rejects.toMatchObject({
    failure: { code: 'unauthenticated' },
  });
});

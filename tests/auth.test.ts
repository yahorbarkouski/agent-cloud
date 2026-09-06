import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  issuedGrantResponseSchema,
  grantPolicySchema,
  newId,
} from '../packages/contracts/src/index.js';
import { grants, projects } from '../packages/db/src/index.js';
import { createApp } from '../apps/control/src/app.js';
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
beforeEach(async () => {
  await fixture.reset();
  account = await seedAccount(fixture.connection.db);
  app = createApp({
    db: fixture.connection.db,
    provider: 'simulated',
    limits: { maxMachines: 100, maxHourlyMicroEur: 1_000_000 },
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
    maxHourlyMicroEur: 12_000,
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
    { ...child.policy, projects: { kind: 'all' } },
    { ...child.policy, maxMachines: 2 },
    { ...child.policy, maxHourlyMicroEur: 20_000 },
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

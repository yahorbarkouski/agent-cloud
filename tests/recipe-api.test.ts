import { serve } from '@hono/node-server';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../apps/control/src/app.js';
import { recipes } from '../packages/recipes/src/catalog.js';
import { CloudClient } from '../packages/sdk/src/index.js';
import { grants } from '../packages/db/src/index.js';
import { simulatedCatalog } from '../packages/contracts/src/index.js';
import { seedAccount, testDatabase } from './database.js';

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let owner: Awaited<ReturnType<typeof seedAccount>>;
let server: ReturnType<typeof serve>;
let client: CloudClient;
let endpoint: string;
beforeAll(async () => {
  fixture = await testDatabase();
  owner = await seedAccount(fixture.connection.db);
  const app = createApp({
    db: fixture.connection.db,
    provider: 'simulated',
    catalog: simulatedCatalog,
    limits: { maxMachines: 100, currency: 'EUR', maxHourlyMicros: 1_000_000 },
  });
  server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture API address.');
  endpoint = `http://127.0.0.1:${address.port}`;
  client = new CloudClient({ server: endpoint, token: owner.token });
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    }),
  );
  await fixture.close();
});
it('discovers exactly the packaged catalog through the authenticated API and SDK', async () => {
  expect((await fetch(`${endpoint}/v1/recipes`)).status).toBe(401);
  expect((await client.recipes()).recipes).toEqual(recipes);
  expect((await client.recipe('umami', '1.0.0')).recipe).toEqual(recipes[1]);
  await expect(client.recipe('umami', '99.0.0')).rejects.toMatchObject({
    failure: { code: 'not_found' },
  });
});
it('uses normal grant revocation for recipe API access', async () => {
  await fixture.connection.db
    .update(grants)
    .set({ revokedAt: new Date() })
    .where(eq(grants.id, owner.principal.grantId));
  await expect(client.recipes()).rejects.toMatchObject({ failure: { code: 'unauthenticated' } });
});

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { capabilitiesResponseSchema } from '../packages/contracts/src/index.js';
import { CloudClient } from '../packages/sdk/src/index.js';
import { grants } from '../packages/db/src/index.js';
import { createApp } from '../apps/control/src/app.js';
import { createHosting } from '../apps/control/src/hosting.js';
import { createBackups } from '../apps/control/src/backups.js';
import { backupControlConfigSchema } from '../apps/control/src/backup-records.js';
import { seedAccount, testDatabase } from './database.js';

type AppInput = Parameters<typeof createApp>[0];
let fixture: Awaited<ReturnType<typeof testDatabase>>;
let owner: Awaited<ReturnType<typeof seedAccount>>;
let app: ReturnType<typeof createApp>;
let server: ReturnType<typeof serve>;
let endpoint: string;
let client: CloudClient;
const unavailable = vi.fn((): never => {
  throw new Error('Feature I/O must not run during discovery.');
});
const baseline = {
  protocolVersion: 1,
  provider: 'simulated',
  configured: {
    machineLifecycle: true,
    ssh: false,
    files: false,
    durableCommands: false,
    compose: false,
    routing: false,
    protectedBackups: false,
    recipes: true,
  },
};
function makeApp(extra: Partial<AppInput> = {}) {
  return createApp({
    db: fixture.connection.db,
    provider: 'simulated',
    catalog: unavailable,
    limits: { maxMachines: 100, currency: 'EUR', maxHourlyMicros: 1_000_000 },
    ...extra,
  });
}
function services() {
  const access = {
    admit: unavailable,
    inspect: unavailable,
    issue: unavailable,
    enqueue: unavailable,
    authenticateGateway: unavailable,
    claim: unavailable,
    check: unavailable,
    close: unavailable,
  } satisfies NonNullable<AppInput['access']>;
  const hosting = {
    service: createHosting({
      db: fixture.connection.db,
      config: {
        version: 1,
        applicationDomain: 'apps.private.example',
        gatewayTokenFile: '/private/gateway-token',
        gatewayAddresses: ['192.0.2.10'],
        gatewayOrigin: 'https://private-gateway.example',
      },
      resolve: unavailable,
      applyGuest: unavailable,
    }),
    gatewayToken: 'acld_hosting_' + 'a'.repeat(43),
  };
  const backups = createBackups({
    db: fixture.connection.db,
    advance: unavailable,
    config: backupControlConfigSchema.parse({
      version: 1,
      directory: '/private/backup-scratch',
      store: {
        endpoint: 'https://private-store.example',
        region: 'test-1',
        bucket: 'private-bucket',
        keyPrefix: 'protected',
        maxBytes: 1_048_576,
      },
      writerCredentialsFile: '/private/writer',
      readerCredentialsFile: '/private/reader',
      keyringFile: '/private/keyring',
      limits: { maxBytes: 1_048_576, timeoutSeconds: 30 },
      maxGlobalBytes: 1_048_576,
    }),
  });
  return { access, hosting, backups };
}
beforeAll(async () => {
  fixture = await testDatabase();
  server = serve({ fetch: (request) => app.fetch(request), hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing capability API address.');
  endpoint = `http://127.0.0.1:${address.port}`;
});
beforeEach(async () => {
  await fixture.reset();
  owner = await seedAccount(fixture.connection.db);
  app = makeApp();
  client = new CloudClient({ server: endpoint, token: owner.token });
  unavailable.mockClear();
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

it('uses normal authentication and revocation for API and SDK discovery', async () => {
  expect((await fetch(`${endpoint}/v1/capabilities`)).status).toBe(401);
  const response = await fetch(`${endpoint}/v1/capabilities`, {
    headers: { Authorization: `Bearer ${owner.token}` },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual(baseline);
  expect(await client.capabilities()).toEqual(baseline);
  await fixture.connection.db
    .update(grants)
    .set({ revokedAt: new Date() })
    .where(eq(grants.id, owner.principal.grantId));
  await expect(client.capabilities()).rejects.toMatchObject({
    failure: { code: 'unauthenticated' },
  });
});

it('derives each optional feature from injected services without inspecting readiness or private configuration', async () => {
  const configured = services();
  const cases = [
    {
      extra: { access: configured.access },
      enabled: { ssh: true, files: true, durableCommands: true, compose: true },
    },
    { extra: { hosting: configured.hosting }, enabled: { routing: true } },
    { extra: { backups: configured.backups }, enabled: { protectedBackups: true } },
  ];
  for (const { extra, enabled } of cases) {
    app = makeApp({ ...extra, provider: 'hetzner', internalReference: unavailable });
    expect(await client.capabilities()).toEqual({
      ...baseline,
      provider: 'hetzner',
      configured: { ...baseline.configured, ...enabled },
    });
  }
  expect(unavailable).not.toHaveBeenCalled();
});

it('keeps configured features separate from the current principal policy', async () => {
  await fixture.connection.db
    .update(grants)
    .set({ policy: { ...owner.principal.policy, capabilities: [] } })
    .where(eq(grants.id, owner.principal.grantId));
  app = makeApp(services());
  expect(await client.capabilities()).toEqual({
    ...baseline,
    configured: {
      machineLifecycle: true,
      ssh: true,
      files: true,
      durableCommands: true,
      compose: true,
      routing: true,
      protectedBackups: true,
      recipes: true,
    },
  });
  expect((await client.whoami()).principal.policy.capabilities).toEqual([]);
  expect(unavailable).not.toHaveBeenCalled();
});

it('does not expose capabilities in an image factory even when services are injected', async () => {
  app = makeApp({ ...services(), customerAccess: 'disabled' });
  await expect(client.capabilities()).rejects.toMatchObject({
    failure: { code: 'permission_denied' },
  });
  expect((await fetch(`${endpoint}/v1/capabilities`)).status).toBe(403);
  expect(unavailable).not.toHaveBeenCalled();
});

it('validates protocol versions and complete feature declarations in SDK responses', async () => {
  for (const response of [
    { ...baseline, protocolVersion: 2 },
    { ...baseline, provider: 'unknown' },
    { ...baseline, configured: { machineLifecycle: true } },
    { ...baseline, principal: owner.principal },
  ]) {
    const malformed = new CloudClient({
      server: endpoint,
      token: owner.token,
      transport: () => Promise.resolve(Response.json(response)),
    });
    await expect(malformed.capabilities()).rejects.toThrow();
    expect(capabilitiesResponseSchema.safeParse(response).success).toBe(false);
  }
});

it('prints the authenticated capability document through the built CLI', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-cloud-capabilities-'));
  try {
    const credentials = join(directory, 'credentials.json');
    await writeFile(credentials, JSON.stringify({ server: endpoint, token: owner.token }), {
      mode: 0o600,
      flag: 'wx',
    });
    const result = await promisify(execFile)(
      process.execPath,
      ['apps/cli/dist/index.js', 'capabilities'],
      {
        env: { ...process.env, ACLD_CREDENTIALS: credentials },
        timeout: 10_000,
        maxBuffer: 16_384,
      },
    );
    expect(JSON.parse(result.stdout)).toEqual(baseline);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain(owner.token);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

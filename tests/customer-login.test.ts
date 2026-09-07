import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  credentialsSchema,
  simulatedCatalog,
  whoamiResponseSchema,
} from '../packages/contracts/src/index.js';
import { CloudClient, exchangeGithubLogin } from '../packages/sdk/src/index.js';
import { grants } from '../packages/db/src/index.js';
import { createApp } from '../apps/control/src/app.js';
import {
  admitCustomer,
  createCustomerLogin,
  disableCustomer,
  renewCustomer,
} from '../apps/control/src/customer-login.js';
import { generateToken, hashToken } from '../apps/control/src/auth.js';
import { githubIdentityVerifier } from '../apps/control/src/github-identity.js';
import { loginWithDevice, logout } from '../apps/cli/src/login.js';
import { withCredentialLock } from '../apps/cli/src/credential-file.js';
import { seedAccount, testDatabase } from './database.js';

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let seed: Awaited<ReturnType<typeof seedAccount>>;
let server: ReturnType<typeof serve>;
let scratch: string;
let endpoint: string;
const githubToken = `gho_${'x'.repeat(36)}`;
const clientId = 'testClientId12345';
let identity = '12345';
let loseExchange = false;
const originalFetch = globalThis.fetch;
const expiry = () => new Date(Date.now() + 60 * 60_000);
const credential = () => {
  const token = generateToken();
  return { token, request: { id: randomUUID(), tokenHash: hashToken(token) } };
};
const errorCode = (code: string) => ({ failure: { code } });

beforeAll(async () => {
  fixture = await testDatabase();
  seed = await seedAccount(fixture.connection.db);
  scratch = await mkdtemp(join(tmpdir(), 'acld-customer-login-'));
  const app = createApp({
    db: fixture.connection.db,
    provider: 'simulated',
    catalog: simulatedCatalog,
    limits: { maxMachines: 100, currency: 'EUR', maxHourlyMicros: 1_000_000 },
    login: createCustomerLogin({
      db: fixture.connection.db,
      clientId,
      verify: () => Promise.resolve(identity),
    }),
  });
  server = serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const response = await app.fetch(request);
      if (loseExchange && new URL(request.url).pathname === '/auth/github' && response.ok)
        return new Response('lost reply', { status: 502 });
      return response;
    },
  });
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing API address.');
  endpoint = `http://127.0.0.1:${address.port}`;
  await admitCustomer(fixture.connection.db, {
    githubUserId: identity,
    name: 'preview-customer',
    policy: seed.principal.policy,
    expiresAt: expiry(),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  loseExchange = false;
  identity = '12345';
});
afterAll(async () => {
  if ('closeAllConnections' in server) server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    }),
  );
  await fixture.close();
  await rm(scratch, { recursive: true, force: true });
});

async function cli(args: string[], path: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      ['apps/cli/dist/index.js', ...args],
      { env: { ...process.env, ACLD_CREDENTIALS: path }, timeout: 10_000 },
      (error, stdout, stderr) => {
        resolve({ code: error ? 1 : 0, stdout, stderr });
      },
    );
  });
}
function deviceFlow(authorized: () => Promise<void> = async () => {}) {
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.stubGlobal(
    'fetch',
    async (url: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
      if (
        (url instanceof Request ? url.url : url.toString()) ===
        'https://github.com/login/device/code'
      )
        return Response.json({
          device_code: 'device-code-123456789012345',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          expires_in: 60,
          interval: 1,
        });
      if (
        (url instanceof Request ? url.url : url.toString()) ===
        'https://github.com/login/oauth/access_token'
      ) {
        await authorized();
        return Response.json({ access_token: githubToken, token_type: 'bearer' });
      }
      return originalFetch(url, options);
    },
  );
  return stderr;
}

it('signs in through device protocol and real HTTP, delegates through CLI, and revokes descendants on logout', async () => {
  const output = deviceFlow();
  const path = join(scratch, 'nested', 'customer.json');
  const result = await loginWithDevice(endpoint, path);
  expect(result.principal.accountId).not.toBe(seed.principal.accountId);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  const saved = credentialsSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  const who = await cli(['whoami'], path);
  expect(who.code, who.stderr).toBe(0);
  expect(whoamiResponseSchema.parse(JSON.parse(who.stdout)).principal).toEqual(result.principal);
  const policy = join(scratch, 'reader-policy.json');
  await writeFile(
    policy,
    JSON.stringify({
      ...result.principal.policy,
      capabilities: ['project:read'],
      maxMachines: 0,
      maxHourlyMicros: 0,
    }),
  );
  const childPath = join(scratch, 'agent.json');
  const child = await cli(
    [
      'grant',
      'create',
      'existing-agent',
      '--policy',
      policy,
      '--expires-at',
      new Date(Date.now() + 10 * 60_000).toISOString(),
      '--credentials',
      childPath,
    ],
    path,
  );
  expect(child.code, child.stderr).toBe(0);
  expect((await cli(['project', 'list'], childPath)).code).toBe(0);
  expect((await cli(['grant', 'revoke', result.principal.grantId], childPath)).code).toBe(1);
  // A reader can revoke itself without receiving grant-management authority.
  expect((await cli(['logout'], childPath)).code).toBe(0);
  const child2 = await cli(
    [
      'grant',
      'create',
      'another-agent',
      '--policy',
      policy,
      '--expires-at',
      new Date(Date.now() + 10 * 60_000).toISOString(),
      '--credentials',
      childPath,
    ],
    path,
  );
  expect(child2.code, child2.stderr).toBe(0);
  expect((await cli(['logout'], path)).code).toBe(0);
  expect((await cli(['whoami'], childPath)).code).toBe(1);
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(JSON.stringify([output.mock.calls, result, who, child, child2])).not.toContain(
    saved.token,
  );
  expect(JSON.stringify(output.mock.calls)).not.toContain(githubToken);
});

it('recovers a committed sign-in with a lost response using the previously saved token', async () => {
  deviceFlow();
  loseExchange = true;
  const path = join(scratch, 'lost.json');
  expect((await loginWithDevice(endpoint, path)).recovered).toBe(true);
  const before = await readFile(path, 'utf8');
  expect((await loginWithDevice(endpoint, path)).recovered).toBe(true);
  expect(await readFile(path, 'utf8')).toBe(before);
});

it('serializes logout against a pending device login across processes', async () => {
  const ready = Promise.withResolvers<undefined>();
  const proceed = Promise.withResolvers<undefined>();
  deviceFlow(async () => {
    ready.resolve(undefined);
    await proceed.promise;
  });
  const path = join(scratch, 'pending.json');
  const pending = loginWithDevice(endpoint, path);
  await ready.promise;
  try {
    const attempt = await cli(['logout'], path);
    expect(attempt.code).toBe(1);
    expect(JSON.parse(attempt.stderr)).toMatchObject({ error: { code: 'version_conflict' } });
    expect((await stat(path)).isFile()).toBe(true);
  } finally {
    proceed.resolve(undefined);
  }
  await pending;
  expect((await cli(['whoami'], path)).code).toBe(0);
  await logout(path);
});

it('resumes an existing pending credential and refuses lock aliases and insecure files', async () => {
  deviceFlow();
  const path = join(scratch, 'retry.json');
  const saved = { server: endpoint, token: generateToken(), loginId: randomUUID() };
  await writeFile(path, JSON.stringify(saved), { mode: 0o600 });
  expect((await loginWithDevice(endpoint, path)).recovered).toBe(false);
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(saved);
  await withCredentialLock(path, async () => {
    await expect(
      withCredentialLock(join(scratch, '.', 'retry.json'), async () => {}),
    ).rejects.toMatchObject(errorCode('version_conflict'));
  });
  const insecure = join(scratch, 'insecure.json');
  await writeFile(insecure, JSON.stringify(saved), { mode: 0o644 });
  await expect(loginWithDevice(endpoint, insecure)).rejects.toMatchObject(
    errorCode('permission_denied'),
  );
});

it('binds concurrent issuance and replay to one identity, account and token hash', async () => {
  const input = credential();
  const exchange = () =>
    exchangeGithubLogin({ server: endpoint, token: githubToken, request: input.request });
  const results = await Promise.all([exchange(), exchange(), exchange()]);
  expect(new Set(results.map((r) => r.principal.grantId)).size).toBe(1);
  await expect(
    exchangeGithubLogin({
      server: endpoint,
      token: githubToken,
      request: { ...input.request, tokenHash: hashToken(generateToken()) },
    }),
  ).rejects.toMatchObject(errorCode('idempotency_conflict'));
  await expect(
    exchangeGithubLogin({
      server: endpoint,
      token: githubToken,
      request: { ...input.request, id: randomUUID() },
    }),
  ).rejects.toMatchObject(errorCode('idempotency_conflict'));
  identity = '54321';
  await admitCustomer(fixture.connection.db, {
    githubUserId: identity,
    name: 'other',
    policy: seed.principal.policy,
    expiresAt: expiry(),
  });
  await expect(exchange()).rejects.toMatchObject(errorCode('idempotency_conflict'));
  identity = '12345';
  const client = new CloudClient({ server: endpoint, token: input.token });
  const { principal } = await client.whoami();
  await client.revokeGrant(principal.grantId);
  await expect(exchange()).rejects.toMatchObject(errorCode('unauthenticated'));
});

it('denies unknown identities, expired admission and disabled admission without creating accounts', async () => {
  identity = '99999';
  const input = credential();
  const exchange = () =>
    exchangeGithubLogin({ server: endpoint, token: githubToken, request: input.request });
  await expect(exchange()).rejects.toMatchObject(errorCode('permission_denied'));
  const admitted = await admitCustomer(fixture.connection.db, {
    githubUserId: identity,
    name: 'expired',
    policy: seed.principal.policy,
    expiresAt: expiry(),
  });
  await fixture.connection.db
    .update(grants)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(grants.id, admitted.anchorGrantId));
  await expect(exchange()).rejects.toMatchObject(errorCode('unauthenticated'));
  identity = '54321';
  await disableCustomer(fixture.connection.db, identity);
  await expect(exchange()).rejects.toMatchObject(errorCode('unauthenticated'));
});

it('verifies GitHub app binding, public identity scope and bounded provider replies', async () => {
  const config = { clientId, clientSecret: 'test-secret-123456789012345' };
  const reply = { app: { client_id: clientId }, user: { id: 12345, type: 'User' }, scopes: [] };
  const transport = vi.fn<typeof fetch>(() => Promise.resolve(Response.json(reply)));
  expect(await githubIdentityVerifier(config, transport)(githubToken)).toBe('12345');
  expect(transport.mock.calls[0]?.[0]).toBe(
    `https://api.github.com/applications/${clientId}/token`,
  );
  await expect(
    githubIdentityVerifier(config, () => Promise.resolve(new Response('', { status: 404 })))(
      githubToken,
    ),
  ).rejects.toMatchObject(errorCode('unauthenticated'));
  await expect(
    githubIdentityVerifier(config, () =>
      Promise.resolve(Response.json({ ...reply, app: { client_id: 'differentApp' } })),
    )(githubToken),
  ).rejects.toBeInstanceOf(z.ZodError);
  await expect(
    githubIdentityVerifier(config, () =>
      Promise.resolve(Response.json({ ...reply, scopes: ['repo'] })),
    )(githubToken),
  ).rejects.toMatchObject(errorCode('permission_denied'));
  await expect(
    githubIdentityVerifier(config, () => Promise.resolve(new Response('x'.repeat(65_537))))(
      githubToken,
    ),
  ).rejects.toMatchObject(errorCode('provider_unavailable'));
  await expect(
    githubIdentityVerifier(config, transport)('ghp_personalAccessToken'),
  ).rejects.toBeInstanceOf(z.ZodError);
});

it('renews admission with a new authority, preserving the account and invalidating old sessions', async () => {
  const githubUserId = '88888';
  const admitted = await admitCustomer(fixture.connection.db, {
    githubUserId,
    name: 'renewal',
    policy: seed.principal.policy,
    expiresAt: expiry(),
  });
  const service = createCustomerLogin({
    db: fixture.connection.db,
    clientId,
    verify: () => Promise.resolve(githubUserId),
  });
  const before = credential();
  const old = await service.login(githubToken, before.request);
  const renewed = await renewCustomer(fixture.connection.db, {
    githubUserId,
    expectedAnchorGrantId: admitted.anchorGrantId,
    policy: { ...seed.principal.policy, maxMachines: 1 },
    expiresAt: expiry(),
  });
  expect(renewed.accountId).toBe(admitted.accountId);
  expect(renewed.anchorGrantId).not.toBe(admitted.anchorGrantId);
  await expect(
    new CloudClient({ server: endpoint, token: before.token }).whoami(),
  ).rejects.toMatchObject(errorCode('unauthenticated'));
  await expect(service.login(githubToken, before.request)).rejects.toMatchObject(
    errorCode('unauthenticated'),
  );
  await expect(
    renewCustomer(fixture.connection.db, {
      githubUserId,
      expectedAnchorGrantId: admitted.anchorGrantId,
      policy: seed.principal.policy,
      expiresAt: expiry(),
    }),
  ).rejects.toMatchObject(errorCode('version_conflict'));
  const fresh = await service.login(githubToken, credential().request);
  expect(fresh.principal.accountId).toBe(old.principal.accountId);
  expect(fresh.principal.policy.maxMachines).toBe(1);
  expect(new Date(fresh.expiresAt).getTime()).toBeLessThanOrEqual(
    new Date(renewed.expiresAt).getTime(),
  );
  await disableCustomer(fixture.connection.db, githubUserId);
  await expect(service.login(githubToken, credential().request)).rejects.toMatchObject(
    errorCode('unauthenticated'),
  );
});

it('bounds persisted login issuance and never exposes sign-in in an image factory', async () => {
  const githubUserId = '77777';
  await admitCustomer(fixture.connection.db, {
    githubUserId,
    name: 'bounded',
    policy: seed.principal.policy,
    expiresAt: expiry(),
  });
  const service = createCustomerLogin({
    db: fixture.connection.db,
    clientId,
    verify: () => Promise.resolve(githubUserId),
  });
  for (let index = 0; index < 20; index++) await service.login(githubToken, credential().request);
  await expect(service.login(githubToken, credential().request)).rejects.toMatchObject(
    errorCode('quota_exceeded'),
  );
  const app = createApp({
    db: fixture.connection.db,
    provider: 'simulated',
    catalog: simulatedCatalog,
    limits: { maxMachines: 0, currency: 'EUR', maxHourlyMicros: 0 },
    customerAccess: 'disabled',
    login: service,
  });
  expect((await app.request('/auth/config')).status).toBe(404);
  expect((await app.request('/auth/github', { method: 'POST' })).status).toBe(404);
});

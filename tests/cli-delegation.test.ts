import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import {
  credentialsSchema,
  grantsResponseSchema,
  grantIdSchema,
  projectsResponseSchema,
  whoamiResponseSchema,
  simulatedCatalog,
} from '../packages/contracts/src/index.js';
import { createApp } from '../apps/control/src/app.js';
import { seedAccount, testDatabase } from './database.js';

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let owner: Awaited<ReturnType<typeof seedAccount>>;
let foreign: Awaited<ReturnType<typeof seedAccount>>;
let server: ReturnType<typeof serve>;
let scratch: string;
let endpoint: string;
let ownerFile: string;
const issuedSchema = z.object({
  grant: z.object({ id: grantIdSchema, expiresAt: z.iso.datetime() }),
  credentialsFile: z.string(),
});
const expiry = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const secrets: string[] = [];

async function cli(args: string[], credentials = ownerFile, stdin = '') {
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(
      process.execPath,
      ['apps/cli/dist/index.js', ...args],
      {
        env: { ...process.env, ACLD_CREDENTIALS: credentials },
        timeout: 20_000,
        maxBuffer: 1_048_576,
      },
      (error, stdout, stderr) => {
        resolve({ code: error ? 1 : 0, stdout, stderr });
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(stdin);
  });
  expect(/acld_[A-Za-z0-9_-]{43}/.test(result.stdout)).toBe(false);
  expect(/acld_[A-Za-z0-9_-]{43}/.test(result.stderr)).toBe(false);
  for (const secret of secrets) {
    expect(result.stdout.includes(secret)).toBe(false);
    expect(result.stderr.includes(secret)).toBe(false);
  }
  return result;
}
async function success(args: string[], credentials = ownerFile, stdin = ''): Promise<unknown> {
  const result = await cli(args, credentials, stdin);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
async function denied(args: string[], code: string, credentials: string) {
  const result = await cli(args, credentials);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stderr)).toMatchObject({ error: { code } });
}

beforeAll(async () => {
  fixture = await testDatabase();
  owner = await seedAccount(fixture.connection.db);
  foreign = await seedAccount(fixture.connection.db);
  secrets.push(owner.token, foreign.token);
  scratch = await mkdtemp(join(tmpdir(), 'acld-delegation-'));
  ownerFile = join(scratch, 'owner.json');
  const app = createApp({
    db: fixture.connection.db,
    provider: 'simulated',
    catalog: simulatedCatalog,
    limits: { maxMachines: 100, currency: 'EUR', maxHourlyMicros: 1_000_000 },
  });
  server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local API address.');
  endpoint = `http://127.0.0.1:${address.port}`;
  await success(['login', '--server', endpoint, '--token-stdin'], ownerFile, owner.token);
});
afterAll(async () => {
  if ('closeAllConnections' in server) server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    }),
  );
  await rm(scratch, { recursive: true, force: true });
  await fixture.close();
});

it('delegates one project through real CLI/HTTP and revokes the entire descendant tree', async () => {
  const childFile = join(scratch, 'new-directory', 'nested', 'child.json');
  const grandchildFile = join(scratch, 'grandchild.json');
  const policyFile = join(scratch, 'policy.json');
  const policy = {
    ...owner.principal.policy,
    capabilities: ['project:read', 'machine:read', 'grant:manage'],
    projects: { kind: 'selected', ids: [owner.projectId] },
    maxMachines: 0,
    maxHourlyMicros: 0,
  };
  await writeFile(policyFile, JSON.stringify(policy));
  const child = issuedSchema.parse(
    await success([
      'grant',
      'create',
      'project-reader',
      '--policy',
      policyFile,
      '--expires-at',
      expiry(10),
      '--credentials',
      childFile,
    ]),
  );
  const childCredentials = credentialsSchema.parse(JSON.parse(await readFile(childFile, 'utf8')));
  secrets.push(childCredentials.token);
  expect((await stat(childFile)).mode & 0o777).toBe(0o600);
  expect(whoamiResponseSchema.parse(await success(['whoami'], childFile)).principal.grantId).toBe(
    child.grant.id,
  );
  expect(
    projectsResponseSchema
      .parse(await success(['project', 'list'], childFile))
      .projects.map((p) => p.id),
  ).toEqual([owner.projectId]);
  await success(['machine', 'list', '--project', owner.projectId], childFile);
  await denied(['machine', 'list', '--project', foreign.projectId], 'not_found', childFile);
  await denied(['project', 'create', 'forbidden'], 'permission_denied', childFile);
  await denied(['grant', 'revoke', owner.principal.grantId], 'not_found', childFile);
  await denied(['grant', 'revoke', foreign.principal.grantId], 'not_found', ownerFile);

  const escalationFile = join(scratch, 'escalation-policy.json');
  await writeFile(escalationFile, JSON.stringify({ ...policy, projects: { kind: 'all' } }));
  await denied(
    [
      'grant',
      'create',
      'escalation',
      '--policy',
      escalationFile,
      '--expires-at',
      expiry(5),
      '--credentials',
      join(scratch, 'escalation.json'),
    ],
    'permission_denied',
    childFile,
  );

  const grandchild = issuedSchema.parse(
    await success(
      [
        'grant',
        'create',
        'grandchild',
        '--policy',
        policyFile,
        '--expires-at',
        expiry(5),
        '--credentials',
        grandchildFile,
      ],
      childFile,
    ),
  );
  secrets.push(credentialsSchema.parse(JSON.parse(await readFile(grandchildFile, 'utf8'))).token);
  await success(['whoami'], grandchildFile);
  const children = grantsResponseSchema.parse(await success(['grant', 'list'], childFile));
  expect(children.grants.map((g) => g.id)).toEqual([grandchild.grant.id]);
  const owned = grantsResponseSchema.parse(await success(['grant', 'list']));
  expect(new Set(owned.grants.map((g) => g.id))).toEqual(
    new Set([child.grant.id, grandchild.grant.id]),
  );
  expect(JSON.stringify(owned)).not.toContain('token');
  await success(['grant', 'revoke', child.grant.id]);
  await denied(['whoami'], 'unauthenticated', childFile);
  await denied(['whoami'], 'unauthenticated', grandchildFile);
  await success(['grant', 'revoke', child.grant.id]);
  await success(['whoami']);
  const revoked = grantsResponseSchema.parse(await success(['grant', 'list']));
  expect(revoked.grants.find((g) => g.id === child.grant.id)?.revokedAt).toBeTruthy();
});

it('does not issue or overwrite a credential when its destination exists or is a symlink', async () => {
  const policyFile = join(scratch, 'exclusive-policy.json');
  await writeFile(policyFile, JSON.stringify(owner.principal.policy));
  const before = grantsResponseSchema.parse(await success(['grant', 'list']));
  const link = join(scratch, 'credential-link.json');
  await symlink(ownerFile, link);
  const original = await readFile(ownerFile, 'utf8');
  for (const destination of [ownerFile, link]) {
    expect(
      (
        await cli([
          'grant',
          'create',
          'no-overwrite',
          '--policy',
          policyFile,
          '--expires-at',
          expiry(5),
          '--credentials',
          destination,
        ])
      ).code,
    ).toBe(1);
  }
  expect(await readFile(ownerFile, 'utf8')).toBe(original);
  expect(grantsResponseSchema.parse(await success(['grant', 'list']))).toEqual(before);
});

it('recovers an issuance with a lost response by listing and revoking it without retrying creation', async () => {
  const app = createApp({
    db: fixture.connection.db,
    provider: 'simulated',
    catalog: simulatedCatalog,
    limits: { maxMachines: 100, currency: 'EUR', maxHourlyMicros: 1_000_000 },
  });
  let submissions = 0;
  const lossy = serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const response = await app.fetch(request);
      if (request.method === 'POST' && new URL(request.url).pathname === '/v1/grants') {
        submissions++;
        // The service committed the credential, but an intermediary loses its response.
        return new Response('upstream disconnected', { status: 502 });
      }
      return response;
    },
  });
  if (!lossy.listening) await new Promise<void>((resolve) => lossy.once('listening', resolve));
  try {
    const address = lossy.address();
    if (!address || typeof address === 'string') throw new Error('Missing local API address.');
    const source = join(scratch, 'lossy-owner.json');
    const destination = join(scratch, 'lost-response.json');
    const policyFile = join(scratch, 'lost-response-policy.json');
    await writeFile(policyFile, JSON.stringify(owner.principal.policy));
    await success(
      ['login', '--server', `http://127.0.0.1:${address.port}`, '--token-stdin'],
      source,
      owner.token,
    );
    const args = [
      'grant',
      'create',
      'lost-response',
      '--policy',
      policyFile,
      '--expires-at',
      expiry(5),
      '--credentials',
      destination,
    ];
    expect((await cli(args, source)).code).toBe(1);
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(destination, 'utf8'))).toMatchObject({
      pendingGrant: 'lost-response',
    });
    expect((await cli(args, source)).code).toBe(1);
    expect(submissions).toBe(1);
    const listed = grantsResponseSchema.parse(await success(['grant', 'list']));
    const lost = listed.grants.find((g) => g.name === 'lost-response');
    if (!lost) throw new Error('Lost grant must remain discoverable.');
    await success(['grant', 'revoke', lost.id]);
    expect(
      grantsResponseSchema
        .parse(await success(['grant', 'list']))
        .grants.find((g) => g.id === lost.id)?.revokedAt,
    ).toBeTruthy();
  } finally {
    if ('closeAllConnections' in lossy) lossy.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      lossy.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
});

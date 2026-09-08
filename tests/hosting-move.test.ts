import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { serve } from '@hono/node-server';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  CloudError,
  newId,
  routePublishSchema,
  routeResponseSchema,
  simulatedCatalog,
  type Principal,
  type ProjectId,
  type HostingControlConfig,
} from '../packages/contracts/src/index.js';
import { machines, projects } from '../packages/db/src/index.js';
import { createHosting } from '../apps/control/src/hosting.js';
import { createApp } from '../apps/control/src/app.js';
import { authenticate, issueGrant, revokeGrant } from '../apps/control/src/auth.js';
import * as backups from '../apps/control/src/backups.js';
import { CloudClient } from '../packages/sdk/src/index.js';
import { seedAccount, testDatabase } from './database.js';

let database: Awaited<ReturnType<typeof testDatabase>>;
let owner: Awaited<ReturnType<typeof seedAccount>>;
let foreign: Awaited<ReturnType<typeof seedAccount>>;
let targetProject: ProjectId;
let source: ReturnType<typeof newId.machine>;
let target: ReturnType<typeof newId.machine>;
let foreignMachine: ReturnType<typeof newId.machine>;
let service: ReturnType<typeof createHosting>;
let app: ReturnType<typeof createApp>;
let server: ReturnType<typeof serve>;
let url: string;
let unavailable = false;
let txt: string[] = [];
const config: HostingControlConfig = {
  version: 1,
  applicationDomain: 'apps.example.test',
  gatewayTokenFile: '/gateway-token',
  gatewayAddresses: ['192.0.2.10'],
  gatewayOrigin: 'https://gateway.example.test',
};
const failure = (code: string) => ({ failure: { code } });
beforeAll(async () => {
  database = await testDatabase();
  owner = await seedAccount(database.connection.db);
  foreign = await seedAccount(database.connection.db);
  targetProject = newId.project();
  await database.connection.db
    .insert(projects)
    .values({ id: targetProject, accountId: owner.principal.accountId, name: 'restored' });
  async function machine(principal: Principal, projectId: ProjectId) {
    const id = newId.machine();
    await database.connection.db.insert(machines).values({
      id,
      accountId: principal.accountId,
      projectId,
      name: 'route-move',
      provider: 'simulated',
      spec: { name: 'route-move', size: 'small', region: 'fsn1' },
      state: {
        kind: 'allocated',
        allocationId: newId.allocation(),
        serverId: id,
        power: 'running',
        guest: {
          kind: 'ssh',
          verifiedAt: new Date().toISOString(),
          imageVersion: 'fixture',
          manifestDigest: 'a'.repeat(64),
          bootId: randomUUID(),
        },
      },
    });
    return id;
  }
  source = await machine(owner.principal, owner.projectId);
  target = await machine(owner.principal, targetProject);
  foreignMachine = await machine(foreign.principal, foreign.projectId);
  service = createHosting({
    db: database.connection.db,
    config,
    resolve: () => Promise.resolve({ values: txt, addresses: config.gatewayAddresses }),
    applyGuest: (route) =>
      unavailable
        ? Promise.reject(new CloudError('guest_unreachable', 'Fixture unavailable.'))
        : Promise.resolve({
            address: route.machineId === source ? '192.0.2.20' : '192.0.2.30',
            serverName: `${route.allocationId.replaceAll('_', '-')}.guest.example.test`,
          }),
  });
  app = createApp({
    db: database.connection.db,
    provider: 'simulated',
    catalog: simulatedCatalog,
    limits: { currency: 'EUR', maxMachines: 3, maxHourlyMicros: 30_000 },
    hosting: { service, gatewayToken: `acld_hosting_${'g'.repeat(43)}` },
  });
  server = serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch });
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected loopback server.');
  url = `http://127.0.0.1:${address.port}`;
});
afterEach(() => {
  unavailable = false;
  vi.restoreAllMocks();
});
afterAll(async () => {
  if ('closeAllConnections' in server) server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    }),
  );
  await database.close();
});
async function freshRoute() {
  return service.publish(
    owner.principal,
    routePublishSchema.parse({
      commandId: randomUUID(),
      machineId: source,
      destination: { kind: 'generated', name: `route-${randomUUID().slice(0, 8)}` },
      port: 3000,
      expectedVersion: null,
    }),
  );
}
const move = (hostname: string, expectedVersion = 1) =>
  routePublishSchema.parse({
    commandId: randomUUID(),
    machineId: target,
    destination: { kind: 'existing', hostname },
    port: 4000,
    expectedVersion,
  });
async function delegate(ids: ProjectId[]) {
  const issued = await issueGrant(database.connection.db, {
    principal: owner.principal,
    name: 'route mover',
    policy: {
      ...owner.principal.policy,
      capabilities: ['route:publish', 'machine:read'],
      projects: { kind: 'selected', ids },
    },
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  return {
    principal: await authenticate(database.connection.db, `Bearer ${issued.token}`),
    token: issued.token,
  };
}

it('moves a generated hostname through the SDK/API and keeps its working target until the destination applies', async () => {
  const original = await freshRoute();
  await service.advance(original.hostname);
  const first = await service.snapshot();
  await service.acknowledge(first.revision);
  const request = move(original.hostname);
  const client = new CloudClient({ server: url, token: owner.token });
  const replies = await Promise.all([client.publishRoute(request), client.publishRoute(request)]);
  expect(replies[0]).toEqual(replies[1]);
  expect(replies[0].route).toMatchObject({
    hostname: original.hostname,
    accountId: original.accountId,
    createdAt: original.createdAt,
    machineId: target,
    projectId: targetProject,
    port: 4000,
    version: 2,
    state: 'pending',
  });
  expect(await service.snapshot()).toEqual(first);
  unavailable = true;
  await expect(service.advance(original.hostname)).rejects.toMatchObject(
    failure('guest_unreachable'),
  );
  expect(await service.snapshot()).toEqual(first);
  unavailable = false;
  await service.advance(original.hostname);
  const next = await service.snapshot();
  expect(next.routes.find((route) => route.hostname === original.hostname)).toMatchObject({
    address: '192.0.2.30',
    version: 2,
  });
  await expect(service.acknowledge(first.revision)).rejects.toMatchObject(
    failure('version_conflict'),
  );
  await service.acknowledge(next.revision);
  expect((await client.publishRoute(request)).route).toMatchObject({
    version: 2,
    gatewayAppliedVersion: 2,
  });
  await expect(client.publishRoute({ ...request, port: 4001 })).rejects.toMatchObject(
    failure('idempotency_conflict'),
  );
  await expect(client.publishRoute({ ...request, commandId: randomUUID() })).rejects.toMatchObject(
    failure('version_conflict'),
  );
  await client.publishRoute(move(original.hostname, 2));
  await expect(client.publishRoute(request)).rejects.toMatchObject(failure('version_conflict'));
});

it('requires current authority over both the old and destination projects', async () => {
  const original = await freshRoute();
  const request = move(original.hostname);
  const oldOnly = await delegate([owner.projectId]);
  const targetOnly = await delegate([targetProject]);
  await expect(service.publish(oldOnly.principal, request)).rejects.toMatchObject(
    failure('not_found'),
  );
  await expect(service.publish(targetOnly.principal, request)).rejects.toMatchObject(
    failure('not_found'),
  );
  expect((await service.inspect(owner.principal, original.hostname)).version).toBe(1);
  const both = await delegate([owner.projectId, targetProject]);
  expect(await service.publish(both.principal, request)).toMatchObject({
    machineId: target,
    version: 2,
  });
  await revokeGrant(database.connection.db, {
    principal: owner.principal,
    grantId: both.principal.grantId,
  });
  await expect(service.publish(both.principal, request)).rejects.toMatchObject(
    failure('unauthenticated'),
  );
});

it('never claims new generated or custom hostnames, transfers foreign reservations, or accepts an implicit version', async () => {
  for (const hostname of ['new.apps.example.test', 'new.customer.example.test'])
    await expect(service.publish(owner.principal, move(hostname))).rejects.toMatchObject(
      failure('not_found'),
    );
  const original = await freshRoute();
  await expect(
    service.publish(foreign.principal, { ...move(original.hostname), machineId: foreignMachine }),
  ).rejects.toMatchObject(failure('permission_denied'));
  await expect(
    service.publish(owner.principal, { ...move(original.hostname), machineId: foreignMachine }),
  ).rejects.toMatchObject(failure('not_found'));
  const request = { ...move(original.hostname), expectedVersion: null };
  expect(routePublishSchema.safeParse(request).success).toBe(false);
  await expect(service.publish(owner.principal, request)).rejects.toMatchObject(
    failure('invalid_input'),
  );
  const response = await app.request('/v1/routes', {
    method: 'POST',
    headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  expect(response.status).toBe(400);
  expect((await service.inspect(owner.principal, original.hostname)).version).toBe(1);
});

it('moves an account-retained custom hostname after its original proof expires and retains removed-name ownership', async () => {
  const domain = await service.domains.create(owner.principal, 'retained.customer.example.test');
  txt = [domain.recordValue];
  await service.domains.verify(owner.principal, domain.id);
  const original = await service.publish(
    owner.principal,
    routePublishSchema.parse({
      ...move(domain.hostname),
      machineId: source,
      destination: { kind: 'custom', hostname: domain.hostname, challengeId: domain.id },
      expectedVersion: null,
    }),
  );
  await database.connection.pool.query(
    "UPDATE domain_challenges SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
    [domain.id],
  );
  await service.remove(owner.principal, original.hostname, {
    commandId: randomUUID(),
    expectedVersion: 1,
  });
  const moved = await service.publish(owner.principal, move(original.hostname, 2));
  expect(moved).toMatchObject({
    hostname: original.hostname,
    accountId: original.accountId,
    createdAt: original.createdAt,
    version: 3,
    machineId: target,
  });
  await expect(
    service.publish(foreign.principal, {
      ...move(original.hostname, 3),
      machineId: foreignMachine,
    }),
  ).rejects.toMatchObject(failure('permission_denied'));
});

it('keeps the destination restore quarantine check on the existing-hostname path', async () => {
  const original = await freshRoute();
  const guard = vi
    .spyOn(backups, 'assertRestoreAccessible')
    .mockRejectedValueOnce(new CloudError('resource_busy', 'Target restore is not verified.'));
  await expect(service.publish(owner.principal, move(original.hostname))).rejects.toMatchObject(
    failure('resource_busy'),
  );
  expect(guard).toHaveBeenCalledWith(expect.anything(), target);
  expect((await service.inspect(owner.principal, original.hostname)).version).toBe(1);
});

it('parses the actual CLI route move arguments and requires --expected-version before issuing a request', async () => {
  const original = await freshRoute();
  const directory = await mkdtemp(join(tmpdir(), 'acld-route-move-'));
  const credentials = join(directory, 'credentials.json');
  await writeFile(credentials, JSON.stringify({ server: url, token: owner.token }), {
    mode: 0o600,
  });
  const execute = (args: string[]) =>
    promisify(execFile)(
      process.execPath,
      ['apps/cli/dist/index.js', 'route', 'move', original.hostname, target, ...args],
      {
        env: { ...process.env, ACLD_CREDENTIALS: credentials },
        timeout: 10_000,
        maxBuffer: 65_536,
      },
    );
  try {
    await expect(execute(['--port', '4000', '--key', randomUUID()])).rejects.toMatchObject({
      code: 1,
    });
    expect((await service.inspect(owner.principal, original.hostname)).version).toBe(1);
    const result = await execute([
      '--port',
      '4100',
      '--key',
      randomUUID(),
      '--expected-version',
      '1',
    ]);
    expect(result.stdout + result.stderr).not.toContain(owner.token);
    expect(routeResponseSchema.parse(JSON.parse(result.stdout)).route).toMatchObject({
      hostname: original.hostname,
      machineId: target,
      port: 4100,
      version: 2,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

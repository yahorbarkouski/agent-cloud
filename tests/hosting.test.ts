import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  CloudError,
  newId,
  routePublishSchema,
  simulatedCatalog,
  type Principal,
  type HostingControlConfig,
  type HostingGuestRoute,
} from '../packages/contracts/src/index.js';
import { machines } from '../packages/db/src/index.js';
import { createHosting } from '../apps/control/src/hosting.js';
import { createGuestHosting } from '../packages/guestctl/src/hosting.js';
import { createApp } from '../apps/control/src/app.js';
import { seedAccount, testDatabase } from './database.js';

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let owner: Awaited<ReturnType<typeof seedAccount>>;
let foreign: Awaited<ReturnType<typeof seedAccount>>;
let machine: ReturnType<typeof newId.machine>;
const config: HostingControlConfig = {
  version: 1,
  applicationDomain: 'apps.example.test',
  gatewayTokenFile: '/operator/gateway-token',
  gatewayAddresses: ['192.0.2.10'],
  gatewayOrigin: 'https://gateway.example.test',
};
let service: ReturnType<typeof createHosting>;
let failGuest = false;
let txt: string[] = [];
let addresses = config.gatewayAddresses;
const failure = (code: string) => ({ failure: { code } });
beforeAll(async () => {
  fixture = await testDatabase();
  owner = await seedAccount(fixture.connection.db);
  foreign = await seedAccount(fixture.connection.db);
  machine = newId.machine();
  await fixture.connection.db.insert(machines).values({
    id: machine,
    accountId: owner.principal.accountId,
    projectId: owner.projectId,
    name: 'hosting',
    provider: 'simulated',
    spec: { name: 'hosting', size: 'small', region: 'fsn1' },
    state: {
      kind: 'allocated',
      allocationId: newId.allocation(),
      serverId: '1',
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
  service = createHosting({
    db: fixture.connection.db,
    config,
    resolve: () => Promise.resolve({ values: txt, addresses }),
    applyGuest: () =>
      failGuest
        ? Promise.reject(new CloudError('guest_unreachable', 'fixture unavailable'))
        : Promise.resolve({ address: '192.0.2.20', serverName: 'allocation.guest.example.test' }),
  });
});
afterAll(async () => {
  await fixture.close();
});
const publish = (name: string, expectedVersion: number | null = null, port = 3000) =>
  routePublishSchema.parse({
    commandId: randomUUID(),
    machineId: machine,
    destination: { kind: 'generated', name },
    port,
    expectedVersion,
  });

it('refuses control hostname publication and domain claims, including claims created before reservation', async () => {
  const hostname = 'control.example.test';
  const earlier = await service.domains.create(owner.principal, hostname);
  const reserved = createHosting({
    db: fixture.connection.db,
    config,
    reservedHostnames: [hostname],
  });
  await expect(reserved.domains.create(owner.principal, hostname)).rejects.toMatchObject(
    failure('permission_denied'),
  );
  await expect(reserved.domains.verify(owner.principal, earlier.id)).rejects.toMatchObject(
    failure('permission_denied'),
  );
  await expect(
    reserved.publish(
      owner.principal,
      routePublishSchema.parse({
        ...publish('reserved'),
        destination: { kind: 'custom', hostname, challengeId: earlier.id },
      }),
    ),
  ).rejects.toMatchObject(failure('permission_denied'));
});

it('publishes one owned hostname, preserves working routes during failed changes, and acknowledges exact versions', async () => {
  const request = publish('application');
  const first = await service.publish(owner.principal, request);
  expect(first.state).toBe('pending');
  expect((await service.snapshot()).routes).toEqual([]);
  await service.advance(first.hostname);
  const initial = await service.snapshot();
  expect(initial.routes).toEqual([
    {
      hostname: first.hostname,
      address: '192.0.2.20',
      serverName: 'allocation.guest.example.test',
      version: 1,
    },
  ]);
  await service.acknowledge(initial.revision);
  expect((await service.inspect(owner.principal, first.hostname)).gatewayAppliedVersion).toBe(1);
  const second = await service.publish(owner.principal, publish('application', 1, 3001));
  failGuest = true;
  await expect(service.advance(second.hostname)).rejects.toMatchObject(
    failure('guest_unreachable'),
  );
  expect(await service.snapshot()).toEqual(initial);
  failGuest = false;
  await service.advance(second.hostname);
  const changed = await service.snapshot();
  expect(changed.revision).not.toBe(initial.revision);
  await expect(service.acknowledge(initial.revision)).rejects.toMatchObject(
    failure('version_conflict'),
  );
  await expect(service.publish(owner.principal, request)).rejects.toMatchObject(
    failure('version_conflict'),
  );
  await service.acknowledge(changed.revision);
  expect((await service.inspect(owner.principal, first.hostname)).gatewayAppliedVersion).toBe(2);
  await service.remove(owner.principal, first.hostname, {
    commandId: randomUUID(),
    expectedVersion: 2,
  });
  const removed = await service.snapshot();
  expect(removed.routes).toEqual([]);
  await service.acknowledge(removed.revision);
  expect(await service.inspect(owner.principal, first.hostname)).toMatchObject({
    version: 3,
    state: 'removed',
    gatewayAppliedVersion: 3,
  });
});

it('serializes duplicate commands and rejects stale, conflicting and foreign publication', async () => {
  const request = publish('concurrent');
  const results = await Promise.all([
    service.publish(owner.principal, request),
    service.publish(owner.principal, request),
  ]);
  expect(results[0]).toEqual(results[1]);
  await expect(service.publish(owner.principal, { ...request, port: 4000 })).rejects.toMatchObject(
    failure('idempotency_conflict'),
  );
  await expect(
    service.publish(owner.principal, { ...request, commandId: randomUUID() }),
  ).rejects.toMatchObject(failure('version_conflict'));
  await expect(service.publish(foreign.principal, publish('foreign'))).rejects.toMatchObject(
    failure('not_found'),
  );
  const narrowed: Principal = {
    ...owner.principal,
    policy: { ...owner.principal.policy, capabilities: ['machine:read'] },
  };
  // Production principal is loaded again under the account lock; revoke the stored capability too.
  const readOnly = await seedAccount(fixture.connection.db, { policy: narrowed.policy });
  await expect(
    service.domains.create(readOnly.principal, 'denied.example.test'),
  ).rejects.toMatchObject(failure('permission_denied'));
  expect(routePublishSchema.safeParse({ ...request, port: 8443 }).success).toBe(false);
});

it('requires a fresh account-bound TXT proof and correct gateway DNS, retaining removed hostname ownership', async () => {
  const domain = await service.domains.create(owner.principal, 'custom.example.test');
  txt = ['unrelated'];
  await expect(service.domains.verify(owner.principal, domain.id)).rejects.toMatchObject(
    failure('permission_denied'),
  );
  txt = [domain.recordValue];
  addresses = ['192.0.2.99'];
  await expect(service.domains.verify(owner.principal, domain.id)).rejects.toMatchObject(
    failure('permission_denied'),
  );
  addresses = config.gatewayAddresses;
  await service.domains.verify(owner.principal, domain.id);
  await expect(service.domains.verify(foreign.principal, domain.id)).rejects.toMatchObject(
    failure('not_found'),
  );
  const custom = routePublishSchema.parse({
    ...publish('ignored'),
    destination: { kind: 'custom', hostname: domain.hostname, challengeId: domain.id },
  });
  const route = await service.publish(owner.principal, custom);
  await service.remove(owner.principal, route.hostname, {
    commandId: randomUUID(),
    expectedVersion: 1,
  });
  await expect(
    service.domains.create(owner.principal, `claimed.${config.applicationDomain}`),
  ).rejects.toMatchObject(failure('permission_denied'));
  const otherMachine = newId.machine();
  const [row] = await fixture.connection.db.select().from(machines).where(eq(machines.id, machine));
  if (!row) throw new Error('Missing fixture machine.');
  await fixture.connection.db.insert(machines).values({
    ...row,
    id: otherMachine,
    accountId: foreign.principal.accountId,
    projectId: foreign.projectId,
  });
  const foreignDomain = await service.domains.create(foreign.principal, domain.hostname);
  txt = [foreignDomain.recordValue];
  await service.domains.verify(foreign.principal, foreignDomain.id);
  await expect(
    service.publish(foreign.principal, {
      ...custom,
      commandId: randomUUID(),
      machineId: otherMachine,
      destination: { kind: 'custom', hostname: domain.hostname, challengeId: foreignDomain.id },
    }),
  ).rejects.toMatchObject(failure('permission_denied'));
});

it('separates public gateway authority from customer tokens and disables routes in image factory mode', async () => {
  const token = `acld_hosting_${'g'.repeat(43)}`;
  const app = createApp({
    db: fixture.connection.db,
    provider: 'simulated',
    catalog: simulatedCatalog,
    limits: { currency: 'EUR', maxMachines: 0, maxHourlyMicros: 0 },
    hosting: { service, gatewayToken: token },
  });
  expect(
    (
      await app.request('/hosting/v1/snapshot', {
        headers: { Authorization: `Bearer ${owner.token}` },
      })
    ).status,
  ).toBe(401);
  expect(
    (await app.request('/hosting/v1/snapshot', { headers: { Authorization: `Bearer ${token}` } }))
      .status,
  ).toBe(200);
  expect(
    (await app.request('/v1/routes', { headers: { Authorization: `Bearer ${token}` } })).status,
  ).toBe(401);
  const factory = createApp({
    db: fixture.connection.db,
    provider: 'simulated',
    catalog: simulatedCatalog,
    limits: { currency: 'EUR', maxMachines: 0, maxHourlyMicros: 0 },
    customerAccess: 'disabled',
    hosting: { service, gatewayToken: token },
  });
  expect(
    (
      await factory.request('/hosting/v1/snapshot', {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status,
  ).toBe(404);
});

it('applies the guest route without altering private TLS and retains state after a rejected reload', async () => {
  const state = await mkdtemp(join(tmpdir(), 'acld-guest-hosting-'));
  try {
    const path = join(state, 'caddy.json');
    const base = {
      admin: { listen: '127.0.0.1:2019' },
      apps: {
        tls: {
          certificates: {
            load_files: [{ key: '/private/guest.key', certificate: '/private/guest.crt' }],
          },
        },
        http: {
          servers: {
            guest: {
              listen: [':8443'],
              tls_connection_policies: [{ client_authentication: { mode: 'require_and_verify' } }],
              routes: [],
            },
          },
        },
      },
    };
    await writeFile(path, JSON.stringify(base), { mode: 0o640 });
    let fail = false;
    const hosting = createGuestHosting({
      state,
      apply: async (candidate) => {
        JSON.parse(await readFile(candidate, 'utf8'));
        if (fail) throw new Error('reload failed');
      },
    });
    const first = {
      kind: 'put',
      hostname: 'app.example.test',
      version: 1,
      port: 3000,
    } satisfies HostingGuestRoute;
    expect(await hosting.command({ ...first, retainFromVersion: 1 })).toEqual({ route: first });
    const saved = await readFile(path, 'utf8');
    const active = z.object({ apps: z.object({ tls: z.unknown() }) }).parse(JSON.parse(saved));
    expect(active.apps.tls).toEqual(base.apps.tls);
    fail = true;
    await expect(
      hosting.command({ ...first, version: 2, port: 4000, retainFromVersion: 1 }),
    ).rejects.toThrow('reload failed');
    expect(await readFile(path, 'utf8')).toBe(saved);
    expect(await hosting.command({ kind: 'inspect', hostname: first.hostname })).toEqual({
      route: first,
    });
    fail = false;
    await hosting.command({
      kind: 'remove',
      hostname: first.hostname,
      version: 3,
      retainFromVersion: 1,
    });
    await expect(hosting.command({ ...first, retainFromVersion: 1 })).rejects.toMatchObject(
      failure('version_conflict'),
    );
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

it('retains the acknowledged guest binding after an uncertain reload and prunes only acknowledged older versions', async () => {
  const state = await mkdtemp(join(tmpdir(), 'acld-guest-uncertain-route-'));
  try {
    await writeFile(
      join(state, 'caddy.json'),
      JSON.stringify({ apps: { http: { servers: { guest: { routes: [] } } } } }),
      { mode: 0o640 },
    );
    let live: unknown;
    let loseReply = false;
    const hosting = createGuestHosting({
      state,
      apply: async (candidate) => {
        live = JSON.parse(await readFile(candidate, 'utf8'));
        if (loseReply) throw new Error('reload reply lost');
      },
    });
    const first = {
      kind: 'put',
      hostname: 'app.example.test',
      version: 1,
      port: 3000,
      retainFromVersion: 1,
    } satisfies Parameters<typeof hosting.command>[0];
    await hosting.command(first);
    loseReply = true;
    await expect(hosting.command({ ...first, version: 2, port: 4000 })).rejects.toThrow(
      'reload reply lost',
    );
    const routes = () =>
      z
        .object({
          apps: z.object({
            http: z.object({
              servers: z.object({ guest: z.object({ routes: z.array(z.unknown()) }) }),
            }),
          }),
        })
        .parse(live).apps.http.servers.guest.routes;
    expect(routes()).toMatchObject([
      {
        match: [{ host: [first.hostname], header: { 'X-Agent-Cloud-Route-Version': ['1'] } }],
        handle: [{ upstreams: [{ dial: '127.0.0.1:3000' }] }],
      },
      {
        match: [{ host: [first.hostname], header: { 'X-Agent-Cloud-Route-Version': ['2'] } }],
        handle: [{ upstreams: [{ dial: '127.0.0.1:4000' }] }],
      },
      { handle: [{ status_code: 404 }] },
    ]);
    expect(await hosting.command({ kind: 'inspect', hostname: first.hostname })).toMatchObject({
      route: { version: 1 },
    });
    await expect(hosting.command(first)).rejects.toMatchObject(failure('version_conflict'));
    loseReply = false;
    await hosting.command({ ...first, version: 2, port: 4000 });
    await hosting.command({ ...first, version: 3, port: 5000, retainFromVersion: 2 });
    expect(JSON.stringify(routes())).not.toContain('127.0.0.1:3000');
    expect(JSON.stringify(routes())).toContain('127.0.0.1:4000');
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

it('bounds failed guest attempts per desired version and lets an explicit new command retry', async () => {
  const request = publish('bounded');
  const route = await service.publish(owner.principal, request);
  failGuest = true;
  try {
    for (let attempt = 0; attempt < 5; attempt++)
      await expect(service.advance(route.hostname)).rejects.toMatchObject(
        failure('guest_unreachable'),
      );
    expect(await service.inspect(owner.principal, route.hostname)).toMatchObject({
      application: { kind: 'blocked', attempts: 5 },
    });
    await service.advance(route.hostname);
    const retried = await service.publish(owner.principal, {
      ...request,
      commandId: randomUUID(),
      expectedVersion: 1,
    });
    expect(retried.application).toEqual({ kind: 'pending', attempts: 0 });
  } finally {
    failGuest = false;
  }
  await service.advance(route.hostname);
  expect(await service.inspect(owner.principal, route.hostname)).toMatchObject({
    version: 2,
    application: { kind: 'applied' },
  });
});

it('can read and prune retained guest configurations larger than the generic state-file limit', async () => {
  const state = await mkdtemp(join(tmpdir(), 'acld-route-history-'));
  try {
    const path = join(state, 'caddy.json');
    await writeFile(
      path,
      JSON.stringify({ apps: { http: { servers: { guest: { routes: [] } } } } }),
      { mode: 0o640 },
    );
    const hosting = createGuestHosting({ state, apply: () => Promise.resolve() });
    const hostname = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
    for (let version = 1; version <= 120; version++)
      await hosting.command({
        kind: 'put',
        hostname,
        version,
        port: 3000 + version,
        retainFromVersion: 1,
      });
    expect(Buffer.byteLength(await readFile(path, 'utf8'))).toBeGreaterThan(65_536);
    await hosting.command({
      kind: 'put',
      hostname,
      version: 121,
      port: 3121,
      retainFromVersion: 120,
    });
    expect(Buffer.byteLength(await readFile(path, 'utf8'))).toBeLessThan(65_536);
    expect(await hosting.command({ kind: 'inspect', hostname })).toMatchObject({
      route: { version: 121 },
    });
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

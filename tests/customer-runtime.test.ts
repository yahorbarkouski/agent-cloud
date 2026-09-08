import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { randomUUID, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  operationResponseSchema,
  newId,
  providerCommandSchema,
  catalogResponseSchema,
} from '../packages/contracts/dist/index.js';
import { allocations, attempts, operations } from '../packages/db/dist/index.js';
import {
  customerFirewallRules,
  checkCustomerFirewalls,
  createHetznerRequest,
} from '../packages/hetzner/dist/index.js';
import { createCustomerRuntime } from '../apps/control/dist/customer-runtime.js';
import { createApp } from '../apps/control/dist/app.js';
import { advanceOperation } from '../apps/control/dist/advance-operation.js';
import { readConfig } from '../apps/control/dist/config.js';
import { customerRuntimeConfigSchema } from '../apps/control/dist/runtime-config.js';
import { initializeRuntimeIdentity } from '../apps/control/dist/runtime-identity.js';
import { requireCustomerImage } from '../apps/control/dist/allocation-image.js';
import { seedAccount, testDatabase } from './database.js';
import { verifiedImageScenario } from './image-publication-fixture.js';

let database: Awaited<ReturnType<typeof testDatabase>>;
let root: string;
let directory: string;
beforeAll(async () => {
  database = await testDatabase();
  root = await mkdtemp(join(tmpdir(), 'agent-cloud-customer-runtime-'));
  await promisify(execFile)(
    '/usr/bin/openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=customer-runtime-test',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-keyout',
      join(root, 'root.key'),
      '-out',
      join(root, 'root.crt'),
    ],
    { timeout: 10000 },
  );
});
afterAll(async () => {
  await database.close();
  await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  await database.reset();
  directory = await mkdtemp(join(root, 'case-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function scenario() {
  const tlsRoot = new X509Certificate(await readFile(join(root, 'root.crt'), 'utf8')).toString();
  const f = await verifiedImageScenario(database.connection, join(directory, 'release'), {
    tlsRoot,
    sshHostCa: 'ssh-ed25519 AAAA',
    sshUserCa: 'ssh-ed25519 BBBB',
  });
  const release = await f.publish();
  const snapshot = [...f.provider.resources.values()].find(
    (resource) => resource.kind === 'snapshot',
  );
  if (!snapshot) throw new Error('Expected retained fixture snapshot.');
  const config = readConfig({
    DATABASE_URL: database.databaseUrl,
    PROVIDER: 'hetzner',
    PROVIDER_CURRENCY: 'USD',
    MAX_PROVIDER_HOURLY: '0.04',
    MAX_LIVE_MACHINES: '1',
    PUBLIC_URL: 'https://control.example.test',
    HCLOUD_TOKEN_FILE: join(directory, 'token'),
    HCLOUD_SERVER_TYPE_SMALL: 'cpx12',
  });
  if (config.provider !== 'hetzner') throw new Error('Expected customer config.');
  await writeFile(config.providerTokenFile, 'fixture-token'.padEnd(64, 'x'), { mode: 0o600 });
  const runtime = customerRuntimeConfigSchema.parse({
    version: 1,
    mode: 'customer',
    identityDirectory: join(directory, 'identity'),
    releaseBuildId: f.buildId,
    firewallIds: [123],
    pki: {
      binary: '/usr/bin/false',
      caUrl: 'https://ca.example.test',
      tlsRootFile: join(root, 'root.crt'),
      sshHostCaFile: join(directory, 'host.pub'),
      sshUserCaFile: join(directory, 'user.pub'),
      provisioner: 'fixture',
      provisionerPasswordFile: join(directory, 'password'),
    },
  });
  await initializeRuntimeIdentity(runtime.identityDirectory);
  await writeFile(
    join(runtime.identityDirectory, 'release-policy.json'),
    JSON.stringify({ version: 1, keys: f.publication.keys }),
  );
  await rm(join(runtime.identityDirectory, 'release.key'));
  await writeFile(runtime.pki.sshHostCaFile, 'ssh-ed25519 AAAA', { mode: 0o644 });
  await writeFile(runtime.pki.sshUserCaFile, 'ssh-ed25519 BBBB', { mode: 0o644 });
  await writeFile(runtime.pki.provisionerPasswordFile, 'fixture-password', { mode: 0o600 });
  const requests: { method: string; path: string }[] = [];
  const firewall = {
    id: 123,
    labels: { managed_by: 'agent-cloud', role: 'customer_access' },
    rules: customerFirewallRules.map((rule) => ({ ...rule, destination_ips: [] })),
  };
  const ipSchema = z.object({ name: z.string(), labels: z.record(z.string(), z.string()) });
  let ip: z.infer<typeof ipSchema> | undefined;
  let server: { name: string; labels: Record<string, string> } | undefined;
  let backupsEnabled = false;
  let bootData = '';
  const ipResponse = () => ({
    ...ip,
    id: 23,
    type: 'ipv4',
    ip: '192.0.2.23',
    location: { name: 'nbg1' },
    auto_delete: true,
    assignee_type: server ? 'server' : 'unassigned',
    assignee_id: server ? 42 : null,
  });
  const serverResponse = () => ({
    ...server,
    id: 42,
    status: 'running',
    backup_window: backupsEnabled ? '22-02' : null,
    server_type: { name: 'cpx12' },
    location: { name: 'nbg1' },
    public_net: { ipv4: { id: 23, ip: '192.0.2.23' } },
  });
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    requests.push({ method: request.method, path });
    const absent = () => Response.json({ error: { code: 'not_found' } }, { status: 404 });
    const list = (key: string, values: unknown[]) =>
      Response.json({ [key]: values, meta: { pagination: { next_page: null } } });
    if (path === '/v1/firewalls/123') return Response.json({ firewall });
    if (path === '/v1/images/' + snapshot.id)
      return Response.json({
        image: {
          id: Number(snapshot.id),
          labels: snapshot.labels,
          type: 'snapshot',
          status: 'available',
          architecture: 'x86',
          os_flavor: 'ubuntu',
          os_version: '24.04',
          disk_size: snapshot.diskGb,
          image_size: snapshot.imageSizeGb,
          created: snapshot.createdAt,
          created_from: null,
          protection: { delete: false },
          deprecated: null,
          deleted: null,
        },
      });
    if (path === '/v1/pricing')
      return Response.json({
        pricing: {
          currency: 'USD',
          server_backup: { percentage: '20.0000000000' },
          server_types: [
            { name: 'cpx12', prices: [{ location: 'nbg1', price_hourly: { gross: '0.026568' } }] },
          ],
          primary_ips: [
            { type: 'ipv4', prices: [{ location: 'nbg1', price_hourly: { gross: '0.001230' } }] },
          ],
        },
      });
    if (path === '/v1/server_types')
      return list('server_types', [
        {
          name: 'cpx12',
          architecture: 'x86',
          cores: 1,
          memory: 2,
          disk: 40,
          deprecated: false,
          locations: [{ name: 'nbg1', available: true }],
        },
      ]);
    if (path === '/v1/primary_ips' && request.method === 'POST') {
      ip = ipSchema.parse(await request.json());
      return Response.json({ primary_ip: ipResponse() });
    }
    if (path === '/v1/primary_ips') return list('primary_ips', ip ? [ipResponse()] : []);
    if (path === '/v1/primary_ips/23') {
      if (request.method === 'DELETE') {
        ip = undefined;
        return new Response(null, { status: 204 });
      }
      return ip ? Response.json({ primary_ip: ipResponse() }) : absent();
    }
    if (path === '/v1/servers' && request.method === 'POST') {
      const body = ipSchema
        .extend({
          user_data: z.string(),
          ssh_keys: z.array(z.never()),
          image: z.literal(snapshot.id),
        })
        .parse(await request.json());
      server = body;
      bootData = body.user_data;
      return Response.json({ server: serverResponse(), action: { id: 61, status: 'success' } });
    }
    if (path === '/v1/servers') return list('servers', server ? [serverResponse()] : []);
    if (path === '/v1/servers/42/actions/enable_backup' && request.method === 'POST') {
      backupsEnabled = true;
      return Response.json({ action: { id: 62, status: 'success' } });
    }
    if (path === '/v1/servers/42')
      return server ? Response.json({ server: serverResponse() }) : absent();
    if (path === '/v1/actions/61') return Response.json({ action: { id: 61, status: 'success' } });
    if (path === '/v1/actions/62') return Response.json({ action: { id: 62, status: 'success' } });
    throw new Error(`Unexpected fixture request ${request.method} ${path}`);
  };
  const create = () =>
    createCustomerRuntime({ connection: database.connection, config, runtime, transport });
  const customer = await create();
  const account = await seedAccount(database.connection.db, { currency: 'USD' });
  const app = (runtime = customer) =>
    createApp({
      db: database.connection.db,
      provider: 'hetzner',
      catalog: () =>
        catalogResponseSchema.parse({
          ...f.catalog,
          items: f.catalog.items.map((item) => ({
            ...item,
            providerBackups: { kind: 'daily', hourlyMicros: 5314 },
            hourlyMicros: item.hourlyMicros + 5314,
          })),
        }),
      limits: config.limits,
      enrollment: runtime.enrollment,
      renewal: runtime.renewal,
      imageRelease: runtime.imageRelease,
    });
  const admit = async () => {
    const response = await app().request(`/v1/projects/${account.projectId}/machines`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${account.token}`,
        'Idempotency-Key': randomUUID(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'customer-runtime', size: 'small', region: 'nbg1' }),
    });
    expect(response.status).toBe(202);
    return operationResponseSchema.parse(await response.json()).operation;
  };
  const tick = (
    operationId: Parameters<typeof advanceOperation>[0]['operationId'],
    ports = customer,
  ) =>
    advanceOperation({
      connection: database.connection,
      operationId,
      provider: ports.provider,
      guest: ports.guest,
      limits: config.limits,
    });
  return {
    ...f,
    release,
    config,
    runtime,
    requests,
    firewall,
    customer,
    create,
    app,
    account,
    admit,
    tick,
    ip: () => ip,
    bootData: () => bootData,
  };
}

it('starts without I/O, preflights a renewal-capable retained release, and renders one exact customer create without release signing keys', async () => {
  const f = await scenario();
  expect(f.requests).toEqual([]);
  await f.customer.checkConfiguration();
  expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
  const operation = await f.admit();
  for (let pass = 0; pass < 8; pass++) await f.tick(operation.id);
  const [record] = await database.connection.db
    .select()
    .from(operations)
    .where(eq(operations.id, operation.id));
  expect(
    record?.progress,
    JSON.stringify({ progress: record?.progress, requests: f.requests }),
  ).toMatchObject({ kind: 'waiting_guest', stage: 'enrollment' });
  expect(
    f.requests.filter((request) => request.method === 'POST' && request.path === '/v1/servers'),
  ).toHaveLength(1);
  expect(f.bootData()).toContain('https://control.example.test/guest/enroll');
  expect(f.bootData()).toContain('agent-cloud-enroll.service');
  expect(f.bootData()).not.toContain('fixture-token');
  const journal = await database.connection.db.select().from(attempts);
  expect(journal.map((row) => providerCommandSchema.parse(row.command).kind)).toEqual([
    'create_primary_ip',
    'create_guest',
    'enable_backup',
  ]);
});

it('keeps authenticated customer reads and exact IP compensation available after losing private signing files', async () => {
  const f = await scenario();
  const operation = await f.admit();
  await f.tick(operation.id);
  expect(
    f.ip(),
    JSON.stringify({
      requests: f.requests,
      progress: (await database.connection.db.select().from(operations))[0]?.progress,
    }),
  ).toBeDefined();
  await rm(join(f.runtime.identityDirectory, 'bootstrap.key'));
  await rm(f.runtime.pki.provisionerPasswordFile);
  const restarted = await f.create();
  expect(
    (
      await f
        .app(restarted)
        .request('/v1/projects', { headers: { Authorization: `Bearer ${f.account.token}` } })
    ).status,
  ).toBe(200);
  for (let pass = 0; pass < 8; pass++) await f.tick(operation.id, restarted);
  expect(f.ip()).toBeUndefined();
  expect(
    f.requests.some((request) => request.method === 'POST' && request.path === '/v1/servers'),
  ).toBe(false);
  const [allocation] = await database.connection.db
    .select()
    .from(allocations)
    .where(eq(allocations.machineId, operation.machineId));
  expect(allocation?.retiredAt).not.toBeNull();
  const [record] = await database.connection.db
    .select()
    .from(operations)
    .where(eq(operations.id, operation.id));
  expect(record?.progress).toMatchObject({ kind: 'failed' });
});

it('refuses changed firewall ownership before the first paid effect and exposes only customer guest endpoints', async () => {
  const f = await scenario();
  f.firewall.labels.role = 'unrelated';
  const operation = await f.admit();
  await f.tick(operation.id);
  expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
  for (const [path, expected] of [
    ['/guest/enroll', 400],
    ['/guest/renew', 400],
    ['/image/enroll', 404],
  ] satisfies [string, number][]) {
    expect(
      (
        await f.app().request(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(expected);
  }
  const legacy = structuredClone(f.release);
  legacy.payload.inputs.files = legacy.payload.inputs.files.filter(
    (file) => !file.path.includes('agent-cloud-renew.'),
  );
  expect(() => {
    requireCustomerImage(legacy);
  }).toThrow('renewal-capable');
});

it('admits the guest SSH and protected HTTPS listeners and rejects unused web ports', async () => {
  expect(customerFirewallRules.map((rule) => rule.port)).toEqual(['22', '8443']);
  const request = createHetznerRequest({
    token: 'fixture-token'.padEnd(64, 'x'),
    transport: () =>
      Promise.resolve(
        Response.json({
          firewall: {
            id: 123,
            labels: { managed_by: 'agent-cloud', role: 'customer_access' },
            rules: ['22', '8443'].map((port) => ({
              direction: 'in',
              protocol: 'tcp',
              port,
              source_ips: ['0.0.0.0/0'],
              destination_ips: [],
            })),
          },
        }),
      ),
  });
  await expect(checkCustomerFirewalls(request, [123])).resolves.toBeUndefined();
});

it('rejects missing HTTPS ingress, extra ports, duplicate rules and outbound restrictions', async () => {
  const rule = { ...customerFirewallRules[0], destination_ips: [] };
  for (const rules of [
    [...customerFirewallRules, { ...rule, port: '5432' }],
    [rule, rule],
    [rule, { ...rule, port: '8443', direction: 'out' }],
    [rule, { ...rule, port: '443' }],
    [rule, { ...rule, port: '80' }, { ...rule, port: '443' }],
  ]) {
    const request = createHetznerRequest({
      token: 'fixture-token'.padEnd(64, 'x'),
      transport: () =>
        Promise.resolve(
          Response.json({
            firewall: {
              id: 123,
              labels: { managed_by: 'agent-cloud', role: 'customer_access' },
              rules: rules.map((item) => ({ ...item, destination_ips: [] })),
            },
          }),
        ),
    });
    await expect(checkCustomerFirewalls(request, [123])).rejects.toThrow();
  }
});

it('the actual customer API starts and authenticates reads with missing bootstrap and PKI files and unavailable provider reads', async () => {
  const f = await scenario();
  await rm(join(f.runtime.identityDirectory, 'bootstrap.key'));
  await rm(f.runtime.pki.provisionerPasswordFile);
  const configuration = join(directory, 'runtime.json');
  await writeFile(configuration, JSON.stringify(f.runtime), { mode: 0o600 });
  const transport = join(directory, 'provider-unavailable.mjs');
  await writeFile(
    transport,
    "globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'service_error' } }), { status: 503 });\n",
  );
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Expected fixture port.');
  await new Promise<void>((done, reject) =>
    listener.close((error) => {
      if (error) reject(error);
      else done();
    }),
  );
  const child = spawn(
    process.execPath,
    ['--import', transport, resolve('apps/control/dist/api.js')],
    {
      cwd: directory,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        DATABASE_URL: database.databaseUrl,
        ACLD_CONTROL_GENERATION_FILE: await database.controlIdentity(),
        PROVIDER: 'hetzner',
        PROVIDER_CURRENCY: 'USD',
        MAX_PROVIDER_HOURLY: '0.03',
        HOST: '127.0.0.1',
        PORT: String(address.port),
        PUBLIC_URL: 'https://control.example.test',
        HCLOUD_TOKEN_FILE: f.config.providerTokenFile,
        AGENT_CLOUD_RUNTIME: configuration,
      },
    },
  );
  const exited = once(child, 'exit');
  const lines = createInterface({ input: child.stdout });
  child.stderr.resume();
  const deadline = AbortSignal.timeout(15_000);
  try {
    const [line] = z.tuple([z.string()]).parse(
      await Promise.race([
        once(lines, 'line', { signal: deadline }),
        exited.then(() => {
          throw new Error('Customer API exited before listening.');
        }),
      ]),
    );
    expect(z.object({ event: z.string() }).parse(JSON.parse(line)).event).toBe('api.listening');
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/projects`, {
      headers: { Authorization: `Bearer ${f.account.token}` },
      signal: deadline,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(f.account.projectId);
  } finally {
    lines.close();
    child.kill('SIGTERM');
    await exited;
  }
});

it('distinguishes an absent firewall from an unavailable or malformed observation', async () => {
  for (const [status, body, code] of [
    [404, { error: { code: 'not_found' } }, 'permission_denied'],
    [503, { error: { code: 'service_error' } }, 'provider_unavailable'],
    [200, { firewall: { id: 123 } }, 'provider_unavailable'],
  ] satisfies [number, unknown, string][]) {
    const request = createHetznerRequest({
      token: 'fixture-token'.padEnd(64, 'x'),
      transport: () => Promise.resolve(Response.json(body, { status })),
    });
    await expect(checkCustomerFirewalls(request, [123])).rejects.toMatchObject({
      failure: { code, retryable: code === 'provider_unavailable' },
    });
  }
});

it('renewal authorization remains available after bootstrap-key loss', async () => {
  const f = await scenario();
  await rm(join(f.runtime.identityDirectory, 'bootstrap.key'));
  const restarted = await f.create();
  // The unknown allocation must reach renewal authorization, rather than fail on the unrelated seal.
  await expect(
    restarted.renewal.renew({
      version: 1,
      allocationId: newId.allocation(),
      requestedAt: new Date().toISOString(),
      signature: 'a'.repeat(86),
    }),
  ).rejects.toMatchObject({ failure: { code: 'unauthenticated' } });
  expect(f.requests).toEqual([]);
});

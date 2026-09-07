import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  createPublicGateway,
  publicRouteSnapshotSchema,
  renderCaddyConfig,
  type CaddyRuntime,
  type PublicGatewayConfiguration,
  type PublicRouteSnapshot,
} from '../apps/public-gateway/src/index.js';

let directory: string;
let configuration: PublicGatewayConfiguration;
beforeEach(async () => {
  directory = await mkdtemp('/tmp/agent-public-');
  configuration = {
    caddy: '/unused/caddy',
    stateDirectory: join(directory, 'state'),
    guestCaFile: join(directory, 'ca.pem'),
    clientCertificateFile: join(directory, 'client.pem'),
    clientKeyFile: join(directory, 'client.key'),
    publicTls: { kind: 'internal' },
    listenAddress: '127.0.0.1',
    httpPort: 18080,
    httpsPort: 18443,
  };
  for (const path of [
    configuration.guestCaFile,
    configuration.clientCertificateFile,
    configuration.clientKeyFile,
  ])
    await writeFile(path, `private-fixture-${path}`, { mode: 0o600 });
});
afterEach(async () => rm(directory, { recursive: true, force: true }));

const first: PublicRouteSnapshot = {
  revision: 'r1',
  routes: [
    {
      hostname: 'app.example.test',
      address: '192.0.2.10',
      serverName: 'guest.example.internal',
      version: 7,
    },
    {
      hostname: 'other.example.test',
      address: '2001:db8::1',
      serverName: 'other.example.internal',
      version: 2,
    },
  ],
};

function fixture() {
  let active: unknown = null;
  let failure = '';
  const calls: string[][] = [];
  const runtime: CaddyRuntime = {
    readConfig: () => Promise.resolve(active),
    run: async (args) => {
      calls.push(args);
      if (args[0] === failure) throw new Error('Rejected candidate.');
      if (args[0] === 'stop') active = null;
      if (args[0] === 'start' || args[0] === 'reload') {
        const path = args[args.indexOf('--config') + 1];
        if (!path) throw new Error('Missing candidate path.');
        active = JSON.parse(await readFile(path, 'utf8'));
      }
    },
  };
  return {
    runtime,
    calls,
    gateway: createPublicGateway(configuration, runtime),
    fail: (command: string) => {
      failure = command;
    },
  };
}

it('binds exact hostnames, guest address, guest TLS identity and separate mTLS credentials', () => {
  const config = renderCaddyConfig(configuration, first);
  expect(config.admin.listen).toBe(`unix/${configuration.stateDirectory}/admin.sock`);
  expect(config.apps.tls.certificates.automate).toEqual(['app.example.test', 'other.example.test']);
  expect(config.apps.tls.automation.policies).toEqual([
    {
      subjects: ['app.example.test', 'other.example.test'],
      on_demand: false,
      issuers: [{ module: 'internal' }],
    },
  ]);
  const gateway = config.apps.http.servers.gateway;
  expect(gateway?.strict_sni_host).toBe(true);
  expect(gateway?.tls_connection_policies).toEqual([
    { match: { sni: ['app.example.test', 'other.example.test'] }, protocol_min: 'tls1.2' },
  ]);
  expect(gateway?.routes[0]).toMatchObject({
    match: [{ host: ['app.example.test'] }],
    handle: [
      {
        handler: 'reverse_proxy',
        upstreams: [{ dial: '192.0.2.10:8443' }],
        headers: {
          request: { set: { Host: ['app.example.test'], 'X-Agent-Cloud-Route-Version': ['7'] } },
        },
        transport: {
          tls: {
            ca: { provider: 'file', pem_files: [configuration.guestCaFile] },
            server_name: 'guest.example.internal',
            client_certificate_file: configuration.clientCertificateFile,
            client_certificate_key_file: configuration.clientKeyFile,
          },
        },
      },
    ],
  });
  expect(gateway?.routes[1]).toMatchObject({
    handle: [{ upstreams: [{ dial: '[2001:db8::1]:8443' }] }],
  });
  expect(gateway?.routes.at(-1)).toEqual({
    handle: [{ handler: 'static_response', status_code: 404 }],
    terminal: true,
  });
  expect(config.apps.http.servers.redirect.routes.at(-1)).toEqual(gateway?.routes.at(-1));
  expect(JSON.stringify(config)).not.toContain('insecure_skip_verify');
});

it('overwrites visitor route-version headers with the authoritative version for each host', () => {
  const routes = renderCaddyConfig(configuration, first).apps.http.servers.gateway?.routes;
  expect(routes?.[0]).toMatchObject({
    handle: [{ headers: { request: { set: { 'X-Agent-Cloud-Route-Version': ['7'] } } } }],
  });
  expect(routes?.[1]).toMatchObject({
    handle: [{ headers: { request: { set: { 'X-Agent-Cloud-Route-Version': ['2'] } } } }],
  });
  for (const route of routes?.slice(0, -1) ?? []) {
    expect(route).not.toHaveProperty('handle.0.headers.request.add');
    expect(JSON.stringify(route)).not.toContain(
      '{http.request.header.X-Agent-Cloud-Route-Version}',
    );
  }
});

it.each([undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '7'])(
  'rejects a missing or invalid route version %s',
  (version) => {
    expect(
      publicRouteSnapshotSchema.safeParse({
        revision: 'r1',
        routes: [
          {
            hostname: 'app.example.test',
            address: '192.0.2.10',
            serverName: 'guest.example.internal',
            version,
          },
        ],
      }).success,
    ).toBe(false);
  },
);

it('uses ACME only for configured names and removes the TLS listener when there are no routes', () => {
  const config = renderCaddyConfig(
    { ...configuration, publicTls: { kind: 'acme', email: 'operator@example.test' } },
    first,
  );
  expect(config.apps.tls.automation.policies[0]?.issuers[0]).toEqual({
    module: 'acme',
    email: 'operator@example.test',
    ca: 'https://acme-v02.api.letsencrypt.org/directory',
  });
  const empty = renderCaddyConfig(configuration, { revision: 'empty', routes: [] });
  expect(empty.apps.tls.certificates.automate).toEqual([]);
  expect(empty.apps.http.servers).not.toHaveProperty('gateway');
  expect(empty.apps.http.servers.redirect.routes).toHaveLength(1);
});

it.each([
  '*.example.test',
  '{host}',
  'app.example.test:443',
  'APP.example.test',
  'app.example.test.',
])('rejects nonliteral or noncanonical hostname %s', (hostname) => {
  expect(() =>
    renderCaddyConfig(configuration, {
      revision: 'r1',
      routes: [{ hostname, address: '192.0.2.10', serverName: 'guest.example.test', version: 1 }],
    }),
  ).toThrow();
});

it('rejects duplicate hosts, address templates, DNS upstreams and an injected port', () => {
  expect(() =>
    renderCaddyConfig(configuration, { ...first, routes: [...first.routes, ...first.routes] }),
  ).toThrow();
  for (const address of ['{http.request.host}', 'guest.example.test', '192.0.2.10:80'])
    expect(() =>
      renderCaddyConfig(configuration, {
        revision: 'r1',
        routes: [
          { hostname: 'app.example.test', address, serverName: 'guest.example.test', version: 1 },
        ],
      }),
    ).toThrow();
});

it('durably applies one revision, skips replay, and restores that revision after restart', async () => {
  const f = fixture();
  expect(await f.gateway.start()).toEqual({ revision: null, routes: 0, active: true });
  expect(await f.gateway.apply(first)).toEqual({ revision: 'r1', routes: 2, active: true });
  const appliedCalls = f.calls.length;
  await f.gateway.apply({ ...first, routes: [...first.routes].reverse() });
  expect(f.calls).toHaveLength(appliedCalls);
  expect((await stat(join(configuration.stateDirectory, 'last-good.json'))).mode & 0o777).toBe(
    0o600,
  );
  await f.gateway.stop();
  const restarted = createPublicGateway(configuration, f.runtime);
  expect(await restarted.inspect()).toEqual({ revision: 'r1', routes: 2, active: false });
  expect(await restarted.start()).toEqual({ revision: 'r1', routes: 2, active: true });
});

it.each(['validate', 'reload'])(
  'preserves prior durable and running state after failed %s',
  async (command) => {
    const f = fixture();
    await f.gateway.start();
    await f.gateway.apply(first);
    const path = join(configuration.stateDirectory, 'last-good.json');
    const previous = await readFile(path);
    f.fail(command);
    await expect(f.gateway.apply({ revision: 'r2', routes: [] })).rejects.toThrow('Rejected');
    expect(await readFile(path)).toEqual(previous);
    expect(await f.gateway.inspect()).toEqual({ revision: 'r1', routes: 2, active: true });
  },
);

it('refuses changed routes under the same revision before Caddy is called', async () => {
  const f = fixture();
  await f.gateway.start();
  await f.gateway.apply(first);
  const count = f.calls.length;
  await expect(f.gateway.apply({ revision: 'r1', routes: [] })).rejects.toThrow('different routes');
  expect(f.calls).toHaveLength(count);
});

it('requires a new snapshot revision when only the route version changes', async () => {
  const f = fixture();
  await f.gateway.start();
  await f.gateway.apply(first);
  const count = f.calls.length;
  const routes = first.routes.map((route) => ({ ...route, version: route.version + 1 }));
  await expect(f.gateway.apply({ revision: 'r1', routes })).rejects.toThrow('different routes');
  expect(f.calls).toHaveLength(count);
  expect(await f.gateway.apply({ revision: 'r2', routes })).toEqual({
    revision: 'r2',
    routes: 2,
    active: true,
  });
  expect(f.calls.slice(count).map((args) => args[0])).toEqual(['validate', 'reload']);
  expect(
    JSON.parse(await readFile(join(configuration.stateDirectory, 'last-good.json'), 'utf8')),
  ).toMatchObject({ snapshot: { revision: 'r2', routes } });
});

it.each(['guestCaFile', 'clientCertificateFile', 'clientKeyFile'] satisfies Array<
  'guestCaFile' | 'clientCertificateFile' | 'clientKeyFile'
>)('reloads unchanged routes after %s rotation and persists only the digest', async (field) => {
  const f = fixture();
  await f.gateway.start();
  await f.gateway.apply(first);
  const count = f.calls.length;
  await writeFile(configuration[field], 'rotated-sensitive-bytes');
  expect((await f.gateway.inspect()).active).toBe(false);
  expect((await f.gateway.apply(first)).active).toBe(true);
  expect(f.calls.slice(count).map((args) => args[0])).toEqual(['validate', 'reload']);
  expect(f.calls.at(-1)).toContain('--force');
  expect(
    await readFile(join(configuration.stateDirectory, 'last-good.json'), 'utf8'),
  ).not.toContain('rotated-sensitive-bytes');
});

it('preserves the prior credential digest if certificate rotation fails validation', async () => {
  const f = fixture();
  await f.gateway.start();
  await f.gateway.apply(first);
  const path = join(configuration.stateDirectory, 'last-good.json');
  const previous = await readFile(path);
  await writeFile(configuration.clientKeyFile, 'bad-key');
  f.fail('validate');
  await expect(f.gateway.apply(first)).rejects.toThrow('Rejected');
  expect(await readFile(path)).toEqual(previous);
  expect((await f.gateway.inspect()).active).toBe(false);
});

it('can remove every public route even when guest credentials are unavailable', async () => {
  const f = fixture();
  await f.gateway.start();
  await f.gateway.apply(first);
  await rm(configuration.clientKeyFile);
  expect(await f.gateway.inspect()).toEqual({ revision: 'r1', routes: 2, active: false });
  expect(await f.gateway.apply({ revision: 'r2', routes: [] })).toEqual({
    revision: 'r2',
    routes: 0,
    active: true,
  });
});

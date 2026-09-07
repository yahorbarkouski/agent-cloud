import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { generateGatewayTlsKey } from '../packages/pki/src/gateway-tls.js';
import {
  createGatewayCertificate,
  gatewayCertificateReceiptSchema,
  readGatewayFile,
  type GatewayCertificateOperations,
} from '../apps/public-gateway/src/certificate.js';
import {
  createPublicGateway,
  publicGatewayConfigurationSchema,
  type CaddyRuntime,
} from '../apps/public-gateway/src/index.js';
import {
  createPublicGatewayController,
  publicGatewayControllerSchema,
} from '../apps/public-gateway/src/controller.js';
import { setupHostingGateway } from '../scripts/setup-hosting-gateway.js';

let rootDirectory: string;
let root: string;
let directory: string;
let config: Parameters<typeof createPublicGatewayController>[0];
let now: number;
const name = 'public.gateway.agent-cloud.internal';
const password = 'private-issuer-password-never-published';
const receipt = (
  certificate = 'old-certificate',
  expiresAt = new Date(now + 10 * 60_000).toISOString(),
) => ({
  name,
  certificate,
  issuedAt: new Date(now - 50 * 60_000).toISOString(),
  expiresAt,
});
const renewed = () => ({
  certificate: 'renewed-certificate',
  issuedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 60 * 60_000).toISOString(),
});

beforeAll(async () => {
  rootDirectory = await mkdtemp('/tmp/acld-gw-root-');
  const key = join(rootDirectory, 'root.key');
  const certificate = join(rootDirectory, 'root.crt');
  const configuration = join(rootDirectory, 'root.cnf');
  await writeFile(key, generateGatewayTlsKey(), { mode: 0o600 });
  await writeFile(
    configuration,
    '[req]\ndistinguished_name=dn\nx509_extensions=root\n[dn]\n[root]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\n',
  );
  await promisify(execFile)(
    '/usr/bin/openssl',
    [
      'req',
      '-x509',
      '-new',
      '-key',
      key,
      '-out',
      certificate,
      '-days',
      '2',
      '-subj',
      '/CN=Gateway test root',
      '-config',
      configuration,
    ],
    { timeout: 5000 },
  );
  root = await readFile(certificate, 'utf8');
});
afterAll(async () => rm(rootDirectory, { recursive: true, force: true }));
beforeEach(async () => {
  now = Date.now();
  directory = await mkdtemp('/tmp/acld-gw-cert-');
  config = {
    apiUrl: 'http://127.0.0.1:18001',
    tokenFile: join(directory, 'token'),
    gateway: {
      caddy: '/usr/bin/true',
      stateDirectory: join(directory, 'state'),
      guestCaFile: join(directory, 'root.crt'),
      clientCertificateFile: join(directory, 'client.crt'),
      clientKeyFile: join(directory, 'client.key'),
      publicTls: { kind: 'internal' },
    },
    clientIdentity: {
      name,
      receiptFile: join(directory, 'receipt.json'),
      step: '/usr/bin/true',
      caUrl: 'https://ca.example.test',
    },
  };
  await writeFile(config.gateway.guestCaFile, root, { mode: 0o600 });
  await writeFile(config.tokenFile, 'acld_hosting_' + 'a'.repeat(43), { mode: 0o600 });
  await writeFile(join(directory, 'password'), password, { mode: 0o600 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
async function install() {
  await writeFile(config.gateway.clientKeyFile, generateGatewayTlsKey(), { mode: 0o600 });
  await writeFile(config.clientIdentity.receiptFile, JSON.stringify(receipt()), { mode: 0o600 });
  await writeFile(config.gateway.clientCertificateFile, receipt().certificate, { mode: 0o600 });
}
function operations() {
  return {
    now: () => now,
    validate: vi.fn<GatewayCertificateOperations['validate']>((_config, identity) =>
      Promise.resolve({
        expiresAt:
          identity.certificate === 'old-certificate' ? receipt().expiresAt : renewed().expiresAt,
      }),
    ),
    renew: vi.fn<GatewayCertificateOperations['renew']>(() => Promise.resolve(renewed())),
  };
}

it('requires a separate runtime identity, rejects issuer fields and colliding credential paths', () => {
  expect(
    publicGatewayControllerSchema.safeParse({ ...config, clientIdentity: undefined }).success,
  ).toBe(false);
  expect(
    publicGatewayControllerSchema.safeParse({
      ...config,
      clientIdentity: { ...config.clientIdentity, provisionerPassword: password },
    }).success,
  ).toBe(false);
  expect(
    publicGatewayControllerSchema.safeParse({
      ...config,
      clientIdentity: { ...config.clientIdentity, receiptFile: config.gateway.clientKeyFile },
    }).success,
  ).toBe(false);
});

it('rejects admin socket paths at the platform byte limit', () => {
  const limit = process.platform === 'darwin' ? 104 : 108;
  expect(
    publicGatewayConfigurationSchema.safeParse({
      ...config.gateway,
      stateDirectory: '/' + 'a'.repeat(limit - 13),
    }).success,
  ).toBe(true);
  expect(
    publicGatewayConfigurationSchema.safeParse({
      ...config.gateway,
      stateDirectory: '/' + 'a'.repeat(limit - 12),
    }).success,
  ).toBe(false);
  expect(
    publicGatewayConfigurationSchema.safeParse({
      ...config.gateway,
      stateDirectory: '/' + 'é'.repeat(60),
    }).success,
  ).toBe(false);
});

it('restores a missing PEM from the authoritative receipt without issuer access or renewal', async () => {
  await install();
  await rm(config.gateway.clientCertificateFile);
  const pki = operations();
  const identity = createGatewayCertificate(config, pki);
  await identity.restore();
  expect(await readGatewayFile(config.gateway.clientCertificateFile)).toBe(receipt().certificate);
  expect(pki.renew).not.toHaveBeenCalled();
  expect(pki.validate.mock.calls[0]?.[0]).toEqual({
    binary: config.clientIdentity.step,
    caUrl: config.clientIdentity.caUrl,
    tlsRoot: root.trim(),
  });
  expect((await stat(config.gateway.clientCertificateFile)).mode & 0o777).toBe(0o600);
});

it('persists a renewed receipt before PEM publication and recovers after interruption with the same key', async () => {
  await install();
  const key = await readFile(config.gateway.clientKeyFile, 'utf8');
  const pki = operations();
  pki.renew.mockImplementationOnce(async () => {
    await rm(config.gateway.clientCertificateFile);
    await mkdir(config.gateway.clientCertificateFile);
    return renewed();
  });
  await expect(createGatewayCertificate(config, pki).refresh()).rejects.toThrow('Gateway file');
  expect(
    gatewayCertificateReceiptSchema.parse(
      JSON.parse(await readGatewayFile(config.clientIdentity.receiptFile)),
    ),
  ).toEqual({ name, ...renewed() });
  await rm(config.gateway.clientCertificateFile, { recursive: true });
  expect(await createGatewayCertificate(config, pki).refresh()).toEqual({
    expiresAt: renewed().expiresAt,
    renewal: 'not_due',
  });
  expect(pki.renew).toHaveBeenCalledTimes(1);
  expect(pki.renew.mock.calls[0]?.[1].privateKey).toBe(key.trim());
  expect(await readFile(config.gateway.clientKeyFile, 'utf8')).toBe(key);
  expect(await readGatewayFile(config.gateway.clientCertificateFile)).toBe(renewed().certificate);
});

it('retains the old certificate after uncertain renewal and records a new attempt after backoff', async () => {
  await install();
  const pki = operations();
  pki.renew.mockRejectedValue(new Error(password));
  const identity = createGatewayCertificate(config, pki);
  expect((await identity.refresh()).renewal).toBe('unavailable');
  const attemptPath = `${config.clientIdentity.receiptFile}.renewal.json`;
  const attempt = await readGatewayFile(attemptPath);
  expect((await identity.refresh()).renewal).toBe('unavailable');
  expect(pki.renew).toHaveBeenCalledTimes(1);
  expect(await readGatewayFile(config.gateway.clientCertificateFile)).toBe(receipt().certificate);
  now += 61_000;
  await identity.refresh();
  expect(pki.renew).toHaveBeenCalledTimes(2);
  expect(await readGatewayFile(attemptPath)).not.toBe(attempt);
  expect(await readGatewayFile(attemptPath)).not.toContain(password);
});

it('does not publish a receipt that fails identity verification', async () => {
  await install();
  const pki = operations();
  pki.validate.mockRejectedValue(new Error('Wrong key or untrusted chain.'));
  await writeFile(config.gateway.clientCertificateFile, 'last-working-certificate');
  await expect(createGatewayCertificate(config, pki).restore()).rejects.toThrow('Wrong key');
  expect(await readGatewayFile(config.gateway.clientCertificateFile)).toBe(
    'last-working-certificate',
  );
  expect(pki.renew).not.toHaveBeenCalled();
});

it('refuses nonprivate or symlinked receipts before renewal', async () => {
  await install();
  const pki = operations();
  await chmod(config.clientIdentity.receiptFile, 0o644);
  await expect(createGatewayCertificate(config, pki).refresh()).rejects.toThrow('Gateway file');
  await rm(config.clientIdentity.receiptFile);
  await symlink(config.gateway.clientCertificateFile, config.clientIdentity.receiptFile);
  await expect(createGatewayCertificate(config, pki).refresh()).rejects.toThrow();
  expect(pki.renew).not.toHaveBeenCalled();
});

function caddyFixture() {
  let active: unknown = null;
  const calls: string[][] = [];
  const runtime: CaddyRuntime = {
    readConfig: () => Promise.resolve(active),
    run: async (args) => {
      calls.push(args);
      if (args[0] === 'stop') active = null;
      if (args[0] === 'start' || args[0] === 'reload') {
        const path = args[args.indexOf('--config') + 1];
        if (!path) throw new Error('Missing Caddy configuration.');
        active = JSON.parse(await readFile(path, 'utf8'));
      }
    },
  };
  return { gateway: createPublicGateway(config.gateway, runtime), calls };
}
const snapshot = {
  revision: 'a'.repeat(64),
  routes: [
    {
      hostname: 'app.example.test',
      address: '192.0.2.10',
      serverName: 'machine.guest.agent-cloud.internal',
      version: 7,
    },
  ],
};

it('reloads retained routes with renewed TLS before an unavailable control API is consulted', async () => {
  await install();
  const fixture = caddyFixture();
  await fixture.gateway.start();
  await fixture.gateway.apply(snapshot);
  const before = fixture.calls.length;
  const request = vi.fn<typeof fetch>(() => Promise.reject(new Error('API offline')));
  const controller = createPublicGatewayController(config, {
    gateway: fixture.gateway,
    certificate: createGatewayCertificate(config, operations()),
    fetch: request,
  });
  await expect(controller.synchronize()).rejects.toThrow('API offline');
  expect(fixture.calls.slice(before).map((args) => args[0])).toEqual(['validate', 'reload']);
  expect(await fixture.gateway.inspect()).toEqual({
    revision: snapshot.revision,
    routes: 1,
    active: true,
  });
  expect(await readGatewayFile(config.gateway.clientCertificateFile)).toBe(renewed().certificate);
  expect(request).toHaveBeenCalledTimes(1);
});

it('keeps accepting route removals while certificate renewal is unavailable', async () => {
  await install();
  const fixture = caddyFixture();
  await fixture.gateway.start();
  await fixture.gateway.apply(snapshot);
  const pki = operations();
  pki.renew.mockRejectedValue(new Error(password));
  const log = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const revision = 'b'.repeat(64);
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ revision, routes: [] }))
    .mockResolvedValueOnce(Response.json({ revision, appliedAt: new Date(now).toISOString() }));
  const controller = createPublicGatewayController(config, {
    gateway: fixture.gateway,
    certificate: createGatewayCertificate(config, pki),
    fetch: request,
  });
  expect(await controller.synchronize()).toEqual({ revision, routes: 0, active: true });
  expect(JSON.stringify(log.mock.calls)).not.toContain(password);
});

function setupOperations() {
  return {
    generateKey: vi.fn(generateGatewayTlsKey),
    issue: vi.fn<NonNullable<Parameters<typeof setupHostingGateway>[1]>['issue']>(() =>
      Promise.resolve(renewed()),
    ),
    validate: operations().validate,
  };
}

it('preserves the key after uncertain setup and requires a fresh explicit attempt before signing again', async () => {
  const pki = setupOperations();
  const input = { controller: config, provisionerPasswordFile: join(directory, 'password') };
  pki.issue.mockRejectedValueOnce(new Error('Uncertain issuance.'));
  await expect(setupHostingGateway(input, pki)).rejects.toThrow('Uncertain issuance');
  const original = await readFile(config.gateway.clientKeyFile, 'utf8');
  await expect(setupHostingGateway(input, pki)).rejects.toThrow('--new-attempt');
  expect(pki.issue).toHaveBeenCalledTimes(1);
  const result = await setupHostingGateway({ ...input, newAttempt: randomUUID() }, pki);
  expect(pki.issue).toHaveBeenCalledTimes(2);
  expect(pki.issue.mock.calls[1]?.[1].privateKey).toBe(original.trim());
  expect(pki.generateKey).toHaveBeenCalledTimes(1);
  const saved = await readGatewayFile(result.configurationFile);
  expect(publicGatewayControllerSchema.parse(JSON.parse(saved))).toEqual(
    publicGatewayControllerSchema.parse(config),
  );
  expect(saved).not.toContain(password);
  expect(saved).not.toContain('provisioner');
  expect((await stat(config.gateway.clientKeyFile)).mode & 0o777).toBe(0o600);
  expect((await stat(result.configurationFile)).mode & 0o777).toBe(0o600);
});

it('does not recreate a missing original key after an uncertain setup attempt', async () => {
  const pki = setupOperations();
  pki.issue.mockRejectedValue(new Error('Uncertain issuance.'));
  const input = { controller: config, provisionerPasswordFile: join(directory, 'password') };
  await expect(setupHostingGateway(input, pki)).rejects.toThrow();
  await rm(config.gateway.clientKeyFile);
  await expect(setupHostingGateway({ ...input, newAttempt: randomUUID() }, pki)).rejects.toThrow(
    'Restore the original',
  );
  expect(pki.generateKey).toHaveBeenCalledTimes(1);
  expect(pki.issue).toHaveBeenCalledTimes(1);
});

it('recovers interrupted setup publication from the receipt without reading issuer credentials', async () => {
  const pki = setupOperations();
  pki.issue.mockImplementationOnce(async () => {
    await mkdir(config.gateway.clientCertificateFile);
    return renewed();
  });
  const input = { controller: config, provisionerPasswordFile: join(directory, 'password') };
  await expect(setupHostingGateway(input, pki)).rejects.toThrow('Gateway file');
  expect(
    gatewayCertificateReceiptSchema.parse(
      JSON.parse(await readGatewayFile(config.clientIdentity.receiptFile)),
    ).certificate,
  ).toBe(renewed().certificate);
  await rm(config.gateway.clientCertificateFile, { recursive: true });
  await rm(input.provisionerPasswordFile);
  const result = await setupHostingGateway(input, pki);
  expect(result.name).toBe(name);
  expect(pki.issue).toHaveBeenCalledTimes(1);
  expect(pki.generateKey).toHaveBeenCalledTimes(1);
  expect(await readGatewayFile(config.gateway.clientCertificateFile)).toBe(renewed().certificate);
});

it.each([-1, 20_000])(
  'requires explicit issuance recovery with the original key when the receipt expires in %s ms',
  async (remaining) => {
    await install();
    const originalKey = await readFile(config.gateway.clientKeyFile, 'utf8');
    const expired = receipt('old-certificate', new Date(now + remaining).toISOString());
    await writeFile(config.clientIdentity.receiptFile, JSON.stringify(expired));
    const before = await readGatewayFile(config.clientIdentity.receiptFile);
    const pki = setupOperations();
    const input = { controller: config, provisionerPasswordFile: join(directory, 'password') };
    await expect(setupHostingGateway(input, pki)).rejects.toThrow('--new-attempt');
    expect(pki.issue).not.toHaveBeenCalled();
    expect(await readGatewayFile(config.clientIdentity.receiptFile)).toBe(before);
    const attempt = { ...input, newAttempt: randomUUID() };
    const result = await setupHostingGateway(attempt, pki);
    expect(result.expiresAt).toBe(renewed().expiresAt);
    expect(pki.issue.mock.calls[0]?.[1].privateKey).toBe(originalKey.trim());
    expect(pki.generateKey).not.toHaveBeenCalled();
    expect(await readFile(config.gateway.clientKeyFile, 'utf8')).toBe(originalKey);
    await setupHostingGateway(attempt, pki);
    expect(pki.issue).toHaveBeenCalledTimes(1);
  },
);

it('retains the expired receipt when recovery issuance fails validation and never repeats that attempt', async () => {
  await install();
  await writeFile(
    config.clientIdentity.receiptFile,
    JSON.stringify(receipt('old-certificate', new Date(now - 1).toISOString())),
  );
  const previous = await readGatewayFile(config.clientIdentity.receiptFile);
  const pki = setupOperations();
  pki.validate.mockRejectedValue(new Error('Untrusted issued certificate.'));
  const attempt = {
    controller: config,
    provisionerPasswordFile: join(directory, 'password'),
    newAttempt: randomUUID(),
  };
  await expect(setupHostingGateway(attempt, pki)).rejects.toThrow('Untrusted issued');
  expect(await readGatewayFile(config.clientIdentity.receiptFile)).toBe(previous);
  expect(await readGatewayFile(config.gateway.clientCertificateFile)).toBe('old-certificate');
  await expect(setupHostingGateway(attempt, pki)).rejects.toThrow('--new-attempt');
  expect(pki.issue).toHaveBeenCalledTimes(1);
});

it('does not replace another gateway identity during expired-certificate recovery', async () => {
  await install();
  await writeFile(
    config.clientIdentity.receiptFile,
    JSON.stringify({
      ...receipt('old-certificate', new Date(now - 1).toISOString()),
      name: 'other.gateway.agent-cloud.internal',
    }),
  );
  const pki = setupOperations();
  await expect(
    setupHostingGateway(
      {
        controller: config,
        provisionerPasswordFile: join(directory, 'password'),
        newAttempt: randomUUID(),
      },
      pki,
    ),
  ).rejects.toThrow('another identity');
  expect(pki.issue).not.toHaveBeenCalled();
});

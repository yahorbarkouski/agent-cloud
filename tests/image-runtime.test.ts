import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { simulatedCatalog } from '../packages/contracts/dist/index.js';
import { createApp } from '../apps/control/dist/app.js';
import { readConfig } from '../apps/control/dist/config.js';
import { createImageRuntime } from '../apps/control/dist/image-runtime.js';
import { readRuntimeSigner } from '../apps/control/dist/runtime-pki.js';
import { initializeRuntimeIdentity } from '../apps/control/dist/runtime-identity.js';
import { imageRuntimeConfigSchema } from '../apps/control/dist/runtime-config.js';
import { createImageAccessStore } from '../apps/control/dist/image-access.js';
import {
  admitImageBuild,
  inspectImageBuild,
  requestImageCleanup,
} from '../apps/control/dist/image-builds.js';
import { requestImageRun } from '../apps/control/dist/image-scheduling.js';
import { imageBuildFixture } from './image-build-fixture.js';
import { seedAccount, testDatabase } from './database.js';

let database: Awaited<ReturnType<typeof testDatabase>>;
let root: string;
let directory: string;
beforeAll(async () => {
  database = await testDatabase();
  root = await mkdtemp(join(tmpdir(), 'agent-cloud-runtime-tests-'));
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
      '/CN=runtime-test',
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function scenario() {
  const config = readConfig({
    DATABASE_URL: database.databaseUrl,
    PROVIDER: 'hetzner',
    PROVIDER_CURRENCY: 'USD',
    MAX_PROVIDER_HOURLY: '0.03',
    PUBLIC_URL: 'https://control.example.test',
    HCLOUD_TOKEN_FILE: join(directory, 'token'),
    HCLOUD_SERVER_TYPE_SMALL: 'cpx12',
  });
  if (config.provider !== 'hetzner') throw new Error('Expected Hetzner fixture config.');
  await writeFile(config.providerTokenFile, 'fixture-token'.padEnd(64, 'x'), { mode: 0o600 });
  const runtime = imageRuntimeConfigSchema.parse({
    version: 1,
    mode: 'image_factory',
    identityDirectory: join(directory, 'identity'),
    images: {
      inputsDirectory: join(directory, 'inputs'),
      accessDirectory: join(directory, 'access'),
      limits: {
        currency: 'USD',
        maxOpenBuilds: 1,
        maxVmGrossMicros: 120000,
        maxSnapshotMonthlyGrossMicros: 1000000,
      },
    },
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
  await writeFile(runtime.pki.sshHostCaFile, 'ssh-ed25519 AAAA', { mode: 0o644 });
  await writeFile(runtime.pki.sshUserCaFile, 'ssh-ed25519 BBBB', { mode: 0o644 });
  await writeFile(runtime.pki.provisionerPasswordFile, 'fixture-password', { mode: 0o600 });
  const setup = await initializeRuntimeIdentity(runtime.identityDirectory);
  const signer = await readRuntimeSigner(runtime.pki);
  const staging = join(directory, 'staging');
  const fixture = await imageBuildFixture(staging, signer.trust);
  await mkdir(runtime.images.inputsDirectory);
  const sourceDirectory = join(
    runtime.images.inputsDirectory,
    fixture.admission.source.manifestDigest,
  );
  await rename(staging, sourceDirectory);
  const access = createImageAccessStore({ directory: runtime.images.accessDirectory });
  fixture.admission.access = await access.prepare({
    buildId: fixture.admission.id,
    manifestDigest: fixture.admission.source.manifestDigest,
    managementAddress: fixture.admission.access.managementAddress,
  });
  await admitImageBuild({ ...fixture, db: database.connection.db, sourceDirectory });
  const requests: { method: string; path: string }[] = [];
  let key: {
    id: number;
    labels: Record<string, string>;
    public_key: string;
    fingerprint: string;
  } | null = null;
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push({ method: request.method, path: url.pathname });
    const price = (gross: string) => ({ location: 'nbg1', price_hourly: { gross } });
    if (url.pathname === '/v1/pricing')
      return Response.json({
        pricing: {
          currency: 'USD',
          server_backup: { percentage: '20.0000000000' },
          server_types: [{ name: 'cpx12', prices: [price('0.026568')] }],
          primary_ips: [{ type: 'ipv4', prices: [price('0.00123')] }],
          image: { price_per_gb_month: { gross: '0.024477' } },
        },
      });
    if (url.pathname === '/v1/server_types')
      return Response.json({
        server_types: [
          {
            name: 'cpx12',
            architecture: 'x86',
            cores: 1,
            memory: 2,
            disk: 40,
            deprecated: false,
            locations: [{ name: 'nbg1', available: true }],
          },
        ],
        meta: { pagination: { next_page: null } },
      });
    if (url.pathname === '/v1/images/100')
      return Response.json({
        image: {
          id: 100,
          labels: {},
          type: 'system',
          status: 'available',
          architecture: 'x86',
          os_flavor: 'ubuntu',
          os_version: '24.04',
          disk_size: 10,
          image_size: null,
          created: null,
          created_from: null,
          protection: { delete: false },
          deprecated: null,
          deleted: null,
        },
      });
    if (url.pathname === '/v1/ssh_keys' && request.method === 'POST') {
      const body = z
        .object({ labels: z.record(z.string(), z.string()), public_key: z.string() })
        .parse(await request.json());
      key = { id: 501, ...body, fingerprint: 'fixture-fingerprint' };
      return Response.json({ ssh_key: key });
    }
    if (url.pathname === '/v1/ssh_keys')
      return Response.json({
        ssh_keys: key ? [key] : [],
        meta: { pagination: { next_page: null } },
      });
    if (url.pathname === '/v1/ssh_keys/501') {
      if (request.method === 'DELETE') {
        key = null;
        return new Response(null, { status: 204 });
      }
      return key
        ? Response.json({ ssh_key: key })
        : Response.json({ error: { code: 'not_found' } }, { status: 404 });
    }
    throw new Error('Unexpected fixture provider endpoint.');
  };
  const create = () =>
    createImageRuntime({ connection: database.connection, config, runtime, transport });
  const images = await create();
  const buildId = fixture.admission.id;
  return {
    config,
    runtime,
    setup,
    sourceDirectory,
    buildId,
    create,
    images,
    requests,
    inspect: () => inspectImageBuild(database.connection.db, buildId),
    start: () => requestImageRun(database.connection.db, buildId),
    advance: () => images.advance(buildId),
  };
}

it('does no provider I/O at startup or admission, disables authenticated customer calls, and serves enrollment validation', async () => {
  const f = await scenario();
  await f.images.checkConfiguration();
  await f.advance();
  expect(f.requests).toEqual([]);
  const account = await seedAccount(database.connection.db);
  const app = createApp({
    db: database.connection.db,
    provider: 'hetzner',
    limits: f.config.limits,
    catalog: () => simulatedCatalog(),
    customerAccess: 'disabled',
    imageEnrollment: f.images.enrollment,
  });
  expect((await app.request('/healthz')).status).toBe(200);
  expect(
    (
      await app.request('/v1/projects', {
        method: 'POST',
        headers: { Authorization: `Bearer ${account.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'should-not-exist' }),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await app.request('/image/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
  ).toBe(400);
  expect((await app.request('/guest/enroll', { method: 'POST' })).status).toBe(404);
  expect(f.requests).toEqual([]);
});

it('observes current prices before an effect and cancels further creation immediately after file-based revocation', async () => {
  const f = await scenario();
  await f.start();
  await f.advance();
  expect((await f.inspect()).effects[0]?.resolution.kind).toBe('confirmed');
  expect(f.requests.filter((r) => r.method === 'POST')).toEqual([
    { method: 'POST', path: '/v1/ssh_keys' },
  ]);
  expect(f.requests.findIndex((r) => r.path === '/v1/pricing')).toBeLessThan(
    f.requests.findIndex((r) => r.method === 'POST'),
  );
  await writeFile(
    join(f.runtime.identityDirectory, 'release-policy.json'),
    JSON.stringify({ version: 1, keys: [{ kind: 'revoked', keyId: f.setup.releaseKeyId }] }),
  );
  await f.advance();
  await f.advance();
  const final = await f.inspect();
  expect(final.state.kind).toBe('cleaned');
  expect(final.accessRemovedAt).not.toBeNull();
  expect(f.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  expect(f.requests.filter((r) => r.method === 'DELETE')).toEqual([
    { method: 'DELETE', path: '/v1/ssh_keys/501' },
  ]);
});

it('cleans exact owned resources after restart with missing identity, inputs, CA and provisioner credentials', async () => {
  const f = await scenario();
  await f.start();
  await f.advance();
  await requestImageCleanup(database.connection.db, f.buildId);
  await rm(f.runtime.identityDirectory, { recursive: true });
  await rm(f.runtime.images.inputsDirectory, { recursive: true });
  await rm(f.runtime.pki.provisionerPasswordFile);
  f.runtime.pki.tlsRootFile = join(directory, 'missing-ca');
  f.requests.splice(0);
  // New instance has no cached signer or sealing keys.
  const restarted = await f.create();
  await restarted.advance(f.buildId);
  await restarted.advance(f.buildId);
  expect((await f.inspect()).state.kind).toBe('cleaned');
  expect((await f.inspect()).accessRemovedAt).not.toBeNull();
  expect(
    f.requests.every((r) => r.path === '/v1/ssh_keys/501' && ['GET', 'DELETE'].includes(r.method)),
  ).toBe(true);
  expect(f.requests.filter((r) => r.method === 'DELETE')).toEqual([
    { method: 'DELETE', path: '/v1/ssh_keys/501' },
  ]);
});

it('does not expire an unstarted build when the host clock jumps forward past its database deadline', async () => {
  const f = await scenario();
  vi.spyOn(Date, 'now').mockReturnValue(
    Date.parse((await f.inspect()).admission.deadlineAt) + 60_000,
  );
  await f.advance();
  expect((await f.inspect()).state.kind).toBe('running');
  expect(f.requests).toEqual([]);
});

it('fails closed on a missing policy, then resumes using the repaired file without process restart', async () => {
  const f = await scenario();
  await f.start();
  const path = join(f.runtime.identityDirectory, 'release-policy.json');
  const original = await readFile(path);
  await rm(path);
  await expect(f.advance()).rejects.toMatchObject({ failure: { code: 'provider_unavailable' } });
  expect(f.requests).toEqual([]);
  await writeFile(path, original, { mode: 0o600 });
  await f.advance();
  expect((await f.inspect()).effects[0]?.resolution.kind).toBe('confirmed');
});

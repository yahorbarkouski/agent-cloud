import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  createImageReleaseKeySource,
  initializeRuntimeIdentity,
  readRuntimeIdentity,
  readBootstrapIdentity,
} from '../apps/control/dist/runtime-identity.js';
import {
  imageEnrollmentUrl,
  customerRuntimeConfigSchema,
  guestEnrollmentUrl,
  readRuntimeConfig,
  runtimeConfigSchema,
} from '../apps/control/dist/runtime-config.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agent-cloud-runtime-identity-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it('preserves bootstrap decryption, release identity and policy dates across repeated setup', async () => {
  const path = join(directory, 'identity');
  const created = await initializeRuntimeIdentity(path);
  const first = await readRuntimeIdentity(path);
  const token = first.seal.issue('fixture-owner');
  const policy = await readFile(join(path, 'release-policy.json'), 'utf8');
  const again = await initializeRuntimeIdentity(path, new Date(Date.now() + 86_400_000));
  expect(created.created).toBe(true);
  expect(again).toEqual({ ...created, created: false });
  expect(await readFile(join(path, 'release-policy.json'), 'utf8')).toBe(policy);
  const next = await readRuntimeIdentity(path);
  expect(next.seal.matches(next.seal.recover(token.sealed, 'fixture-owner'), token.hash)).toBe(
    true,
  );
  expect(() => next.seal.recover(token.sealed, 'different-owner')).toThrow();
});

it('reloads atomic policy replacement, empty trust and revocation without restarting', async () => {
  const path = join(directory, 'identity');
  const setup = await initializeRuntimeIdentity(path);
  const readKeys = createImageReleaseKeySource(path);
  expect(await readKeys()).toHaveLength(1);
  const replacement = join(path, 'replacement.json');
  await writeFile(
    replacement,
    JSON.stringify({ version: 1, keys: [{ kind: 'revoked', keyId: setup.releaseKeyId }] }),
    { mode: 0o600 },
  );
  await rename(replacement, join(path, 'release-policy.json'));
  expect(await readKeys()).toEqual([{ kind: 'revoked', keyId: setup.releaseKeyId }]);
  await writeFile(join(path, 'release-policy.json'), JSON.stringify({ version: 1, keys: [] }));
  expect(await readKeys()).toEqual([]);
  await rm(join(path, 'release-policy.json'));
  await expect(readKeys()).rejects.toMatchObject({
    failure: { code: 'provider_unavailable', retryable: true },
  });
});

it('refuses incomplete setup, substituted keys and unsafe identity permissions without replacing files', async () => {
  const partial = join(directory, 'partial');
  await mkdir(partial, { mode: 0o700 });
  await writeFile(join(partial, 'bootstrap.key'), 'preserve-this-file', { mode: 0o600 });
  await expect(initializeRuntimeIdentity(partial)).rejects.toThrow('incomplete');
  expect(await readFile(join(partial, 'bootstrap.key'), 'utf8')).toBe('preserve-this-file');
  const path = join(directory, 'identity');
  await initializeRuntimeIdentity(path);
  await chmod(path, 0o755);
  await expect(readRuntimeIdentity(path)).rejects.toThrow();
  await chmod(path, 0o700);
  const pair = generateKeyPairSync('ed25519');
  await writeFile(
    join(path, 'release.key'),
    pair.privateKey.export({ format: 'pem', type: 'pkcs8' }),
  );
  await expect(readRuntimeIdentity(path)).rejects.toThrow('inconsistent');
  const link = join(directory, 'link');
  await symlink(path, link);
  await expect(readRuntimeIdentity(link)).rejects.toThrow();
});

it('rejects malformed or duplicate key policies and world-writable public policy files', async () => {
  const path = join(directory, 'identity');
  await initializeRuntimeIdentity(path);
  const source = createImageReleaseKeySource(path);
  const keys = await source();
  await writeFile(
    join(path, 'release-policy.json'),
    JSON.stringify({ version: 1, keys: [...keys, ...keys] }),
  );
  await expect(source()).rejects.toThrow('invalid');
  await writeFile(join(path, 'release-policy.json'), '{invalid');
  await expect(source()).rejects.toThrow('invalid');
  await writeFile(join(path, 'release-policy.json'), JSON.stringify({ version: 1, keys }));
  await chmod(join(path, 'release-policy.json'), 0o666);
  await expect(source()).rejects.toThrow('invalid');
});

it('accepts only bounded private factory configuration and a credential-free HTTPS origin', async () => {
  const config = {
    version: 1,
    mode: 'image_factory',
    identityDirectory: join(directory, 'identity'),
    images: {
      inputsDirectory: directory,
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
      tlsRootFile: join(directory, 'root'),
      sshHostCaFile: join(directory, 'host'),
      sshUserCaFile: join(directory, 'user'),
      provisioner: 'fixture',
      provisionerPasswordFile: join(directory, 'password'),
    },
  };
  const customer = {
    version: 1,
    mode: 'customer',
    identityDirectory: config.identityDirectory,
    pki: config.pki,
    releaseBuildId: 'c264e837-761a-48af-ac30-d5d7a6709e89',
    firewallIds: [123],
  };
  expect(customerRuntimeConfigSchema.parse(customer)).toEqual(customer);
  expect(customerRuntimeConfigSchema.safeParse({ ...customer, firewallIds: [] }).success).toBe(
    false,
  );
  expect(
    customerRuntimeConfigSchema.safeParse({ ...customer, firewallIds: [123, 123] }).success,
  ).toBe(false);
  expect(
    customerRuntimeConfigSchema.safeParse({ ...customer, images: config.images }).success,
  ).toBe(false);
  expect(guestEnrollmentUrl('https://control.example.test')).toBe(
    'https://control.example.test/guest/enroll',
  );
  const path = join(directory, 'runtime.json');
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  expect(await readRuntimeConfig(path)).toEqual(config);
  expect(runtimeConfigSchema.safeParse({ ...config, mode: 'cloud' }).success).toBe(false);
  expect(runtimeConfigSchema.safeParse({ ...config, identityDirectory: 'relative' }).success).toBe(
    false,
  );
  await chmod(path, 0o644);
  await expect(readRuntimeConfig(path)).rejects.toThrow('owner-only');
  expect(imageEnrollmentUrl('https://control.example.test')).toBe(
    'https://control.example.test/image/enroll',
  );
  for (const value of [
    'http://control.example.test',
    'https://user:password@example.test',
    'https://example.test/prefix',
    'https://example.test?token=x',
    'https://example.test#fragment',
  ])
    expect(() => imageEnrollmentUrl(value)).toThrow();
});

it('customer identity recovery works without a release private key and still rejects substituted bootstrap material', async () => {
  const path = join(directory, 'customer');
  await initializeRuntimeIdentity(path);
  const first = await readBootstrapIdentity(path);
  const issued = first.seal.issue('customer-owner');
  await rm(join(path, 'release.key'));
  const next = await readBootstrapIdentity(path);
  expect(next.seal.matches(next.seal.recover(issued.sealed, 'customer-owner'), issued.hash)).toBe(
    true,
  );
  await expect(readRuntimeIdentity(path)).rejects.toThrow('incomplete');
  await writeFile(join(path, 'bootstrap.key'), 'changed');
  await expect(readBootstrapIdentity(path)).rejects.toThrow('inconsistent');
});

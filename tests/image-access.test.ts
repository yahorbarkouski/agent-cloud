import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { imageBuildIdSchema } from '../packages/contracts/dist/index.js';
import { createImageAccessStore } from '../apps/control/dist/image-access.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agent-cloud-image-access-test-'));
});

it('removes only matching access and tolerates concurrent cleanup and a restarted caller', async () => {
  const { root, identity, store } = fixture();
  const access = await store.prepare(identity);
  const binding = {
    id: identity.buildId,
    source: { manifestDigest: identity.manifestDigest },
    access,
  };
  const foreign = await store.prepare({
    ...identity,
    buildId: imageBuildIdSchema.parse(randomUUID()),
  });
  await Promise.all(Array.from({ length: 4 }, () => store.remove(binding)));
  await createImageAccessStore({ directory: root }).remove(binding);
  const remaining = await readdir(root);
  expect(remaining).toHaveLength(1);
  expect(remaining).not.toContain(identity.buildId);
  expect(foreign.secretId).not.toBe(access.secretId);
  await expect(store.recover(binding)).rejects.toThrow();
});

it.each(['manifest', 'secret', 'missing_metadata'])(
  'preserves keys when terminal cleanup finds %s disagreement',
  async (change) => {
    const { root, identity, store } = fixture();
    const access = await store.prepare(identity);
    const binding = {
      id: identity.buildId,
      source: { manifestDigest: identity.manifestDigest },
      access: { ...access },
    };
    if (change === 'manifest') binding.source.manifestDigest = 'b'.repeat(64);
    if (change === 'secret') binding.access.secretId = randomUUID();
    if (change === 'missing_metadata') await rm(join(root, identity.buildId, 'metadata.json'));
    const before = await readFile(join(root, identity.buildId, 'management'));
    await expect(store.remove(binding)).rejects.toThrow('Terminal image access cleanup');
    expect(await readFile(join(root, identity.buildId, 'management'))).toEqual(before);
  },
);

it('resumes cleanup after the directory was renamed and only part of its contents were removed', async () => {
  const { root, identity, store } = fixture();
  const access = await store.prepare(identity);
  const retiring = join(root, `.removing-${identity.buildId}-${access.secretId}`);
  await rename(join(root, identity.buildId), retiring);
  await rm(join(retiring, 'metadata.json'));
  await rm(join(retiring, 'management'));
  await createImageAccessStore({ directory: root }).remove({
    id: identity.buildId,
    source: { manifestDigest: identity.manifestDigest },
    access,
  });
  expect(await readdir(root)).toEqual([]);
});

it('refuses a foreign directory symlink and leaves unexpected files for explicit recovery', async () => {
  const { root, identity, store } = fixture();
  const access = await store.prepare(identity);
  const binding = {
    id: identity.buildId,
    source: { manifestDigest: identity.manifestDigest },
    access,
  };
  const destination = join(root, identity.buildId);
  const foreign = join(directory, 'foreign');
  await rename(destination, foreign);
  await symlink(foreign, destination);
  await expect(store.remove(binding)).rejects.toThrow('Terminal image access cleanup');
  expect(await readdir(foreign)).toContain('management');
  await rm(destination);
  await rename(foreign, destination);
  await writeFile(join(destination, 'unexpected'), 'leave me', { mode: 0o600 });
  await expect(store.remove(binding)).rejects.toThrow('Terminal image access cleanup');
  expect(
    await readFile(
      join(root, `.removing-${identity.buildId}-${access.secretId}`, 'unexpected'),
      'utf8',
    ),
  ).toBe('leave me');
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
function fixture() {
  const root = join(directory, 'secrets');
  const identity = {
    buildId: imageBuildIdSchema.parse(randomUUID()),
    manifestDigest: 'a'.repeat(64),
    managementAddress: '203.0.113.7',
  };
  return { root, identity, store: createImageAccessStore({ directory: root }) };
}

it('publishes one recoverable pair of independent keys across concurrent preparations and process restarts', async () => {
  const { root, identity, store } = fixture();
  const results = await Promise.all(Array.from({ length: 4 }, () => store.prepare(identity)));
  const access = results[0];
  if (!access) throw new Error('Expected prepared keys.');
  expect(results.every((result) => JSON.stringify(result) === JSON.stringify(access))).toBe(true);
  expect(access.hostPublicKey).not.toBe(access.publicKey);
  const binding = {
    id: identity.buildId,
    source: { manifestDigest: identity.manifestDigest },
    access,
  };
  const material = await store.recover(binding);
  const restarted = createImageAccessStore({ directory: root });
  expect(await restarted.prepare(identity)).toEqual(access);
  expect(await restarted.recover(binding)).toEqual(material);
  expect(await readdir(root)).toEqual([identity.buildId]);
  for (const path of [
    root,
    join(root, identity.buildId),
    join(root, identity.buildId, 'host'),
    join(root, identity.buildId, 'management'),
    join(root, identity.buildId, 'metadata.json'),
  ])
    expect((await lstat(path)).mode & 0o077).toBe(0);
});

it.each(['manifest', 'address', 'secret', 'public_key'])(
  'refuses recovery after the admitted %s binding changes',
  async (change) => {
    const { identity, store } = fixture();
    const access = await store.prepare(identity);
    const binding = {
      id: identity.buildId,
      source: { manifestDigest: identity.manifestDigest },
      access,
    };
    if (change === 'manifest') binding.source.manifestDigest = 'b'.repeat(64);
    if (change === 'address') binding.access.managementAddress = '203.0.113.8';
    if (change === 'secret') binding.access.secretId = randomUUID();
    if (change === 'public_key') binding.access.publicKey = access.hostPublicKey;
    await expect(store.recover(binding)).rejects.toThrow('does not match');
  },
);

it('refuses to replace an incomplete existing build directory or reuse it for another image', async () => {
  const { root, identity, store } = fixture();
  const access = await store.prepare(identity);
  await expect(store.prepare({ ...identity, manifestDigest: 'b'.repeat(64) })).rejects.toThrow(
    'another build',
  );
  const key = await readFile(join(root, identity.buildId, 'management'));
  await rm(join(root, identity.buildId, 'metadata.json'));
  await expect(store.prepare(identity)).rejects.toThrow();
  expect(await readFile(join(root, identity.buildId, 'management'))).toEqual(key);
  expect(access.publicKey).toMatch(/^ssh-ed25519 /);
});

it.each([
  'store_mode',
  'directory_mode',
  'key_mode',
  'key_symlink',
  'directory_symlink',
  'wrong_private_key',
])('refuses %s without exposing key contents', async (change) => {
  const { root, identity, store } = fixture();
  const access = await store.prepare(identity);
  const build = join(root, identity.buildId);
  const key = join(build, 'host');
  const before = await readFile(key, 'utf8');
  if (change === 'store_mode') await chmod(root, 0o755);
  if (change === 'directory_mode') await chmod(build, 0o755);
  if (change === 'key_mode') await chmod(key, 0o644);
  if (change === 'key_symlink') {
    await rm(key);
    await symlink(join(build, 'management'), key);
  }
  if (change === 'wrong_private_key') await copyFile(join(build, 'management'), key);
  if (change === 'directory_symlink') {
    await rm(build, { recursive: true });
    await mkdir(join(directory, 'foreign'), { mode: 0o700 });
    await symlink(join(directory, 'foreign'), build);
  }
  await expect(
    store.recover({
      id: identity.buildId,
      source: { manifestDigest: identity.manifestDigest },
      access,
    }),
  ).rejects.toMatchObject({
    message: 'Image builder access is unavailable or does not match its admission.',
  });
  expect(before).toContain('OPENSSH PRIVATE KEY');
});

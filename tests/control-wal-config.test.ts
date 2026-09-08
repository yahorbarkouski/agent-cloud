import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { initializeControlWal } from '../apps/control/src/control-wal-config.js';

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'acld-control-wal-config-'));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

it('creates private independent encryption authority and preserves it on retries', async () => {
  const path = join(directory, 'pgbackrest.conf');
  await initializeControlWal(path);
  const original = await readFile(path, 'utf8');
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(original).toMatch(/^repo1-cipher-pass=[a-f0-9]{64}$/m);
  expect(original).toContain('repo1-cipher-type=aes-256-cbc');
  await initializeControlWal(path);
  expect(await readFile(path, 'utf8')).toBe(original);
  const another = join(directory, 'another.conf');
  await initializeControlWal(another);
  expect(await readFile(another, 'utf8')).not.toBe(original);
});

it('refuses partial, linked, permissive or modified configuration without replacing it', async () => {
  const partial = join(directory, 'partial.conf');
  await writeFile(partial, 'repo1-cipher-pass=partial', { mode: 0o600 });
  await expect(initializeControlWal(partial)).rejects.toThrow(
    'Existing WAL configuration is invalid',
  );
  expect(await readFile(partial, 'utf8')).toBe('repo1-cipher-pass=partial');
  const link = join(directory, 'link.conf');
  await symlink(partial, link);
  await expect(initializeControlWal(link)).rejects.toThrow();
  const permissive = join(directory, 'permissive.conf');
  await initializeControlWal(permissive);
  await chmod(permissive, 0o644);
  await expect(initializeControlWal(permissive)).rejects.toThrow('Operator secret must');
  expect((await stat(permissive)).mode & 0o777).toBe(0o644);
  const modified = join(directory, 'modified.conf');
  await initializeControlWal(modified);
  const changed = (await readFile(modified, 'utf8')).replace('archive-async=n', 'archive-async=y');
  await writeFile(modified, changed, { mode: 0o600 });
  await expect(initializeControlWal(modified)).rejects.toThrow(
    'Existing WAL configuration is invalid',
  );
  expect(await readFile(modified, 'utf8')).toBe(changed);
});

it('concurrent initializers converge on the same key; a partial observer can retry', async () => {
  const path = join(directory, 'concurrent.conf');
  const attempts = await Promise.allSettled([
    initializeControlWal(path),
    initializeControlWal(path),
  ]);
  expect(attempts.some((attempt) => attempt.status === 'fulfilled')).toBe(true);
  const before = await readFile(path, 'utf8');
  await initializeControlWal(path);
  expect(await readFile(path, 'utf8')).toBe(before);
});

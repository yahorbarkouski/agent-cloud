import { execFile } from 'node:child_process';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { atomicWrite, readOwnedFile } from '../packages/guestctl/src/files.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agent-cloud-guest-files-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test('public proof is readable under the restrictive systemd umask', async () => {
  const module = pathToFileURL(resolve('packages/guestctl/dist/files.js')).href;
  const destination = join(directory, 'proof.json');
  await promisify(execFile)(process.execPath, [
    '--input-type=module',
    '-e',
    'process.umask(0o077); const { atomicWrite } = await import(process.argv[1]); await atomicWrite(process.argv[2], "public-proof", 0o644);',
    module,
    destination,
  ]);
  expect((await lstat(destination)).mode & 0o777).toBe(0o644);
  expect(await readOwnedFile(destination, 'public')).toBe('public-proof');
});

test('private state refuses symlinks, excessive size and group-readable permissions', async () => {
  const path = join(directory, 'private');
  await writeFile(path, 'identity', { mode: 0o600 });
  await symlink(path, join(directory, 'link'));
  await expect(readOwnedFile(join(directory, 'link'), 'private')).rejects.toThrow();
  await expect(readOwnedFile(path, 'private', 3)).rejects.toThrow('size');
  await chmod(path, 0o640);
  await expect(readOwnedFile(path, 'private')).rejects.toThrow('permissions');
});

test('atomic state replacement never follows a destination symlink', async () => {
  const target = join(directory, 'other');
  const destination = join(directory, 'state');
  await writeFile(target, 'unchanged');
  await symlink(target, destination);
  await atomicWrite(destination, 'new-state', 0o600);
  expect(await readFile(target, 'utf8')).toBe('unchanged');
  expect(await readOwnedFile(destination, 'private')).toBe('new-state');
});

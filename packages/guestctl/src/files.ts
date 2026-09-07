import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

export function isMissing(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
export function isExisting(error: unknown) {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'EEXIST' || error.code === 'ENOTEMPTY')
  );
}
export async function readOwnedFile(
  path: string,
  access: 'private' | 'public',
  maximum = 65_536,
  owner = process.getuid?.(),
) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== owner ||
      stat.size > maximum ||
      stat.mode & (access === 'private' ? 0o077 : 0o022)
    )
      throw new Error('Guest state file ownership, permissions or size are invalid.');
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}
export async function ensureDirectory(path: string, mode: number) {
  const created = await mkdir(path, { recursive: true, mode });
  if (created !== undefined) await chmod(path, mode);
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & ~0o170000) !== mode
  )
    throw new Error('Guest state directory ownership or permissions are invalid.');
}
export async function syncDirectory(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function atomicWrite(path: string, content: string, mode: number) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(content);
      // systemd uses UMask=0077. Publish the requested public/group access explicitly.
      await file.chmod(mode);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
}

import { constants } from 'node:fs';
import { mkdir, open, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { CloudError } from '@agent-cloud/contracts';

/** Never steal a lock on a timer: a suspended login could still issue a credential. */
export async function withCredentialLock<T>(
  path: string,
  action: (path: string) => Promise<T>,
): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const canonical = join(await realpath(dirname(path)), basename(path));
  const lock = `${canonical}.lock`;
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      throw new CloudError(
        'version_conflict',
        `Credential operation is locked at ${lock}. If its process exited, remove that lock directory before retrying. Never remove a live login lock.`,
      );
    throw error;
  }
  try {
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }), {
      mode: 0o600,
      flag: 'wx',
    });
    return await action(canonical);
  } finally {
    await unlink(join(lock, 'owner.json')).catch((error: unknown) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    });
    await rmdir(lock);
  }
}

export async function syncCredentialDirectories(path: string) {
  // A retry cannot know which ancestors a previous interrupted attempt created.
  for (let directory = dirname(path); ; directory = dirname(directory)) {
    const handle = await open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (dirname(directory) === directory) break;
  }
}

export async function readCredential(path: string) {
  const file = await open(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.size > 16_384 ||
      info.mode & 0o077 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new CloudError(
        'permission_denied',
        'Credentials must be a small owner-only regular file.',
      );
    const buffer = Buffer.alloc(16_385);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > 16_384)
      throw new CloudError('invalid_input', 'Credentials exceed their size limit.');
    const value: unknown = JSON.parse(buffer.subarray(0, size).toString('utf8'));
    await file.sync();
    await syncCredentialDirectories(path);
    return value;
  } finally {
    await file.close();
  }
}

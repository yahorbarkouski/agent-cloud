import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

/** Read an operator secret without following a symlink or trusting a stale permission check. */
export async function readPrivateFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      (info.mode & 0o077) !== 0 ||
      info.size > 16_384 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error(
        'Operator secret must be a small owner-only regular file owned by this process user.',
      );
    return (await file.readFile('utf8')).trim();
  } finally {
    await file.close();
  }
}

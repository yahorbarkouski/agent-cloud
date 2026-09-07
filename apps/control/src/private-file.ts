import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

/** Read an operator secret without following a symlink or trusting a stale permission check. */
export async function readPrivateFile(path: string): Promise<string> {
  return readOperatorFile(path, 'private');
}

/** Public CA files may be readable, but may not be writable by other users. */
export async function readPublicTrustFile(path: string): Promise<string> {
  return readOperatorFile(path, 'public');
}

async function readOperatorFile(path: string, access: 'private' | 'public'): Promise<string> {
  const maximum = access === 'private' ? 16_384 : 65_536;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      (info.mode & (access === 'private' ? 0o077 : 0o022)) !== 0 ||
      info.size > maximum ||
      (process.getuid && info.uid !== process.getuid() && !(access === 'public' && info.uid === 0))
    )
      throw new Error(
        'Operator secret must be a small owner-only regular file owned by this process user.',
      );
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > maximum) throw new Error('Operator file exceeds its size limit.');
    return bytes.subarray(0, length).toString('utf8').trim();
  } finally {
    await file.close();
  }
}

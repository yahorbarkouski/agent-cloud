import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, rm, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { Readable } from 'node:stream';

export async function openCiphertext(path: string, maxBytes: number) {
  if (!isAbsolute(path)) throw new Error('An absolute ciphertext path is required.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077 ||
      info.size < 1 ||
      info.size > maxBytes
    )
      throw new Error('Ciphertext must be a bounded owner-only regular file.');
    return { file, info };
  } catch (error) {
    await file.close();
    throw error;
  }
}

export async function hashFile(file: FileHandle, size: number) {
  const sha256 = createHash('sha256');
  const md5 = createHash('md5');
  const buffer = Buffer.alloc(Math.min(size, 65_536));
  let position = 0;
  while (position < size) {
    const { bytesRead } = await file.read(
      buffer,
      0,
      Math.min(buffer.length, size - position),
      position,
    );
    if (!bytesRead) throw new Error('Ciphertext changed during hashing.');
    sha256.update(buffer.subarray(0, bytesRead));
    md5.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return { ciphertextSha256: sha256.digest('hex'), contentMd5: md5.digest('base64'), size };
}

export async function readCiphertext(
  body: unknown,
  expected: { size: number; ciphertextSha256: string },
  timeout: number,
  destination?: FileHandle,
) {
  if (!(body instanceof Readable)) throw new Error('S3 did not return a Node readable body.');
  const timer = setTimeout(
    () => body.destroy(new Error('Ciphertext transfer timed out.')),
    timeout,
  );
  timer.unref();
  const sha256 = createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of body) {
      const value: unknown = chunk;
      if (!Buffer.isBuffer(value)) throw new Error('S3 returned an invalid body chunk.');
      size += value.length;
      if (size > expected.size) throw new Error('Ciphertext exceeds its recorded size.');
      sha256.update(value);
      if (destination) await destination.writeFile(value);
    }
    if (size !== expected.size || sha256.digest('hex') !== expected.ciphertextSha256)
      throw new Error('Ciphertext digest or size differs from its receipt.');
  } finally {
    clearTimeout(timer);
    body.destroy();
  }
}

/** Publish only verified bytes, without replacing any pre-existing destination. */
export async function downloadFile<T>(path: string, work: (file: FileHandle) => Promise<T>) {
  if (!isAbsolute(path)) throw new Error('An absolute destination is required.');
  const directory = dirname(path);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || info.mode & 0o077)
    throw new Error('Download requires an owner-only destination directory.');
  const temporary = join(directory, `.${randomUUID()}.download`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    let result: T;
    try {
      result = await work(file);
      await file.sync();
    } finally {
      await file.close();
    }
    await link(temporary, path);
    const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    return result;
  } finally {
    await rm(temporary, { force: true });
  }
}

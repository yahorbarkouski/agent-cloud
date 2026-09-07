import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, realpath, type FileHandle } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { pack, extract } from 'tar-stream';
import { CloudError, composePathSchema } from '@agent-cloud/contracts';
import { syncDirectory } from './files.js';

export type BackupBudget = { maximum: number; signal: AbortSignal };
export async function* readBackupHandle(file: FileHandle, signal: AbortSignal) {
  for (;;) {
    signal.throwIfAborted();
    const buffer = Buffer.alloc(65_536);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
    if (!bytesRead) return;
    yield buffer.subarray(0, bytesRead);
  }
}
export async function* readBackupStream(path: string, signal: AbortSignal) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error('Backup input must be a regular file.');
    yield* readBackupHandle(file, signal);
  } finally {
    await file.close();
  }
}
const chunkBytes = (value: unknown) => {
  if (!(value instanceof Uint8Array)) throw new Error('Backup stream returned invalid bytes.');
  return value;
};
function drained(
  stream: {
    once: (event: string, callback: () => void) => unknown;
    off: (event: string, callback: () => void) => unknown;
    destroyed: boolean;
    destroying: boolean;
  },
  signal: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      stream.off('drain', ready);
      stream.off('close', closed);
      stream.off('error', closed);
      signal.removeEventListener('abort', closed);
      if (error) reject(error);
      else resolve();
    };
    const ready = () => {
      finish();
    };
    const closed = () => {
      finish(new Error('Backup archive stream closed before draining.'));
    };
    stream.once('drain', ready);
    stream.once('close', closed);
    stream.once('error', closed);
    signal.addEventListener('abort', closed, { once: true });
    if (stream.destroyed || stream.destroying || signal.aborted) closed();
  });
}

/** Writes only a new regular file. Archive and subprocess bytes never become shell text. */
export async function writeBackupStream(
  path: string,
  source: AsyncIterable<unknown>,
  budget: BackupBudget,
) {
  const file = await open(path, 'wx', 0o600);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const value of source) {
      budget.signal.throwIfAborted();
      const chunk = chunkBytes(value);
      bytes += chunk.byteLength;
      if (bytes > budget.maximum)
        throw new CloudError('quota_exceeded', 'Backup data exceeds its admitted byte limit.');
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    await file.sync();
    return { bytes, sha256: hash.digest('hex') };
  } finally {
    await file.close();
  }
}

export async function hashBackupFile(path: string, budget: BackupBudget) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > budget.maximum || info.mode & 0o077)
      throw new Error('Backup artifact is not a bounded private regular file.');
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const value of readBackupHandle(file, budget.signal)) {
      budget.signal.throwIfAborted();
      const chunk = chunkBytes(value);
      bytes += chunk.byteLength;
      if (bytes > budget.maximum) throw new Error('Backup artifact grew beyond its limit.');
      hash.update(chunk);
    }
    return { bytes, sha256: hash.digest('hex') };
  } finally {
    await file.close();
  }
}

export async function packBackup(
  path: string,
  files: Array<{ name: string; path: string }>,
  budget: BackupBudget,
) {
  const archive = pack();
  const writing = writeBackupStream(path, archive, budget);
  // Attach rejection before feeding entries; output failure must release a blocked archive writer.
  const observed = writing.catch((error: unknown) => {
    archive.destroy(new Error('Backup archive output failed.'));
    throw error;
  });
  void observed.catch(() => {});
  try {
    for (const item of files) {
      budget.signal.throwIfAborted();
      const info = await lstat(item.path);
      if (!info.isFile()) throw new Error('Archive inputs must be regular files.');
      const completed = Promise.withResolvers<undefined>();
      const entry = archive.entry(
        { name: item.name, size: info.size, type: 'file', mode: 0o600 },
        (error) => {
          if (error) completed.reject(error);
          else completed.resolve(undefined);
        },
      );
      void completed.promise.catch(() => {});
      for await (const value of readBackupStream(item.path, budget.signal)) {
        if (!entry.write(chunkBytes(value))) await drained(entry, budget.signal);
      }
      entry.end(Buffer.alloc(0));
      await completed.promise;
    }
    archive.finalize();
    return await observed;
  } catch (error) {
    archive.destroy(new Error('Backup archive creation failed.'));
    await observed.catch(() => {});
    throw error;
  }
}

/** tar-stream parses bytes only. We supply every output path and reject all link/device entries. */
export async function unpackBackup(path: string, directory: string, budget: BackupBudget) {
  const archive = extract();
  const source = readBackupStream(path, budget.signal);
  const names = new Set<string>();
  let total = 0;
  const feeding = (async () => {
    try {
      for await (const value of source) {
        if (!archive.write(chunkBytes(value))) await drained(archive, budget.signal);
      }
      archive.end(Buffer.alloc(0));
    } catch (error) {
      archive.destroy(new Error('Backup archive input failed.'));
      throw error;
    }
  })();
  void feeding.catch(() => {});
  try {
    for await (const entry of archive) {
      const { name, type, size, linkname } = entry.header;
      if (
        type !== 'file' ||
        linkname ||
        !/^(metadata\.json|database\.dump|globals\.sql|file-[0-9]{1,2})$/.test(name) ||
        names.has(name) ||
        names.size >= 103 ||
        !Number.isSafeInteger(size) ||
        size < 0
      )
        throw new CloudError(
          'invalid_input',
          'Backup archive has an unexpected or duplicate entry.',
        );
      total += size;
      if (total > budget.maximum)
        throw new CloudError('quota_exceeded', 'Backup archive entries exceed their byte limit.');
      names.add(name);
      const written = await writeBackupStream(join(directory, name), entry, {
        ...budget,
        maximum: size,
      });
      if (written.bytes !== size) throw new Error('Backup archive entry was truncated.');
    }
    await feeding;
    return names;
  } catch (error) {
    archive.destroy(new Error('Backup archive rejected.'));
    await feeding.catch(() => {});
    throw error;
  }
}

/** No path component beneath the customer directory may be a symlink. */
export async function customerFile(root: string, relative: string, createParents = false) {
  composePathSchema.parse(relative);
  const canonical = await realpath(root);
  const parts = relative.split('/');
  let parent = canonical;
  for (const part of parts.slice(0, -1)) {
    const path = join(parent, part);
    if (createParents) {
      await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      });
      await syncDirectory(parent);
    }
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new CloudError('invalid_input', 'Declared file parents must be real directories.');
    parent = path;
  }
  const path = join(canonical, relative);
  if (!path.startsWith(canonical + sep) || dirname(path) !== parent)
    throw new CloudError('invalid_input', 'Declared file escaped the customer directory.');
  return path;
}

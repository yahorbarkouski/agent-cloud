import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  BackupStoreError,
  createBackupReader,
  createBackupWriter,
  type BackupObjectReceipt,
  type BackupStoreConfiguration,
} from '../packages/backup-store/src/index.js';

type ObjectVersion = {
  key: string;
  versionId: string;
  body: Buffer;
  metadata: Record<string, string>;
  mode: string;
  retainUntil: string;
};
const xml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const md5 = (value: Buffer) => createHash('md5').update(value).digest('base64');
const writerCredentials = { accessKeyId: 'writer-key', secretAccessKey: 'private-writer-secret' };
const readerCredentials = { accessKeyId: 'reader-key', secretAccessKey: 'private-reader-secret' };
async function bytes(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const value: unknown = chunk;
    if (!Buffer.isBuffer(value)) throw new Error('Unexpected fixture input.');
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** This is a local S3 wire-protocol fixture, not proof of any provider's retention enforcement. */
async function fixture() {
  const versions: ObjectVersion[] = [];
  const calls: Array<{ method: string; path: string; headers: IncomingMessage['headers'] }> = [];
  const faults = {
    versioning: 'Enabled',
    objectLock: 'Enabled',
    deny: '',
    losePutReply: false,
    rejectConditional: false,
    latestDeleteMarker: false,
    corruptDownload: false,
    malformedVersion: false,
    truncatedListing: false,
    duringPut: (): Promise<void> => Promise.resolve(),
  };
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
      const method = request.method ?? '';
      calls.push({ method, path: url.pathname + url.search, headers: request.headers });
      response.setHeader('content-type', 'application/xml');
      function error(status: number, code: string) {
        response.writeHead(status);
        response.end(`<Error><Code>${code}</Code><Message>private-writer-secret</Message></Error>`);
      }
      const operation = url.searchParams.has('versioning')
        ? 'versioning'
        : url.searchParams.has('object-lock')
          ? 'object-lock'
          : url.searchParams.has('versions')
            ? 'versions'
            : url.searchParams.has('retention')
              ? 'retention'
              : method;
      if (faults.deny === operation) {
        error(403, 'AccessDenied');
        return;
      }
      if (method === 'PUT') {
        if (!request.headers.authorization?.includes('Credential=writer-key/')) {
          error(403, 'AccessDenied');
          return;
        }
        if (faults.rejectConditional) {
          error(501, 'NotImplemented');
          return;
        }
        if (request.headers['if-none-match'] !== '*') {
          error(400, 'MissingCondition');
          return;
        }
        if (versions.some((version) => version.key === key) && !faults.latestDeleteMarker) {
          error(412, 'PreconditionFailed');
          return;
        }
        await faults.duringPut();
        const body = await bytes(request);
        if (request.headers['content-md5'] !== md5(body)) {
          error(400, 'BadDigest');
          return;
        }
        const mode = request.headers['x-amz-object-lock-mode'];
        const retainUntil = request.headers['x-amz-object-lock-retain-until-date'];
        if (typeof mode !== 'string' || typeof retainUntil !== 'string') {
          error(400, 'InvalidRetention');
          return;
        }
        const metadata: Record<string, string> = {};
        for (const [header, value] of Object.entries(request.headers))
          if (header.startsWith('x-amz-meta-') && typeof value === 'string')
            metadata[header.slice(11)] = value;
        const versionId = randomUUID();
        versions.push({ key, versionId, body, metadata, mode, retainUntil });
        if (faults.losePutReply) {
          request.socket.destroy();
          return;
        }
        response.setHeader('x-amz-version-id', faults.malformedVersion ? 'null' : versionId);
        response.setHeader('etag', '"fixture-etag-is-not-the-sha256"');
        response.end();
        return;
      }
      if (operation === 'versioning') {
        response.end(
          `<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>${faults.versioning}</Status></VersioningConfiguration>`,
        );
        return;
      }
      if (operation === 'object-lock') {
        response.end(
          `<ObjectLockConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><ObjectLockEnabled>${faults.objectLock}</ObjectLockEnabled></ObjectLockConfiguration>`,
        );
        return;
      }
      if (operation === 'versions') {
        const prefix = url.searchParams.get('prefix') ?? '';
        response.end(
          `<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>backup-bucket</Name><IsTruncated>${faults.truncatedListing}</IsTruncated>${versions
            .filter((version) => version.key.startsWith(prefix))
            .map(
              (version) =>
                `<Version><Key>${xml(version.key)}</Key><VersionId>${version.versionId}</VersionId><Size>${version.body.length}</Size><IsLatest>${!faults.latestDeleteMarker}</IsLatest></Version>`,
            )
            .join(
              '',
            )}${faults.latestDeleteMarker ? `<DeleteMarker><Key>${xml(prefix)}</Key><VersionId>marker</VersionId><IsLatest>true</IsLatest></DeleteMarker>` : ''}</ListVersionsResult>`,
        );
        return;
      }
      const version = versions.find(
        (version) => version.key === key && version.versionId === url.searchParams.get('versionId'),
      );
      if (!version) {
        error(404, 'NoSuchVersion');
        return;
      }
      if (operation === 'retention') {
        response.end(
          `<Retention xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Mode>${version.mode}</Mode><RetainUntilDate>${version.retainUntil}</RetainUntilDate></Retention>`,
        );
        return;
      }
      response.setHeader('x-amz-version-id', version.versionId);
      response.setHeader('content-length', version.body.length);
      for (const [key, value] of Object.entries(version.metadata))
        response.setHeader(`x-amz-meta-${key}`, value);
      if (method === 'HEAD') {
        response.end();
        return;
      }
      if (method === 'GET') {
        response.end(faults.corruptDownload ? Buffer.alloc(version.body.length, 0) : version.body);
        return;
      }
      error(405, 'MethodNotAllowed');
    })().catch(() => {
      response.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind a port.');
  const config: BackupStoreConfiguration = {
    endpoint: `http://127.0.0.1:${address.port}`,
    region: 'test-region',
    bucket: 'backup-bucket',
    keyPrefix: 'protected',
    maxBytes: 16 * 1024 * 1024,
    requestTimeoutMs: 2000,
  };
  const writer = createBackupWriter(config, writerCredentials);
  const reader = createBackupReader(config, readerCredentials);
  return {
    config,
    writer,
    reader,
    versions,
    calls,
    faults,
    close: async () => {
      writer.close();
      reader.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    },
  };
}
let directory: string;
let file: string;
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  directory = await mkdtemp('/tmp/acld-s3-test-');
  file = join(directory, 'encrypted.backup');
  await writeFile(file, randomBytes(512 * 1024), { mode: 0o600 });
  f = await fixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.close();
  await rm(directory, { recursive: true, force: true });
});

it('restores an exact historical version after its promised retention expires without claiming current protection', async () => {
  const intent = await prepare();
  const receipt = await f.writer.upload({ intent, file });
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(receipt.retention.retainUntil) + 60_000);
  const destination = join(directory, 'historical.enc');
  expect(await f.reader.download({ receipt, destination })).toEqual(receipt);
  expect(await readFile(destination)).toEqual(await readFile(file));
  expect(await f.reader.inspect(receipt)).toEqual(receipt);
  await expect(f.writer.recover(intent)).rejects.toThrow(BackupStoreError);
});
const prepare = () =>
  f.writer.prepareUpload({
    attemptId: randomUUID(),
    file,
    retention: { mode: 'GOVERNANCE', retainUntil: new Date(Date.now() + 86_400_000).toISOString() },
  });
const putCalls = () => f.calls.filter((call) => call.method === 'PUT');

it('uploads, verifies and downloads an exact retained ciphertext version with separate credentials', async () => {
  expect(await f.writer.checkProtection()).toMatchObject({ versioning: true, objectLock: true });
  const intent = await prepare();
  expect(putCalls()).toHaveLength(0);
  expect(intent.key).toBe(`protected/${intent.attemptId}.enc`);
  const receipt = await f.writer.upload({ intent, file });
  expect(receipt.versionId).toBe(f.versions[0]?.versionId);
  const destination = join(directory, 'restored.enc');
  expect(await f.reader.download({ receipt, destination })).toEqual(receipt);
  expect(await readFile(destination)).toEqual(await readFile(file));
  expect((await stat(destination)).mode & 0o777).toBe(0o600);
  expect(await f.reader.inspect(receipt)).toEqual(receipt);
  const put = putCalls()[0];
  expect(put?.headers['content-md5']).toBe(intent.contentMd5);
  expect(put?.headers['x-amz-meta-acld-sha256']).toBe(intent.ciphertextSha256);
  expect(put?.headers['if-none-match']).toBe('*');
  expect(put?.headers['x-amz-object-lock-mode']).toBe('GOVERNANCE');
  expect(put?.headers.authorization).toContain('Credential=writer-key/');
  expect(
    f.calls.some((call) => call.headers.authorization?.includes('Credential=reader-key/')),
  ).toBe(true);
  expect(f.calls.some((call) => 'x-amz-bypass-governance-retention' in call.headers)).toBe(false);
  expect(f.calls.some((call) => call.method === 'DELETE')).toBe(false);
  expect(f.reader).not.toHaveProperty('upload');
  expect(f.writer).not.toHaveProperty('download');
});

it('verifies COMPLIANCE retention and rejects a later weakened mode', async () => {
  const intent = await f.writer.prepareUpload({
    attemptId: randomUUID(),
    file,
    retention: { mode: 'COMPLIANCE', retainUntil: new Date(Date.now() + 86_400_000).toISOString() },
  });
  const receipt = await f.writer.upload({ intent, file });
  const version = f.versions[0];
  if (!version) throw new Error('Missing stored fixture.');
  version.mode = 'GOVERNANCE';
  await expect(f.reader.inspect(receipt)).rejects.toThrow(BackupStoreError);
});

it.each(['versioning', 'object-lock', 'retention', 'GET'])(
  'fails closed and sanitizes missing %s permissions',
  async (operation) => {
    const intent = await prepare();
    f.faults.deny = operation;
    await expect(f.writer.upload({ intent, file })).rejects.toThrow('Backup upload is unresolved');
    try {
      await f.writer.upload({ intent, file });
    } catch (error) {
      expect(String(error)).not.toContain(writerCredentials.secretAccessKey);
    }
    expect(putCalls().length).toBeLessThanOrEqual(1);
  },
);

it.each(['versioning', 'objectLock'] satisfies Array<'versioning' | 'objectLock'>)(
  'refuses upload when %s protection is disabled',
  async (field) => {
    const intent = await prepare();
    f.faults[field] = 'Suspended';
    await expect(f.writer.checkProtection()).rejects.toThrow(BackupStoreError);
    await expect(f.writer.upload({ intent, file })).rejects.toThrow(BackupStoreError);
    expect(putCalls()).toHaveLength(0);
  },
);

it('recovers a lost PUT reply by reading the original version behind a delete marker, without another PUT', async () => {
  const intent = await prepare();
  f.faults.losePutReply = true;
  await expect(f.writer.upload({ intent, file })).rejects.toThrow('unresolved');
  expect(putCalls()).toHaveLength(1);
  f.faults.latestDeleteMarker = true;
  const recovered = await f.writer.recover(intent);
  expect(recovered.kind).toBe('found');
  if (recovered.kind !== 'found') throw new Error('Expected recovery.');
  expect(recovered.receipt.versionId).toBe(f.versions[0]?.versionId);
  await expect(f.writer.upload({ intent, file })).rejects.toThrow('unresolved');
  expect(putCalls()).toHaveLength(1);
});

it('keeps a missing or ambiguous upload unresolved and never converts recovery into a PUT', async () => {
  const intent = await prepare();
  expect(await f.writer.recover(intent)).toEqual({ kind: 'unresolved' });
  expect(putCalls()).toHaveLength(0);
  await f.writer.upload({ intent, file });
  const version = f.versions[0];
  if (!version) throw new Error('Missing stored fixture.');
  f.versions.push({ ...version, versionId: randomUUID() });
  expect(await f.writer.recover(intent)).toEqual({ kind: 'unresolved' });
  expect(putCalls()).toHaveLength(1);
});

it('does not fall back to an unconditional write when conditional creation is unsupported', async () => {
  const intent = await prepare();
  f.faults.rejectConditional = true;
  await expect(f.writer.upload({ intent, file })).rejects.toThrow('unresolved');
  expect(putCalls()).toHaveLength(1);
  expect(await f.writer.recover(intent)).toEqual({ kind: 'unresolved' });
  expect(putCalls()).toHaveLength(1);
});

it('rejects a changed local file before the PUT', async () => {
  const intent = await prepare();
  await writeFile(file, randomBytes(intent.size));
  await expect(f.writer.upload({ intent, file })).rejects.toThrow(BackupStoreError);
  expect(putCalls()).toHaveLength(0);
});

it('detects a file changed after hashing through the PUT integrity header', async () => {
  await writeFile(file, Buffer.alloc(8 * 1024 * 1024, 1));
  const intent = await prepare();
  f.faults.duringPut = async () => {
    const handle = await open(file, 'r+');
    try {
      await handle.write(Buffer.from([2]), 0, 1, intent.size - 1);
    } finally {
      await handle.close();
    }
  };
  await expect(f.writer.upload({ intent, file })).rejects.toThrow('unresolved');
  expect(f.versions).toHaveLength(0);
  expect(putCalls()).toHaveLength(1);
});

it('checks ciphertext bytes despite matching metadata and removes incomplete downloads', async () => {
  const receipt = await f.writer.upload({ intent: await prepare(), file });
  f.faults.corruptDownload = true;
  const destination = join(directory, 'restored.enc');
  await expect(f.reader.download({ receipt, destination })).rejects.toThrow(BackupStoreError);
  expect(await readdir(directory)).toEqual(['encrypted.backup']);
});

it('preserves an existing restore destination', async () => {
  const receipt = await f.writer.upload({ intent: await prepare(), file });
  const destination = join(directory, 'restored.enc');
  await writeFile(destination, 'existing source must survive', { mode: 0o600 });
  await expect(f.reader.download({ receipt, destination })).rejects.toThrow(BackupStoreError);
  expect(await readFile(destination, 'utf8')).toBe('existing source must survive');
  expect((await readdir(directory)).sort()).toEqual(['encrypted.backup', 'restored.enc']);
});

it('rejects missing exact version IDs and shortened retention after upload', async () => {
  f.faults.malformedVersion = true;
  const intent = await prepare();
  await expect(f.writer.upload({ intent, file })).rejects.toThrow('unresolved');
  const version = f.versions[0];
  if (!version) throw new Error('Missing stored fixture.');
  version.retainUntil = new Date(Date.now() + 60_000).toISOString();
  await expect(f.writer.recover(intent)).rejects.toThrow(BackupStoreError);
});

it('fails closed on incomplete version listings', async () => {
  const intent = await prepare();
  await f.writer.upload({ intent, file });
  f.faults.truncatedListing = true;
  await expect(f.writer.recover(intent)).rejects.toThrow(BackupStoreError);
  expect(putCalls()).toHaveLength(1);
});

it('binds receipts to their configured store and bounded size', async () => {
  const receipt = await f.writer.upload({ intent: await prepare(), file });
  const altered: BackupObjectReceipt = { ...receipt, storeId: '0'.repeat(64) };
  await expect(f.reader.inspect(altered)).rejects.toThrow(BackupStoreError);
  await expect(f.reader.inspect({ ...receipt, size: f.config.maxBytes + 1 })).rejects.toThrow(
    BackupStoreError,
  );
});

it('requires explicit credentials and HTTPS outside the loopback fixture', () => {
  expect(() => createBackupReader(f.config, { accessKeyId: '', secretAccessKey: '' })).toThrow(
    BackupStoreError,
  );
  expect(() =>
    createBackupReader({ ...f.config, endpoint: 'http://s3.example.test' }, readerCredentials),
  ).toThrow(BackupStoreError);
  expect(() =>
    createBackupReader(
      { ...f.config, endpoint: 'https://user:password@s3.example.test' },
      readerCredentials,
    ),
  ).toThrow(BackupStoreError);
});

it('rejects nonprivate, symlinked and oversized ciphertext before any upload', async () => {
  await chmod(file, 0o644);
  await expect(prepare()).rejects.toThrow(BackupStoreError);
  await chmod(file, 0o600);
  const original = file;
  file = join(directory, 'link');
  await symlink(original, file);
  await expect(prepare()).rejects.toThrow(BackupStoreError);
  file = original;
  const small = createBackupWriter({ ...f.config, maxBytes: 1 }, writerCredentials);
  try {
    await expect(
      small.prepareUpload({
        attemptId: randomUUID(),
        file,
        retention: {
          mode: 'GOVERNANCE',
          retainUntil: new Date(Date.now() + 100_000).toISOString(),
        },
      }),
    ).rejects.toThrow(BackupStoreError);
  } finally {
    small.close();
  }
  expect(putCalls()).toHaveLength(0);
});

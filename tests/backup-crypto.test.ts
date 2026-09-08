import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { expect, it } from 'vitest';
import { backupIdSchema, newId } from '../packages/contracts/src/index.js';
import {
  encryptBackup,
  decryptBackup,
  backupKeyringSchema,
  verifyBackupKey,
  BackupWrappingKeyUnavailable,
} from '../apps/control/src/backup-crypto.js';

it('encrypts off-VM, binds account/backup/manifest, survives wrapping-key rotation and refuses tampered bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'acld-backup-crypto-'));
  try {
    const binding = {
      accountId: newId.account(),
      backupId: backupIdSchema.parse(randomUUID()),
      manifestSha256: 'a'.repeat(64),
    };
    const keyring = backupKeyringSchema.parse({
      current: 'first',
      keys: { first: randomBytes(32).toString('base64') },
    });
    const plaintext = randomBytes(1_100_000);
    const cipher = join(directory, 'cipher.enc');
    const encryption = await encryptBackup({
      source: Readable.from([plaintext.subarray(0, 700000), plaintext.subarray(700000)]),
      destination: cipher,
      binding,
      keyring,
      maxBytes: 2_000_000,
      signal: AbortSignal.timeout(10000),
    });
    expect((await readFile(cipher)).includes(plaintext.subarray(0, 100))).toBe(false);
    expect((await stat(cipher)).mode & 0o077).toBe(0);
    const rotated = backupKeyringSchema.parse({
      current: 'second',
      keys: { ...keyring.keys, second: randomBytes(32).toString('base64') },
    });
    const restore = join(directory, 'restore');
    const request = {
      source: cipher,
      destination: restore,
      encryption,
      binding,
      keyring: rotated,
      maxBytes: 2_000_000,
      signal: AbortSignal.timeout(10000),
    };
    expect(() => {
      verifyBackupKey(request);
    }).not.toThrow();
    expect(() => {
      verifyBackupKey({
        ...request,
        keyring: { current: 'first', keys: { first: randomBytes(32).toString('base64') } },
      });
    }).toThrow(BackupWrappingKeyUnavailable);
    expect(() => {
      verifyBackupKey({
        ...request,
        encryption: { ...encryption, wrappingTag: randomBytes(16).toString('base64') },
      });
    }).toThrow(BackupWrappingKeyUnavailable);
    for (const changed of [
      { ...binding, accountId: newId.account() },
      { ...binding, backupId: backupIdSchema.parse(randomUUID()) },
      { ...binding, manifestSha256: 'f'.repeat(64) },
    ]) {
      expect(() => {
        verifyBackupKey({ ...request, binding: changed });
      }).toThrow('different account');
      expect(() => {
        verifyBackupKey({ ...request, binding: changed });
      }).not.toThrow(BackupWrappingKeyUnavailable);
    }
    await decryptBackup(request);
    expect(await readFile(restore)).toEqual(plaintext);
    await expect(decryptBackup(request)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(restore)).toEqual(plaintext);
    await expect(
      decryptBackup({
        ...request,
        destination: join(directory, 'foreign'),
        binding: { ...binding, accountId: newId.account() },
      }),
    ).rejects.toThrow('different account');
    await expect(
      decryptBackup({
        ...request,
        destination: join(directory, 'missing-key'),
        keyring: { current: 'second', keys: { second: randomBytes(32).toString('base64') } },
      }),
    ).rejects.toThrow('wrapping key version');
    const changed = await readFile(cipher);
    changed[100] = (changed[100] ?? 0) ^ 1;
    await writeFile(cipher, changed);
    const corrupt = join(directory, 'corrupt');
    await expect(decryptBackup({ ...request, destination: corrupt })).rejects.toThrow();
    await expect(stat(corrupt)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('bounds capture bytes, cleans failed outputs and never replaces an existing artifact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'acld-backup-bounds-'));
  try {
    const destination = join(directory, 'cipher');
    const request = {
      source: Readable.from([Buffer.alloc(5000)]),
      destination,
      binding: {
        accountId: newId.account(),
        backupId: backupIdSchema.parse(randomUUID()),
        manifestSha256: 'b'.repeat(64),
      },
      keyring: { current: 'one', keys: { one: randomBytes(32).toString('base64') } },
      maxBytes: 1000,
      signal: AbortSignal.timeout(10000),
    };
    await expect(encryptBackup(request)).rejects.toThrow('byte limit');
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(destination, 'retained', { mode: 0o600 });
    await expect(
      encryptBackup({ ...request, source: Readable.from(['replacement']) }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(destination, 'utf8')).toBe('retained');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

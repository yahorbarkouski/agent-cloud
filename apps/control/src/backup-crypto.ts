import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  type CipherGCMTypes,
} from 'node:crypto';
import { constants } from 'node:fs';
import { open, link, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { accountIdSchema, backupIdSchema } from '@agent-cloud/contracts';

const algorithm: CipherGCMTypes = 'aes-256-gcm';
const encoded = (bytes: number) =>
  z
    .string()
    .refine(
      (value) =>
        Buffer.from(value, 'base64').length === bytes &&
        Buffer.from(value, 'base64').toString('base64') === value,
      'Invalid canonical key material.',
    );
export const backupEncryptionSchema = z.strictObject({
  version: z.literal(1),
  algorithm: z.literal('aes-256-gcm'),
  keyVersion: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  accountId: accountIdSchema,
  backupId: backupIdSchema,
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  iv: encoded(12),
  tag: encoded(16),
  wrappedKey: encoded(32),
  wrappingIv: encoded(12),
  wrappingTag: encoded(16),
  plaintextBytes: z.int().positive(),
  plaintextSha256: z.string().regex(/^[a-f0-9]{64}$/),
  ciphertextBytes: z.int().positive(),
  ciphertextSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const backupKeyringSchema = z
  .strictObject({
    current: z.string(),
    keys: z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), encoded(32)),
  })
  .refine(
    (value) => value.keys[value.current] !== undefined,
    'Current backup wrapping key is missing.',
  );
export type BackupEncryption = z.infer<typeof backupEncryptionSchema>;
const bindingSchema = backupEncryptionSchema.pick({
  accountId: true,
  backupId: true,
  manifestSha256: true,
});
type Binding = z.infer<typeof bindingSchema>;
const aad = (binding: Binding) =>
  Buffer.from(
    JSON.stringify({
      version: 1,
      accountId: binding.accountId,
      backupId: binding.backupId,
      manifestSha256: binding.manifestSha256,
    }),
  );

function measured(maximum: number) {
  let bytes = 0;
  const hash = createHash('sha256');
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > maximum) {
        done(new Error('Backup stream exceeds its admitted byte limit.'));
        return;
      }
      hash.update(chunk);
      done(null, chunk);
    },
  });
  return { stream, result: () => ({ bytes, sha256: hash.digest('hex') }) };
}
async function persist(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
function wrappingKey(keyring: z.infer<typeof backupKeyringSchema>, version: string) {
  const key = keyring.keys[version];
  if (!key)
    throw new Error(
      'Required backup wrapping key version is unavailable. Restore its offline copy.',
    );
  return Buffer.from(key, 'base64');
}

/** The worker encrypts an untrusted bounded guest stream; keys never enter the guest or object store. */
export async function encryptBackup(input: {
  source: Readable;
  destination: string;
  binding: Binding;
  keyring: z.infer<typeof backupKeyringSchema>;
  maxBytes: number;
  signal: AbortSignal;
}) {
  const keyring = backupKeyringSchema.parse(input.keyring);
  const binding = bindingSchema.parse(input.binding);
  const maximum = z.int().positive().max(1_073_741_824).parse(input.maxBytes);
  const dataKey = randomBytes(32);
  const masterKey = wrappingKey(keyring, keyring.current);
  const iv = randomBytes(12);
  const wrappingIv = randomBytes(12);
  const cipher = createCipheriv(algorithm, dataKey, iv).setAAD(aad(binding));
  const wrapper = createCipheriv(algorithm, masterKey, wrappingIv).setAAD(aad(binding));
  const plaintext = measured(maximum);
  const ciphertext = measured(maximum);
  let created = false;
  try {
    const file = await open(input.destination, 'wx', 0o600);
    created = true;
    try {
      await pipeline(
        input.source,
        plaintext.stream,
        cipher,
        ciphertext.stream,
        file.createWriteStream(),
        { signal: input.signal },
      );
    } finally {
      await file.close();
    }
    await persist(input.destination);
    const wrappedKey = Buffer.concat([wrapper.update(dataKey), wrapper.final()]);
    const clear = plaintext.result();
    const encrypted = ciphertext.result();
    return backupEncryptionSchema.parse({
      version: 1,
      algorithm,
      keyVersion: keyring.current,
      ...binding,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      wrappedKey: wrappedKey.toString('base64'),
      wrappingIv: wrappingIv.toString('base64'),
      wrappingTag: wrapper.getAuthTag().toString('base64'),
      plaintextBytes: clear.bytes,
      plaintextSha256: clear.sha256,
      ciphertextBytes: encrypted.bytes,
      ciphertextSha256: encrypted.sha256,
    });
  } catch (error) {
    if (created) await rm(input.destination, { force: true });
    throw error;
  } finally {
    dataKey.fill(0);
    masterKey.fill(0);
  }
}

/** Authenticated bytes are published only after full tag/hash/length verification, never streamed to a restore VM early. */
export async function decryptBackup(input: {
  source: string;
  destination: string;
  encryption: BackupEncryption;
  binding: Binding;
  keyring: z.infer<typeof backupKeyringSchema>;
  maxBytes: number;
  signal: AbortSignal;
}) {
  const encryption = backupEncryptionSchema.parse(input.encryption);
  const binding = bindingSchema.parse(input.binding);
  if (!aad(binding).equals(aad(encryption)))
    throw new Error('Backup encryption belongs to a different account, backup or manifest.');
  const maximum = z.int().positive().max(1_073_741_824).parse(input.maxBytes);
  if (encryption.plaintextBytes > maximum || encryption.ciphertextBytes > maximum)
    throw new Error('Backup exceeds the admitted restore byte limit.');
  const keyring = backupKeyringSchema.parse(input.keyring);
  const masterKey = wrappingKey(keyring, encryption.keyVersion);
  let dataKey: Buffer | undefined;
  const temporary = `${input.destination}.${randomBytes(16).toString('hex')}.partial`;
  let created = false;
  try {
    const wrapper = createDecipheriv(
      algorithm,
      masterKey,
      Buffer.from(encryption.wrappingIv, 'base64'),
    )
      .setAAD(aad(binding))
      .setAuthTag(Buffer.from(encryption.wrappingTag, 'base64'));
    dataKey = Buffer.concat([
      wrapper.update(Buffer.from(encryption.wrappedKey, 'base64')),
      wrapper.final(),
    ]);
    const decipher = createDecipheriv(algorithm, dataKey, Buffer.from(encryption.iv, 'base64'))
      .setAAD(aad(binding))
      .setAuthTag(Buffer.from(encryption.tag, 'base64'));
    const file = await open(
      input.source,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.uid !== process.getuid?.() ||
        info.mode & 0o077 ||
        info.size !== encryption.ciphertextBytes
      )
        throw new Error('Backup ciphertext file is invalid.');
      const output = await open(temporary, 'wx', 0o600);
      created = true;
      const ciphertext = measured(maximum);
      const plaintext = measured(maximum);
      try {
        await pipeline(
          file.createReadStream(),
          ciphertext.stream,
          decipher,
          plaintext.stream,
          output.createWriteStream(),
          { signal: input.signal },
        );
      } finally {
        await output.close();
      }
      const clear = plaintext.result();
      const encrypted = ciphertext.result();
      if (
        clear.bytes !== encryption.plaintextBytes ||
        clear.sha256 !== encryption.plaintextSha256 ||
        encrypted.bytes !== encryption.ciphertextBytes ||
        encrypted.sha256 !== encryption.ciphertextSha256
      )
        throw new Error('Backup bytes differ from the captured encryption receipt.');
    } finally {
      await file.close();
    }
    await persist(temporary);
    // Hard-link publication is atomic and exclusive, without an empty reservation file.
    await link(temporary, input.destination);
    await persist(input.destination);
    await rm(temporary);
    created = false;
    await persist(input.destination);
  } finally {
    if (created) await rm(temporary, { force: true });
    dataKey?.fill(0);
    masterKey.fill(0);
  }
}

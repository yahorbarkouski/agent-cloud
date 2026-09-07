import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { renewGatewayTls, validateGatewayTls } from '@agent-cloud/pki';
import type { PublicGatewayConfiguration } from './config.js';

export const gatewayClientIdentitySchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.gateway\.agent-cloud\.internal$/),
  receiptFile: z.string().refine(isAbsolute),
  step: z.string().refine(isAbsolute),
  caUrl: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  }),
});
export const gatewayCertificateReceiptSchema = z.strictObject({
  name: gatewayClientIdentitySchema.shape.name,
  certificate: z.string().min(1).max(32_768),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type GatewayCertificateConfiguration = {
  clientIdentity: z.infer<typeof gatewayClientIdentitySchema>;
  gateway: Pick<
    PublicGatewayConfiguration,
    'guestCaFile' | 'clientCertificateFile' | 'clientKeyFile'
  >;
};
export type GatewayCertificateOperations = {
  validate: typeof validateGatewayTls;
  renew: typeof renewGatewayTls;
  now: () => number;
};
const nativeOperations: GatewayCertificateOperations = {
  validate: validateGatewayTls,
  renew: renewGatewayTls,
  now: Date.now,
};
const renewalAttemptSchema = z.strictObject({
  id: z.uuid(),
  certificateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  startedAt: z.iso.datetime(),
});
export const gatewayFileMissing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';
export const gatewayDigest = (value: string) => createHash('sha256').update(value).digest('hex');

export async function readGatewayFile(path: string, privateFile = true, limit = 16_384) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.mode & (privateFile ? 0o077 : 0o022) ||
      (info.uid !== process.getuid?.() && (privateFile || info.uid !== 0)) ||
      info.size > limit
    )
      throw new Error('Gateway file ownership, permissions or size is invalid.');
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > limit) throw new Error('Gateway file exceeds its limit.');
    return buffer.subarray(0, size).toString('utf8').trim();
  } finally {
    await file.close();
  }
}

export async function prepareGatewayDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || info.mode & 0o077)
    throw new Error('Gateway state requires an owner-only directory.');
}

/** Exclusive writes preserve original keys/attempts. Replacements publish only after fsync. */
export async function writeGatewayFile(path: string, value: string, exclusive = false) {
  const directory = dirname(path);
  await prepareGatewayDirectory(directory);
  const temporary = exclusive ? path : `${path}.${randomUUID()}.next`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(value);
      await file.sync();
    } finally {
      await file.close();
    }
    if (!exclusive) await rename(temporary, path);
    const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    if (!exclusive) await rm(temporary, { force: true });
  }
}

/** The receipt is authoritative; the PEM is a recoverable publication for Caddy. */
export function createGatewayCertificate(
  config: GatewayCertificateConfiguration,
  operations: GatewayCertificateOperations = nativeOperations,
) {
  let validatedDigest: string | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  async function restore() {
    const receipt = gatewayCertificateReceiptSchema.parse(
      JSON.parse(await readGatewayFile(config.clientIdentity.receiptFile, true, 65_536)),
    );
    if (receipt.name !== config.clientIdentity.name)
      throw new Error('Gateway certificate receipt belongs to another identity.');
    const privateKey = await readGatewayFile(config.gateway.clientKeyFile, true, 4096);
    const tlsRoot = await readGatewayFile(config.gateway.guestCaFile, false, 65_536);
    const pki = { binary: config.clientIdentity.step, caUrl: config.clientIdentity.caUrl, tlsRoot };
    const identity = {
      name: receipt.name,
      privateKey,
      certificate: receipt.certificate,
      issuedAt: receipt.issuedAt,
    };
    const digest = gatewayDigest(JSON.stringify({ receipt, privateKey, tlsRoot }));
    if (digest !== validatedDigest) {
      const validity = await operations.validate(pki, identity);
      if (validity.expiresAt !== receipt.expiresAt)
        throw new Error('Gateway receipt expiry disagrees with its certificate.');
      validatedDigest = digest;
    }
    if (Date.parse(receipt.expiresAt) <= operations.now() + 30_000)
      throw new Error('Gateway certificate has expired or is about to expire.');
    const published = await readGatewayFile(
      config.gateway.clientCertificateFile,
      false,
      32_768,
    ).catch((error: unknown) => {
      if (gatewayFileMissing(error)) return null;
      throw error;
    });
    if (published !== receipt.certificate.trim())
      await writeGatewayFile(config.gateway.clientCertificateFile, receipt.certificate);
    return { receipt, pki, identity };
  }
  async function refresh() {
    const { receipt, pki, identity } = await restore();
    if (Date.parse(receipt.expiresAt) > operations.now() + 20 * 60_000)
      return { expiresAt: receipt.expiresAt, renewal: 'not_due' };
    const attemptFile = `${config.clientIdentity.receiptFile}.renewal.json`;
    const previous = await readGatewayFile(attemptFile).then(
      (value) => renewalAttemptSchema.parse(JSON.parse(value)),
      (error: unknown) => {
        if (gatewayFileMissing(error)) return null;
        throw error;
      },
    );
    const certificateDigest = gatewayDigest(receipt.certificate);
    // An uncertain renewal gets a new recorded attempt after a delay; it is never replayed.
    if (
      previous?.certificateDigest === certificateDigest &&
      operations.now() < Date.parse(previous.startedAt) + 60_000
    )
      return { expiresAt: receipt.expiresAt, renewal: 'unavailable' };
    await writeGatewayFile(
      attemptFile,
      JSON.stringify({
        id: randomUUID(),
        certificateDigest,
        startedAt: new Date(operations.now()).toISOString(),
      }) + '\n',
    );
    const renewed = await operations.renew(pki, identity).catch(() => null);
    if (!renewed) return { expiresAt: receipt.expiresAt, renewal: 'unavailable' };
    const next = gatewayCertificateReceiptSchema.parse({ name: receipt.name, ...renewed });
    await writeGatewayFile(config.clientIdentity.receiptFile, JSON.stringify(next) + '\n');
    // A crash here is repaired from the new receipt on the next refresh, without reissuing.
    await restore();
    return { expiresAt: next.expiresAt, renewal: 'renewed' };
  }
  function serialize<T>(work: () => Promise<T>) {
    const result = tail.then(work);
    tail = result.catch(() => undefined);
    return result;
  }
  return {
    restore: () => serialize(async () => ({ expiresAt: (await restore()).receipt.expiresAt })),
    refresh: () => serialize(refresh),
  };
}

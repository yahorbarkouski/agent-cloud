import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const key = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9/_-]*\.enc$/);
export const backupRetentionSchema = z.strictObject({
  mode: z.enum(['GOVERNANCE', 'COMPLIANCE']),
  retainUntil: z.iso.datetime(),
});
export const backupStoreConfigurationSchema = z.strictObject({
  endpoint: z.url().refine((value) => {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/' &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  }),
  region: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9-]+$/),
  bucket: z
    .string()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/),
  keyPrefix: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9/_-]*[a-zA-Z0-9]$/),
  maxBytes: z.int().positive().max(5_000_000_000),
  requestTimeoutMs: z.int().min(1000).max(900_000).default(120_000),
});
export const backupStoreCredentialsSchema = z.strictObject({
  accessKeyId: z.string().min(1).max(256),
  secretAccessKey: z.string().min(1).max(256),
  sessionToken: z.string().min(1).max(16_384).optional(),
});
export const backupUploadIntentSchema = z.strictObject({
  storeId: digest,
  bucket: backupStoreConfigurationSchema.shape.bucket,
  key,
  attemptId: z.uuid(),
  ciphertextSha256: digest,
  contentMd5: z.string().regex(/^[A-Za-z0-9+/]{22}==$/),
  size: z.int().positive().max(5_000_000_000),
  retention: backupRetentionSchema,
});
export const backupObjectReceiptSchema = backupUploadIntentSchema.extend({
  versionId: z
    .string()
    .min(1)
    .max(1024)
    .refine((value) => value !== 'null'),
});
export const prepareBackupUploadSchema = z.strictObject({
  attemptId: z.uuid(),
  file: z.string().refine(isAbsolute),
  retention: backupRetentionSchema,
});
export type BackupStoreConfiguration = z.input<typeof backupStoreConfigurationSchema>;
export type BackupStoreCredentials = z.infer<typeof backupStoreCredentialsSchema>;
export type BackupUploadIntent = z.infer<typeof backupUploadIntentSchema>;
export type BackupObjectReceipt = z.infer<typeof backupObjectReceiptSchema>;
export type PrepareBackupUpload = z.infer<typeof prepareBackupUploadSchema>;
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export class BackupStoreError extends Error {
  readonly operation:
    | 'configuration'
    | 'protection'
    | 'prepare'
    | 'upload'
    | 'recover'
    | 'inspect'
    | 'download'
    | 'purge';
  constructor(operation: BackupStoreError['operation']) {
    super(
      operation === 'upload'
        ? 'Backup upload is unresolved. Recover its recorded intent; do not repeat the PUT.'
        : `Backup storage ${operation} failed.`,
    );
    this.operation = operation;
    this.name = 'BackupStoreError';
  }
}
export async function sanitized<T>(
  operation: BackupStoreError['operation'],
  work: () => Promise<T>,
) {
  try {
    return await work();
  } catch {
    throw new BackupStoreError(operation);
  }
}

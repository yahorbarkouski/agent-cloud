import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  backupCapturedStateSchema,
  backupLimitsSchema,
  backupSummarySchema,
  restoreSummarySchema,
} from '@agent-cloud/contracts';
import {
  backupObjectReceiptSchema,
  backupStoreConfigurationSchema,
  backupUploadIntentSchema,
} from '@agent-cloud/backup-store';
import type { backups, backupRestores } from '@agent-cloud/db';
import { backupEncryptionSchema } from './backup-crypto.js';

const privatePath = z.string().refine(isAbsolute, 'Use an absolute private file path.');
export const backupControlConfigSchema = z.strictObject({
  version: z.literal(1),
  directory: privatePath,
  store: backupStoreConfigurationSchema,
  writerCredentialsFile: privatePath,
  readerCredentialsFile: privatePath,
  keyringFile: privatePath,
  retentionDays: z.int().min(1).max(30).default(7),
  retentionMode: z.enum(['GOVERNANCE', 'COMPLIANCE']).default('COMPLIANCE'),
  limits: backupLimitsSchema,
  maxAccountBytes: z.int().positive().max(21_474_836_480).default(21_474_836_480),
  maxGlobalBytes: z.int().positive().max(1_099_511_627_776),
});
export type BackupControlConfig = z.infer<typeof backupControlConfigSchema>;
export const capturedGuestSchema = backupCapturedStateSchema;
const sealed = {
  capture: capturedGuestSchema,
  encryption: backupEncryptionSchema,
  intent: backupUploadIntentSchema,
};
export const backupWorkSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('capture'), attempts: z.int().nonnegative().max(5) }),
  z.strictObject({
    kind: z.literal('encrypt'),
    capture: capturedGuestSchema,
    attempts: z.int().nonnegative().max(5),
  }),
  z.strictObject({ kind: z.literal('upload_ready'), ...sealed }),
  z.strictObject({
    kind: z.literal('upload_submitted'),
    ...sealed,
    attempts: z.int().nonnegative().max(5),
  }),
  z.strictObject({
    kind: z.literal('stored'),
    ...sealed,
    receipt: backupObjectReceiptSchema,
    guestCleanup: z.enum(['pending', 'done']),
    attempts: z.int().nonnegative().max(5),
  }),
]);
export type BackupWork = z.infer<typeof backupWorkSchema>;
export const restoreWorkSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('waiting') }),
  z.strictObject({ kind: z.literal('prepare'), attempts: z.int().nonnegative().max(5) }),
  z.strictObject({ kind: z.literal('submitted'), attempts: z.int().nonnegative().max(5) }),
  z.strictObject({ kind: z.literal('done') }),
]);
export const backupDigest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function backupRecord(row: typeof backups.$inferSelect) {
  const record = backupSummarySchema.parse(row.record);
  if (
    record.id !== row.id ||
    record.accountId !== row.accountId ||
    record.projectId !== row.projectId ||
    record.machineId !== row.machineId ||
    record.allocationId !== row.allocationId
  )
    throw new Error('Backup ownership disagrees with its record.');
  return record;
}
export function restoreRecord(row: typeof backupRestores.$inferSelect) {
  const record = restoreSummarySchema.parse(row.record);
  if (
    record.id !== row.id ||
    record.accountId !== row.accountId ||
    record.backupId !== row.backupId ||
    record.machineId !== row.machineId
  )
    throw new Error('Restore ownership disagrees with its record.');
  return record;
}

import { z } from 'zod';
import { backupIdSchema } from './backups.js';
import { accountIdSchema, projectIdSchema } from './ids.js';

export const backupPurgeIdSchema = z.uuidv4().brand<'BackupPurgeId'>();
export const backupPurgeRequestSchema = z.strictObject({
  id: backupPurgeIdSchema,
  allowDataLoss: z.literal(true),
});
export const backupPurgeSummarySchema = z.strictObject({
  id: backupPurgeIdSchema,
  backupId: backupIdSchema,
  accountId: accountIdSchema,
  projectId: projectIdSchema,
  reason: z.enum(['customer', 'retention']),
  createdAt: z.iso.datetime(),
  state: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('waiting'), notBefore: z.iso.datetime() }),
    z.strictObject({ kind: z.literal('submitted'), attemptedAt: z.iso.datetime() }),
    z.strictObject({
      kind: z.literal('blocked'),
      retryAt: z.iso.datetime(),
      reason: z.string().max(256),
    }),
    z.strictObject({ kind: z.literal('purged'), purgedAt: z.iso.datetime() }),
  ]),
});
export const backupPurgeResponseSchema = z.strictObject({ purge: backupPurgeSummarySchema });
export type BackupPurgeRequest = z.infer<typeof backupPurgeRequestSchema>;
export type BackupPurgeSummary = z.infer<typeof backupPurgeSummarySchema>;

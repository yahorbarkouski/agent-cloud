import { z } from 'zod';
import { backupRecipeSchema, backupSummarySchema } from './backups.js';
import { accountIdSchema, allocationIdSchema, machineIdSchema, projectIdSchema } from './ids.js';
import { failureSchema } from './errors.js';

export const backupScheduleIdSchema = z.uuidv4().brand<'BackupScheduleId'>();
export const backupScheduleRequestSchema = z.strictObject({
  id: backupScheduleIdSchema,
  recipe: backupRecipeSchema,
});
export const backupScheduleSchema = z.strictObject({
  id: backupScheduleIdSchema,
  accountId: accountIdSchema,
  projectId: projectIdSchema,
  machineId: machineIdSchema,
  allocationId: allocationIdSchema,
  recipe: backupRecipeSchema,
  createdAt: z.iso.datetime(),
  state: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('enabled'), nextRunAt: z.iso.datetime() }),
    z.strictObject({ kind: z.literal('disabled'), disabledAt: z.iso.datetime() }),
  ]),
  lastAttempt: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('none') }),
    z.strictObject({
      kind: z.literal('admitted'),
      at: z.iso.datetime(),
      backup: backupSummarySchema,
    }),
    z.strictObject({ kind: z.literal('refused'), at: z.iso.datetime(), failure: failureSchema }),
  ]),
  lastSuccessfulBackup: backupSummarySchema.nullable(),
});
export const backupScheduleResponseSchema = z.strictObject({ schedule: backupScheduleSchema });
export const backupSchedulesResponseSchema = z.strictObject({
  schedules: z.array(backupScheduleSchema).max(100),
});
export type BackupScheduleRequest = z.infer<typeof backupScheduleRequestSchema>;

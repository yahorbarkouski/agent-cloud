import { z } from 'zod';
import {
  accountIdSchema,
  allocationIdSchema,
  machineIdSchema,
  operationIdSchema,
  projectIdSchema,
} from './ids.js';
import { machineSpecSchema } from './lifecycle.js';
import { composeAppSchema, composeReleaseIdSchema, composePathSchema } from './compose.js';

export const backupIdSchema = z.uuidv4().brand<'BackupId'>();
export const restoreIdSchema = z.uuidv4().brand<'RestoreId'>();
export const backupRecipeSchema = z.strictObject({
  kind: z.literal('compose-postgres'),
  app: composeAppSchema,
  releaseId: composeReleaseIdSchema,
  service: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),
  database: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/),
  user: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/),
  // Explicit regular files beneath the customer's directory; no inferred whole-disk guarantee.
  files: z.array(composePathSchema).max(100).default([]),
});
export const backupCaptureRequestSchema = z.strictObject({
  id: backupIdSchema,
  recipe: backupRecipeSchema,
});
export const backupLimitsSchema = z.strictObject({
  maxBytes: z.int().min(1_048_576).max(1_073_741_824),
  timeoutSeconds: z.int().min(30).max(900),
});
export const backupGuestCaptureSchema = z.strictObject({
  kind: z.literal('capture'),
  id: backupIdSchema,
  recipe: backupRecipeSchema,
  limits: backupLimitsSchema,
});
export const backupGuestInspectSchema = z.strictObject({
  kind: z.literal('inspect'),
  id: backupIdSchema,
});
export const backupGuestReadSchema = z.strictObject({
  kind: z.literal('read'),
  id: backupIdSchema,
});
export const backupGuestRemoveSchema = z.strictObject({
  kind: z.literal('remove'),
  id: backupIdSchema,
});
export const backupGuestCommandSchema = z.discriminatedUnion('kind', [
  backupGuestCaptureSchema,
  backupGuestInspectSchema,
  backupGuestReadSchema,
  backupGuestRemoveSchema,
]);
export const backupCaptureManifestSchema = z.strictObject({
  version: z.literal(1),
  recipe: backupRecipeSchema,
  capturedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  postgresVersion: z.string().min(1).max(128),
  sourceFiles: z.int().min(1).max(1024),
  declaredFiles: z.array(composePathSchema).max(100),
  consistency: z.literal('database-consistent-files-best-effort'),
  exclusions: z.array(z.string().max(256)).max(20),
});
export const backupCapturedStateSchema = z.strictObject({
  kind: z.literal('captured'),
  id: backupIdSchema,
  manifest: backupCaptureManifestSchema,
  bytes: z.int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const backupGuestStateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('missing') }),
  z.strictObject({
    kind: z.literal('pending'),
    id: backupIdSchema,
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({ kind: z.literal('failed'), id: backupIdSchema, reason: z.string().max(256) }),
  backupCapturedStateSchema,
]);
export const backupGuestReplySchema = z.strictObject({ capture: backupGuestStateSchema });
export const restoreGuestRequestSchema = z.strictObject({
  id: restoreIdSchema,
  backupId: backupIdSchema,
  app: composeAppSchema,
  limits: backupLimitsSchema,
  bytes: z.int().positive().max(1_073_741_824),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const restoreCompletedStateSchema = z.strictObject({
  kind: z.literal('restored'),
  id: restoreIdSchema,
  app: composeAppSchema,
  releaseId: composeReleaseIdSchema,
  postgresVersion: z.string().max(128),
  integrity: z.literal('database-restored-services-healthy'),
});
export const restoreGuestStateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pending'), id: restoreIdSchema }),
  z.strictObject({ kind: z.literal('failed'), id: restoreIdSchema, reason: z.string().max(256) }),
  restoreCompletedStateSchema,
]);
export const backupSummarySchema = z.strictObject({
  id: backupIdSchema,
  accountId: accountIdSchema,
  projectId: projectIdSchema,
  machineId: machineIdSchema,
  allocationId: allocationIdSchema,
  createdAt: z.iso.datetime(),
  retainUntil: z.iso.datetime(),
  state: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('pending') }),
    z.strictObject({ kind: z.literal('blocked'), reason: z.string().max(256) }),
    z.strictObject({
      kind: z.literal('captured'),
      bytes: z.int().positive(),
      capturedAt: z.iso.datetime(),
      validation: z.enum(['captured', 'restore_verified']),
      manifest: backupCaptureManifestSchema,
    }),
  ]),
});
export const backupResponseSchema = z.strictObject({ backup: backupSummarySchema });
export const backupsResponseSchema = z.strictObject({
  backups: z.array(backupSummarySchema).max(100),
});
export const restoreRequestSchema = z.strictObject({
  id: restoreIdSchema,
  backupId: backupIdSchema,
  app: composeAppSchema,
  machine: machineSpecSchema,
});
export const restoreSummarySchema = z.strictObject({
  id: restoreIdSchema,
  backupId: backupIdSchema,
  accountId: accountIdSchema,
  projectId: projectIdSchema,
  machineId: machineIdSchema,
  operationId: operationIdSchema,
  createdAt: z.iso.datetime(),
  state: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('pending') }),
    z.strictObject({ kind: z.literal('blocked'), reason: z.string().max(256) }),
    z.strictObject({ kind: z.literal('restored'), result: restoreCompletedStateSchema }),
  ]),
});
export const restoreResponseSchema = z.strictObject({ restore: restoreSummarySchema });
export type BackupSummary = z.infer<typeof backupSummarySchema>;
export type RestoreSummary = z.infer<typeof restoreSummarySchema>;
export type RestoreRequest = z.infer<typeof restoreRequestSchema>;
export type BackupRecipe = z.infer<typeof backupRecipeSchema>;
export type BackupGuestCommand = z.infer<typeof backupGuestCommandSchema>;
export type BackupCaptureManifest = z.infer<typeof backupCaptureManifestSchema>;
export type RestoreGuestRequest = z.infer<typeof restoreGuestRequestSchema>;

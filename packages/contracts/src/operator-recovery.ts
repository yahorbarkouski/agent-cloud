import { z } from 'zod';
import { accountIdSchema, allocationIdSchema, attemptIdSchema, operationIdSchema } from './ids.js';

export const recoveryIdSchema = z.uuid().brand<'RecoveryId'>();
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const common = z.strictObject({
  id: recoveryIdSchema,
  accountId: accountIdSchema,
  allocationId: allocationIdSchema,
  operationId: operationIdSchema,
  attemptId: attemptIdSchema,
  expectedState: sha256,
  operator: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9@._+-]+$/),
  evidence: z.strictObject({ reference: z.string().min(1).max(256), sha256 }),
});
export const operatorRecoverySchema = z.discriminatedUnion('kind', [
  common.extend({
    kind: z.literal('close_create'),
    providerRequestFinished: z.literal(true),
    resourceIds: z
      .array(z.string().min(1).max(100))
      .max(1000)
      .refine((ids) => new Set(ids).size === ids.length, 'Resource IDs must be unique.'),
  }),
  common.extend({ kind: z.literal('retry_delete') }),
]);
export type OperatorRecovery = z.infer<typeof operatorRecoverySchema>;

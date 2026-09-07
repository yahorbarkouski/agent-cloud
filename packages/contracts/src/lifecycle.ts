import { z } from 'zod';
import { providerKindSchema, regionSchema, sizeSchema } from './catalog.js';
import { failureSchema } from './errors.js';
import {
  accountIdSchema,
  resourceRefSchema,
  allocationIdSchema,
  attemptIdSchema,
  grantIdSchema,
  machineIdSchema,
  operationIdSchema,
  projectIdSchema,
} from './ids.js';

export const nameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z][a-z0-9-]*$/);
export const idempotencyKeySchema = z
  .string()
  .min(12)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
export const machineSpecSchema = z.strictObject({
  name: nameSchema,
  size: sizeSchema,
  region: regionSchema,
});
export type MachineSpec = z.infer<typeof machineSpecSchema>;

export const machineActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('reboot'), expectedVersion: z.int().positive() }),
  z.strictObject({ kind: z.literal('power_off'), expectedVersion: z.int().positive() }),
  z.strictObject({ kind: z.literal('power_on'), expectedVersion: z.int().positive() }),
  z.strictObject({
    kind: z.literal('resize'),
    expectedVersion: z.int().positive(),
    size: sizeSchema,
  }),
  z.strictObject({
    kind: z.literal('destroy'),
    expectedVersion: z.int().positive(),
    allowDataLoss: z.boolean(),
  }),
]);
export type MachineAction = z.infer<typeof machineActionSchema>;

export const lifecycleCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create'), spec: machineSpecSchema }),
  ...machineActionSchema.options,
]);
export type LifecycleCommand = z.infer<typeof lifecycleCommandSchema>;

export const operationKindSchema = z.enum([
  'machine.create',
  'machine.reboot',
  'machine.power_off',
  'machine.power_on',
  'machine.resize',
  'machine.destroy',
]);

export const operationIntentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('run') }),
  z.object({ kind: z.literal('compensate'), error: failureSchema }),
  z.object({ kind: z.literal('cleanup'), sourceOperationId: operationIdSchema }),
]);

export const operationProgressSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('queued') }),
  z.object({ kind: z.literal('submitting'), attemptId: attemptIdSchema }),
  z.object({
    kind: z.literal('waiting_provider'),
    attemptId: attemptIdSchema,
    actionId: z.string(),
    resource: resourceRefSchema,
  }),
  z.object({ kind: z.literal('cleaning_up') }),
  z.object({ kind: z.literal('verifying'), resource: resourceRefSchema }),
  z.object({
    kind: z.literal('waiting_guest'),
    serverId: z.string(),
    stage: z.enum(['enrollment', 'runtime']),
  }),
  z.object({
    kind: z.literal('blocked'),
    reason: z.enum([
      'provider_outcome_unknown',
      'duplicate_provider_resources',
      'provider_resource_mismatch',
      'guest_unreachable',
      'guest_identity_mismatch',
      'guest_deadline_exceeded',
      'guest_signing_exhausted',
      'cleanup_retry_exhausted',
    ]),
  }),
  z.object({ kind: z.literal('succeeded'), completedAt: z.iso.datetime() }),
  z.object({ kind: z.literal('cancelled'), completedAt: z.iso.datetime() }),
  z.object({ kind: z.literal('failed'), completedAt: z.iso.datetime(), error: failureSchema }),
]);
export type OperationProgress = z.infer<typeof operationProgressSchema>;

export const operationSchema = z.object({
  id: operationIdSchema,
  accountId: accountIdSchema,
  projectId: projectIdSchema,
  machineId: machineIdSchema,
  grantId: grantIdSchema,
  kind: operationKindSchema,
  intent: operationIntentSchema.default({ kind: 'run' }),
  progress: operationProgressSchema,
  createdAt: z.iso.datetime(),
});
export type Operation = z.infer<typeof operationSchema>;
export const operationResponseSchema = z.object({ operation: operationSchema });

export const powerSchema = z.enum(['running', 'off', 'starting', 'stopping', 'unknown']);
export const guestVerificationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pending') }),
  z.object({ kind: z.literal('simulated'), verifiedAt: z.iso.datetime() }),
  z.object({
    kind: z.literal('ssh'),
    verifiedAt: z.iso.datetime(),
    imageVersion: z.string(),
    manifestDigest: z.string().regex(/^[0-9a-f]{64}$/),
    bootId: z.uuid(),
  }),
]);
export type GuestVerification = z.infer<typeof guestVerificationSchema>;

export const machineStateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pending') }),
  z.object({ kind: z.literal('provisioning'), allocationId: allocationIdSchema }),
  z.object({
    kind: z.literal('allocated'),
    allocationId: allocationIdSchema,
    serverId: z.string(),
    power: powerSchema,
    guest: guestVerificationSchema,
  }),
  z.object({ kind: z.literal('failed'), error: failureSchema }),
  z.object({ kind: z.literal('destroyed'), destroyedAt: z.iso.datetime() }),
]);
export type MachineState = z.infer<typeof machineStateSchema>;

export const machineSchema = z.object({
  id: machineIdSchema,
  accountId: accountIdSchema,
  projectId: projectIdSchema,
  spec: machineSpecSchema,
  provider: providerKindSchema,
  state: machineStateSchema,
  version: z.int().positive(),
  createdAt: z.iso.datetime(),
});
export type Machine = z.infer<typeof machineSchema>;
export const machineResponseSchema = z.object({ machine: machineSchema });
export const machinesResponseSchema = z.object({ machines: z.array(machineSchema) });
export const operationsResponseSchema = z.object({ operations: z.array(operationSchema) });

export function isOperationTerminal(operation: Operation): boolean {
  return ['succeeded', 'failed', 'cancelled'].includes(operation.progress.kind);
}

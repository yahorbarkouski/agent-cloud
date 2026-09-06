import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export const accountIdSchema = z
  .string()
  .regex(new RegExp(`^acc_${uuid}$`))
  .brand<'AccountId'>();
export const projectIdSchema = z
  .string()
  .regex(new RegExp(`^prj_${uuid}$`))
  .brand<'ProjectId'>();
export const machineIdSchema = z
  .string()
  .regex(new RegExp(`^vm_${uuid}$`))
  .brand<'MachineId'>();
export const allocationIdSchema = z
  .string()
  .regex(new RegExp(`^alloc_${uuid}$`))
  .brand<'AllocationId'>();
export const operationIdSchema = z
  .string()
  .regex(new RegExp(`^op_${uuid}$`))
  .brand<'OperationId'>();
export const grantIdSchema = z
  .string()
  .regex(new RegExp(`^grant_${uuid}$`))
  .brand<'GrantId'>();
export const attemptIdSchema = z
  .string()
  .regex(new RegExp(`^att_${uuid}$`))
  .brand<'AttemptId'>();

export type AccountId = z.infer<typeof accountIdSchema>;
export type ProjectId = z.infer<typeof projectIdSchema>;
export type MachineId = z.infer<typeof machineIdSchema>;
export type AllocationId = z.infer<typeof allocationIdSchema>;
export type OperationId = z.infer<typeof operationIdSchema>;
export type GrantId = z.infer<typeof grantIdSchema>;
export type AttemptId = z.infer<typeof attemptIdSchema>;

export const newId = {
  account: (): AccountId => accountIdSchema.parse(`acc_${randomUUID()}`),
  project: (): ProjectId => projectIdSchema.parse(`prj_${randomUUID()}`),
  machine: (): MachineId => machineIdSchema.parse(`vm_${randomUUID()}`),
  allocation: (): AllocationId => allocationIdSchema.parse(`alloc_${randomUUID()}`),
  operation: (): OperationId => operationIdSchema.parse(`op_${randomUUID()}`),
  grant: (): GrantId => grantIdSchema.parse(`grant_${randomUUID()}`),
  attempt: (): AttemptId => attemptIdSchema.parse(`att_${randomUUID()}`),
};

export const resourceRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('server'), id: z.string().min(1) }),
  z.object({ kind: z.literal('primary_ip'), id: z.string().min(1) }),
]);
export type ResourceRef = z.infer<typeof resourceRefSchema>;

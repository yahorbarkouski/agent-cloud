import { z } from 'zod';
import { accountIdSchema, grantIdSchema, projectIdSchema } from './ids.js';
import { nameSchema } from './lifecycle.js';
import { regionSchema, sizeSchema } from './catalog.js';

export const capabilitySchema = z.enum([
  'project:read',
  'project:create',
  'machine:read',
  'machine:create',
  'machine:operate',
  'machine:destroy',
  'machine:destroy:data_loss',
  'machine:exec',
  'deploy:write',
  'route:publish',
  'backup:read',
  'backup:create',
  'backup:restore',
  'backup:purge',
  'grant:manage',
  'usage:read',
]);
export type Capability = z.infer<typeof capabilitySchema>;

export const grantPolicySchema = z.object({
  capabilities: z.array(capabilitySchema),
  projects: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('all') }),
    z.object({ kind: z.literal('selected'), ids: z.array(projectIdSchema).min(1) }),
  ]),
  sizes: z.array(sizeSchema).min(1),
  regions: z.array(regionSchema).min(1),
  maxMachines: z.int().min(0).max(1000),
  maxHourlyMicroEur: z.int().min(0),
});
export type GrantPolicy = z.infer<typeof grantPolicySchema>;

export const principalSchema = z.object({
  accountId: accountIdSchema,
  grantId: grantIdSchema,
  policy: grantPolicySchema,
});
export type Principal = z.infer<typeof principalSchema>;

export const projectInputSchema = z.strictObject({ name: nameSchema });
export const projectSchema = z.object({
  id: projectIdSchema,
  accountId: accountIdSchema,
  name: nameSchema,
  createdAt: z.iso.datetime(),
});
export type Project = z.infer<typeof projectSchema>;
export const projectResponseSchema = z.object({ project: projectSchema });
export const projectsResponseSchema = z.object({ projects: z.array(projectSchema) });
export const whoamiResponseSchema = z.object({ principal: principalSchema });

export const grantInputSchema = z.strictObject({
  name: nameSchema,
  policy: grantPolicySchema,
  expiresAt: z.iso.datetime(),
});

import { z } from 'zod';
import { providerKindSchema } from './catalog.js';

/** Configured API features; guest compatibility, permissions and current health are separate. */
export const capabilitiesResponseSchema = z.strictObject({
  protocolVersion: z.literal(1),
  provider: providerKindSchema,
  configured: z.strictObject({
    machineLifecycle: z.boolean(),
    ssh: z.boolean(),
    files: z.boolean(),
    durableCommands: z.boolean(),
    compose: z.boolean(),
    routing: z.boolean(),
    protectedBackups: z.boolean(),
    recipes: z.boolean(),
  }),
});
export type CapabilitiesResponse = z.infer<typeof capabilitiesResponseSchema>;

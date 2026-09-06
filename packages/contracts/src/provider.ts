import { z } from 'zod';
import { failureSchema } from './errors.js';
import type { attemptIdSchema } from './ids.js';
import type { Catalog } from './catalog.js';
import { powerSchema } from './lifecycle.js';

export const providerCommandSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('create'),
    name: z.string(),
    serverType: z.string(),
    region: z.string(),
    labels: z.record(z.string(), z.string()),
  }),
  z.object({ kind: z.literal('reboot'), serverId: z.string() }),
  z.object({ kind: z.literal('power_off'), serverId: z.string() }),
  z.object({ kind: z.literal('power_on'), serverId: z.string() }),
  z.object({ kind: z.literal('resize'), serverId: z.string(), serverType: z.string() }),
  z.object({ kind: z.literal('destroy'), serverId: z.string() }),
]);
export type ProviderCommand = z.infer<typeof providerCommandSchema>;

export const submissionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('accepted'), serverId: z.string(), actionId: z.string() }),
  z.object({ kind: z.literal('completed'), serverId: z.string() }),
  z.object({ kind: z.literal('rejected'), error: failureSchema }),
  z.object({ kind: z.literal('unknown'), reason: z.string() }),
]);
export type Submission = z.infer<typeof submissionSchema>;

export const providerActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('running') }),
  z.object({ kind: z.literal('succeeded') }),
  z.object({ kind: z.literal('failed'), error: failureSchema }),
]);
export type ProviderAction = z.infer<typeof providerActionSchema>;

export const providerServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  serverType: z.string(),
  region: z.string(),
  power: powerSchema,
  labels: z.record(z.string(), z.string()),
  ipv4: z.string().nullable(),
});
export type ProviderServer = z.infer<typeof providerServerSchema>;

export const attemptOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('prepared') }),
  ...submissionSchema.options,
]);
export type AttemptOutcome = z.infer<typeof attemptOutcomeSchema>;

export interface MachineProvider {
  readonly kind: 'simulated' | 'hetzner';
  getCatalog(): Promise<Catalog>;
  submit(input: {
    attemptId: z.infer<typeof attemptIdSchema>;
    command: ProviderCommand;
  }): Promise<Submission>;
  getAction(input: { actionId: string }): Promise<ProviderAction>;
  getServer(input: { serverId: string }): Promise<ProviderServer | null>;
  findServers(input: { labels: Readonly<Record<string, string>> }): Promise<ProviderServer[]>;
}

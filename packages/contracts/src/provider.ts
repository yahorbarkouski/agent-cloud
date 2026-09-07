import { z } from 'zod';
import { failureSchema } from './errors.js';
import { resourceRefSchema, type attemptIdSchema } from './ids.js';
import type { Catalog } from './catalog.js';
import { powerSchema } from './lifecycle.js';
import { bootstrapReferenceSchema } from './guest.js';
import { recoveryIdSchema } from './operator-recovery.js';

export const networkProfileSchema = z.enum(['legacy', 'managed_ipv4']);
export const providerNetworkSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('legacy') }),
  z.object({ kind: z.literal('primary_ip'), id: z.string().min(1) }),
]);

export const providerCommandSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('create_primary_ip'),
    name: z.string(),
    region: z.string(),
    labels: z.record(z.string(), z.string()),
  }),
  z.object({ kind: z.literal('delete_primary_ip'), primaryIpId: z.string() }),
  z.object({
    kind: z.literal('create'),
    name: z.string(),
    serverType: z.string(),
    region: z.string(),
    labels: z.record(z.string(), z.string()),
    network: providerNetworkSchema,
  }),
  z.strictObject({
    kind: z.literal('create_guest'),
    name: z.string().min(1),
    serverType: z.string().min(1),
    region: z.string().min(1),
    labels: z.record(z.string(), z.string()),
    network: z.strictObject({ kind: z.literal('primary_ip'), id: z.string().min(1) }),
    bootstrap: bootstrapReferenceSchema,
  }),
  z.object({ kind: z.literal('reboot'), serverId: z.string() }),
  z.object({ kind: z.literal('power_off'), serverId: z.string() }),
  z.object({ kind: z.literal('power_on'), serverId: z.string() }),
  z.object({ kind: z.literal('resize'), serverId: z.string(), serverType: z.string() }),
  z.object({ kind: z.literal('destroy'), serverId: z.string() }),
]);
export type ProviderCommand = z.infer<typeof providerCommandSchema>;

export function isServerCreateCommand(
  command: ProviderCommand,
): command is Extract<ProviderCommand, { kind: 'create' | 'create_guest' }> {
  return command.kind === 'create' || command.kind === 'create_guest';
}

export const submissionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('accepted'), resource: resourceRefSchema, actionId: z.string() }),
  z.object({ kind: z.literal('completed'), resource: resourceRefSchema }),
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
  primaryIpId: z.string().nullable(),
});
export type ProviderServer = z.infer<typeof providerServerSchema>;
export const providerPrimaryIpSchema = z.object({
  id: z.string(),
  name: z.string(),
  region: z.string(),
  ipv4: z.ipv4(),
  labels: z.record(z.string(), z.string()),
  autoDelete: z.boolean(),
  assignment: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('unassigned') }),
    z.object({ kind: z.literal('server'), serverId: z.string() }),
  ]),
});
export type ProviderPrimaryIp = z.infer<typeof providerPrimaryIpSchema>;
export const resourceObservationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('server'), server: providerServerSchema }),
  z.object({ kind: z.literal('primary_ip'), primaryIp: providerPrimaryIpSchema }),
  z.object({ kind: z.literal('absent'), resource: resourceRefSchema }),
]);
export type ResourceObservation = z.infer<typeof resourceObservationSchema>;
export const effectResolutionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pending') }),
  z.object({ kind: z.literal('confirmed'), observation: resourceObservationSchema }),
  z.object({ kind: z.literal('failed'), error: failureSchema }),
  z.strictObject({ kind: z.literal('operator_closed'), recoveryId: recoveryIdSchema }),
]);
export type EffectResolution = z.infer<typeof effectResolutionSchema>;
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
  getPrimaryIp(input: { primaryIpId: string }): Promise<ProviderPrimaryIp | null>;
  findPrimaryIps(input: { labels: Readonly<Record<string, string>> }): Promise<ProviderPrimaryIp[]>;
}

import { z } from 'zod';
import { architectureSchema } from './catalog.js';
import {
  imageProviderIdSchema,
  type ImageProviderCommand,
  type ImageResourceRef,
  type ImageSubmission,
} from './image-build.js';
import type { ProviderAction } from './provider.js';

export const imageBaseSchema = z.strictObject({
  id: imageProviderIdSchema,
  type: z.string(),
  status: z.string(),
  architecture: architectureSchema,
  osFlavor: z.string(),
  osVersion: z.string().nullable(),
  diskGb: z.number().nonnegative(),
  deprecated: z.boolean(),
  deleted: z.boolean(),
});
export type ImageBase = z.infer<typeof imageBaseSchema>;
export type ImageAction = ProviderAction | { kind: 'missing' };

/** Snapshot actions run on the source server; their receipt owns the resulting image. */
export function imageActionTarget(
  command: ImageProviderCommand,
  resource: ImageResourceRef,
): ImageResourceRef {
  return command.kind === 'create_snapshot' ? { kind: 'server', id: command.serverId } : resource;
}

const fields = { id: imageProviderIdSchema, labels: z.record(z.string(), z.string()) };
export const imageProviderResourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('server'),
    ...fields,
    name: z.string(),
    serverType: z.string(),
    region: z.string(),
    architecture: architectureSchema,
    power: z.enum(['running', 'off', 'transitioning']),
    imageId: imageProviderIdSchema.nullable(),
    primaryIpId: imageProviderIdSchema.nullable(),
    ipv4: z.ipv4().nullable(),
    firewalls: z.array(z.strictObject({ id: imageProviderIdSchema, status: z.string() })),
    deleteProtected: z.boolean(),
    diskGb: z.int().positive(),
  }),
  z.strictObject({
    kind: z.literal('primary_ip'),
    ...fields,
    region: z.string(),
    ipv4: z.ipv4(),
    autoDelete: z.boolean(),
    serverId: imageProviderIdSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal('ssh_key'),
    ...fields,
    publicKey: z.string().min(1),
    fingerprint: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('firewall'),
    ...fields,
    rules: z.array(
      z.strictObject({
        direction: z.string(),
        protocol: z.string(),
        port: z.string().nullable(),
        sourceIps: z.array(z.string()),
        destinationIps: z.array(z.string()),
      }),
    ),
    attachments: z.array(
      z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('server'), id: imageProviderIdSchema }),
        z.strictObject({ kind: z.literal('selector'), selector: z.string() }),
      ]),
    ),
  }),
  z.strictObject({
    kind: z.literal('snapshot'),
    ...fields,
    architecture: architectureSchema,
    status: z.enum(['creating', 'available', 'unavailable']),
    sourceServerId: imageProviderIdSchema.nullable(),
    imageSizeGb: z.number().nonnegative().nullable(),
    diskGb: z.int().positive(),
    deleteProtected: z.boolean(),
    createdAt: z.iso.datetime(),
  }),
]);
export type ImageProviderResource = z.infer<typeof imageProviderResourceSchema>;
export const imageResourceStateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('unverified') }),
  z.strictObject({
    kind: z.literal('observed'),
    resource: imageProviderResourceSchema,
    at: z.iso.datetime(),
  }),
  z.strictObject({ kind: z.literal('absent'), at: z.iso.datetime() }),
]);
export interface ImageProvider {
  readonly kind: 'hetzner';
  submit(input: { effectId: string; command: ImageProviderCommand }): Promise<ImageSubmission>;
  get(resource: ImageResourceRef): Promise<ImageProviderResource | null>;
  find(input: {
    kind: ImageResourceRef['kind'];
    labels: Readonly<Record<string, string>>;
  }): Promise<ImageProviderResource[]>;
  getAction(input: { actionId: string; resource: ImageResourceRef }): Promise<ImageAction>;
  getBaseImage(imageId: string): Promise<ImageBase | null>;
}

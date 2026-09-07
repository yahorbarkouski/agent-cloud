import { z } from 'zod';
import {
  architectureSchema,
  imageBaseSchema,
  imageProviderResourceSchema,
  type ImageProviderResource,
  type ImageResourceRef,
} from '@agent-cloud/contracts';

export const numericImageId = z.int().positive();
const fields = { id: numericImageId, labels: z.record(z.string(), z.string()) };
const location = z.object({ name: z.string() });
export const providerImageSchema = z.object({
  ...fields,
  type: z.string(),
  status: z.string(),
  architecture: architectureSchema,
  os_flavor: z.string(),
  os_version: z.string().nullable(),
  disk_size: z.number().nonnegative(),
  image_size: z.number().nonnegative().nullable(),
  created: z.iso.datetime({ offset: true }).nullable(),
  created_from: z.object({ id: numericImageId }).nullable(),
  protection: z.object({ delete: z.boolean() }),
  deprecated: z.string().nullable(),
  deleted: z.string().nullable(),
});
const server = z.object({
  ...fields,
  name: z.string(),
  status: z.string(),
  location,
  server_type: z.object({ name: z.string(), architecture: architectureSchema }),
  primary_disk_size: z.int().positive(),
  image: z.object({ id: numericImageId }).nullable(),
  protection: z.object({ delete: z.boolean() }),
  public_net: z.object({
    ipv4: z.object({ id: numericImageId, ip: z.ipv4() }).nullable(),
    firewalls: z.array(z.object({ id: numericImageId, status: z.string() })),
  }),
});
const ip = z
  .object({
    ...fields,
    type: z.literal('ipv4'),
    ip: z.ipv4(),
    location,
    auto_delete: z.boolean(),
    assignee_type: z.enum(['server', 'unassigned']),
    assignee_id: numericImageId.nullable(),
  })
  .refine(
    (value) => value.assignee_type !== 'unassigned' || value.assignee_id === null,
    'Unassigned addresses cannot reference a server.',
  );
const key = z.object({ ...fields, public_key: z.string().min(1), fingerprint: z.string().min(1) });
const firewall = z.object({
  ...fields,
  rules: z.array(
    z.object({
      direction: z.string(),
      protocol: z.string(),
      port: z.string().nullable(),
      source_ips: z.array(z.string()),
      destination_ips: z.array(z.string()),
    }),
  ),
  applied_to: z.array(
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('server'), server: z.object({ id: numericImageId }) }),
      z.object({
        type: z.literal('label_selector'),
        label_selector: z.object({ selector: z.string() }),
      }),
    ]),
  ),
});

export function decodeImageResource(
  kind: ImageResourceRef['kind'],
  value: unknown,
): ImageProviderResource {
  switch (kind) {
    case 'server': {
      const v = server.parse(value);
      return imageProviderResourceSchema.parse({
        kind,
        id: String(v.id),
        labels: v.labels,
        name: v.name,
        serverType: v.server_type.name,
        architecture: v.server_type.architecture,
        region: v.location.name,
        diskGb: v.primary_disk_size,
        imageId: v.image ? String(v.image.id) : null,
        deleteProtected: v.protection.delete,
        power: v.status === 'running' || v.status === 'off' ? v.status : 'transitioning',
        primaryIpId: v.public_net.ipv4 ? String(v.public_net.ipv4.id) : null,
        ipv4: v.public_net.ipv4?.ip ?? null,
        firewalls: v.public_net.firewalls.map((rule) => ({
          id: String(rule.id),
          status: rule.status,
        })),
      });
    }
    case 'primary_ip': {
      const v = ip.parse(value);
      return {
        kind,
        id: String(v.id),
        labels: v.labels,
        region: v.location.name,
        ipv4: v.ip,
        autoDelete: v.auto_delete,
        serverId: v.assignee_id === null ? null : String(v.assignee_id),
      };
    }
    case 'ssh_key': {
      const v = key.parse(value);
      return {
        kind,
        id: String(v.id),
        labels: v.labels,
        publicKey: v.public_key.trim(),
        fingerprint: v.fingerprint,
      };
    }
    case 'firewall': {
      const v = firewall.parse(value);
      return {
        kind,
        id: String(v.id),
        labels: v.labels,
        rules: v.rules.map((rule) => ({
          direction: rule.direction,
          protocol: rule.protocol,
          port: rule.port,
          sourceIps: rule.source_ips,
          destinationIps: rule.destination_ips,
        })),
        attachments: v.applied_to.map((item) =>
          item.type === 'server'
            ? { kind: 'server', id: String(item.server.id) }
            : { kind: 'selector', selector: item.label_selector.selector },
        ),
      };
    }
    case 'snapshot': {
      const v = providerImageSchema.parse(value);
      if (v.type !== 'snapshot' || v.deleted !== null || v.created === null)
        throw new Error('Expected an existing provider snapshot.');
      return imageProviderResourceSchema.parse({
        kind,
        id: String(v.id),
        labels: v.labels,
        status: v.status,
        architecture: v.architecture,
        diskGb: v.disk_size,
        imageSizeGb: v.image_size,
        sourceServerId: v.created_from ? String(v.created_from.id) : null,
        deleteProtected: v.protection.delete,
        createdAt: new Date(v.created).toISOString(),
      });
    }
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export function decodeBaseImage(value: unknown) {
  const v = providerImageSchema.parse(value);
  return imageBaseSchema.parse({
    id: String(v.id),
    type: v.type,
    status: v.status,
    architecture: v.architecture,
    osFlavor: v.os_flavor,
    osVersion: v.os_version,
    diskGb: v.disk_size,
    deprecated: v.deprecated !== null,
    deleted: v.deleted !== null,
  });
}

export function imageResourceEndpoint(kind: ImageResourceRef['kind']) {
  switch (kind) {
    case 'server':
      return { path: '/servers', one: 'server', list: 'servers' };
    case 'primary_ip':
      return { path: '/primary_ips', one: 'primary_ip', list: 'primary_ips' };
    case 'ssh_key':
      return { path: '/ssh_keys', one: 'ssh_key', list: 'ssh_keys' };
    case 'firewall':
      return { path: '/firewalls', one: 'firewall', list: 'firewalls' };
    case 'snapshot':
      return { path: '/images', one: 'image', list: 'images' };
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

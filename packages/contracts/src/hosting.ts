import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { accountIdSchema, allocationIdSchema, machineIdSchema, projectIdSchema } from './ids.js';
import { apiUrlSchema } from './client.js';

/** Canonical ASCII names only; clients can explicitly convert internationalized names to punycode. */
export const hostnameSchema = z
  .string()
  .min(3)
  .max(253)
  .refine(
    (value) =>
      value.includes('.') &&
      !/^[0-9.]+$/.test(value) &&
      value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)),
    'Expected a lowercase DNS hostname without a wildcard or trailing dot.',
  );
export const applicationPortSchema = z
  .int()
  .min(1024)
  .max(65535)
  .refine(
    (port) => ![2019, 8081, 8443].includes(port),
    'Platform listener ports cannot be published.',
  );
export const routeNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,29}$/);
export const hostingCommandIdSchema = z.uuidv4();
export const domainChallengeSchema = z.strictObject({
  id: z.uuidv4(),
  hostname: hostnameSchema,
  recordName: z.string(),
  recordValue: z.string(),
  expiresAt: z.iso.datetime(),
  verifiedAt: z.iso.datetime().nullable(),
});
export const domainCreateSchema = z.strictObject({ hostname: hostnameSchema });
export const routePublishSchema = z
  .strictObject({
    commandId: hostingCommandIdSchema,
    machineId: machineIdSchema,
    destination: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('generated'), name: routeNameSchema }),
      z.strictObject({
        kind: z.literal('custom'),
        hostname: hostnameSchema,
        challengeId: z.uuidv4(),
      }),
      z.strictObject({ kind: z.literal('existing'), hostname: hostnameSchema }),
    ]),
    port: applicationPortSchema,
    expectedVersion: z.int().positive().nullable(),
  })
  .refine(
    (request) => request.destination.kind !== 'existing' || request.expectedVersion !== null,
    {
      path: ['expectedVersion'],
      message: 'Moving an existing route requires its explicit current version.',
    },
  );
export const routeRemoveSchema = z.strictObject({
  commandId: hostingCommandIdSchema,
  expectedVersion: z.int().positive(),
});
export const routeSchema = z.strictObject({
  hostname: hostnameSchema,
  accountId: accountIdSchema,
  projectId: projectIdSchema,
  machineId: machineIdSchema,
  allocationId: allocationIdSchema,
  port: applicationPortSchema,
  version: z.int().positive(),
  state: z.enum(['pending', 'active', 'removed']),
  appliedVersion: z.int().positive().nullable(),
  gatewayAppliedVersion: z.int().positive().nullable(),
  application: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('pending'), attempts: z.int().min(0).max(5) }),
    z.strictObject({ kind: z.literal('applied') }),
    z.strictObject({ kind: z.literal('blocked'), attempts: z.literal(5) }),
  ]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const routeResponseSchema = z.strictObject({ route: routeSchema });
export const routesResponseSchema = z.strictObject({ routes: z.array(routeSchema).max(100) });
export const domainResponseSchema = z.strictObject({ domain: domainChallengeSchema });
export const hostingGuestCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('put'),
    hostname: hostnameSchema,
    version: z.int().positive(),
    port: applicationPortSchema,
    retainFromVersion: z.int().positive(),
  }),
  z.strictObject({
    kind: z.literal('remove'),
    hostname: hostnameSchema,
    version: z.int().positive(),
    retainFromVersion: z.int().positive(),
  }),
  z.strictObject({ kind: z.literal('inspect'), hostname: hostnameSchema }),
]);
export const hostingGuestRouteSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('put'),
    hostname: hostnameSchema,
    version: z.int().positive(),
    port: applicationPortSchema,
  }),
  z.strictObject({
    kind: z.literal('remove'),
    hostname: hostnameSchema,
    version: z.int().positive(),
  }),
]);
export const hostingGuestResponseSchema = z.strictObject({
  route: hostingGuestRouteSchema.nullable(),
});
export const hostingSnapshotSchema = z.strictObject({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  routes: z
    .array(
      z.strictObject({
        hostname: hostnameSchema,
        address: z.union([z.ipv4(), z.ipv6()]),
        serverName: hostnameSchema,
        version: z.int().positive(),
      }),
    )
    .max(1000),
});
const absolutePath = z.string().refine(isAbsolute, 'Use an absolute file path.');
export const hostingControlConfigSchema = z.strictObject({
  version: z.literal(1),
  applicationDomain: hostnameSchema,
  gatewayTokenFile: absolutePath,
  gatewayAddresses: z
    .array(z.union([z.ipv4(), z.ipv6()]))
    .min(1)
    .max(8),
  gatewayOrigin: apiUrlSchema,
});
export type RoutePublish = z.infer<typeof routePublishSchema>;
export type RouteRemove = z.infer<typeof routeRemoveSchema>;
export type HostingGuestCommand = z.infer<typeof hostingGuestCommandSchema>;
export type HostingGuestRoute = z.infer<typeof hostingGuestRouteSchema>;
export type HostingControlConfig = z.infer<typeof hostingControlConfigSchema>;

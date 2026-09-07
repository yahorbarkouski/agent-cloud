import { z } from 'zod';
import { catalogItemSchema } from './catalog.js';
import { currencySchema, microsSchema } from './money.js';
import { guestManifestSchema } from './guest.js';
import { imageArtifactsSchema, imageDigestSchema, imageInputsSchema } from './image-inputs.js';

export const imageBuildIdSchema = z.uuid().brand<'ImageBuildId'>();
export type ImageBuildId = z.infer<typeof imageBuildIdSchema>;
export const imageProviderIdSchema = z
  .string()
  .max(20)
  .regex(/^[1-9][0-9]*$/);
export const imageResourceKindSchema = z.enum([
  'server',
  'primary_ip',
  'ssh_key',
  'firewall',
  'snapshot',
]);
export const imageResourceRoleSchema = z.enum([
  'builder',
  'builder_ip',
  'verifier',
  'verifier_ip',
  'access_key',
  'access_firewall',
  'snapshot',
]);
export type ImageResourceRole = z.infer<typeof imageResourceRoleSchema>;
export const imageResourceRefSchema = z.strictObject({
  kind: imageResourceKindSchema,
  id: imageProviderIdSchema,
});
export type ImageResourceRef = z.infer<typeof imageResourceRefSchema>;
export const imageBuildLabelsSchema = z.strictObject({
  managed_by: z.literal('agent-cloud'),
  scope: z.literal('image-build'),
  build_id: imageBuildIdSchema,
  role: imageResourceRoleSchema,
});
export function imageBuildLabels(buildId: ImageBuildId, role: ImageResourceRole) {
  return imageBuildLabelsSchema.parse({
    managed_by: 'agent-cloud',
    scope: 'image-build',
    build_id: buildId,
    role,
  });
}
export function imageEffectLabels(input: {
  buildId: ImageBuildId;
  role: ImageResourceRole;
  effectId: string;
}) {
  return {
    ...imageBuildLabels(input.buildId, input.role),
    effect_id: z.uuid().parse(input.effectId),
  };
}
export function imageRoleKind(role: ImageResourceRole): ImageResourceRef['kind'] {
  switch (role) {
    case 'builder':
    case 'verifier':
      return 'server';
    case 'builder_ip':
    case 'verifier_ip':
      return 'primary_ip';
    case 'access_key':
      return 'ssh_key';
    case 'access_firewall':
      return 'firewall';
    case 'snapshot':
      return 'snapshot';
    default: {
      const exhaustive: never = role;
      return exhaustive;
    }
  }
}

const sshPublicKey = z
  .string()
  .max(512)
  .regex(/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/);
export const imageBuildSourceSchema = z.strictObject({
  manifest: guestManifestSchema,
  inputs: imageInputsSchema,
  artifacts: imageArtifactsSchema,
  manifestDigest: imageDigestSchema,
  checksumDigest: imageDigestSchema,
});
export const imageStoragePriceSchema = z.strictObject({
  currency: currencySchema,
  grossMicrosPerGbMonth: microsSchema,
  observedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export const imageBuildAdmissionSchema = z.strictObject({
  id: imageBuildIdSchema,
  provider: z.literal('hetzner'),
  source: imageBuildSourceSchema,
  offer: catalogItemSchema,
  storagePrice: imageStoragePriceSchema,
  baseImageId: imageProviderIdSchema,
  access: z.strictObject({
    managementAddress: z.ipv4(),
    publicKey: sshPublicKey,
    hostPublicKey: sshPublicKey,
    secretId: z.uuid(),
  }),
  budget: z.strictObject({
    currency: currencySchema,
    maxVmGrossMicros: microsSchema,
    maxSnapshotMonthlyGrossMicros: microsSchema,
    maxSnapshotGb: z.int().positive().max(1024),
  }),
  admittedAt: z.iso.datetime(),
  deadlineAt: z.iso.datetime(),
  retention: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('verification_only') }),
    z.strictObject({ kind: z.literal('retain'), deleteAfter: z.iso.datetime() }),
  ]),
});
export type ImageBuildAdmission = z.infer<typeof imageBuildAdmissionSchema>;
export const imageBuildLimitsSchema = z.strictObject({
  currency: currencySchema,
  maxOpenBuilds: z.int().nonnegative().max(100),
  maxVmGrossMicros: microsSchema,
  maxSnapshotMonthlyGrossMicros: microsSchema,
});
export type ImageBuildLimits = z.infer<typeof imageBuildLimitsSchema>;
export const imageBuildStateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('running') }),
  z.strictObject({
    kind: z.literal('cleaning'),
    reason: z.enum(['requested', 'expired', 'failed']),
  }),
  z.strictObject({ kind: z.literal('cleaned'), at: z.iso.datetime() }),
]);
export type ImageBuildState = z.infer<typeof imageBuildStateSchema>;

const createFields = {
  name: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9-]+$/),
  labels: imageBuildLabelsSchema,
};
export const imageProviderCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('create_ssh_key'), ...createFields, publicKey: sshPublicKey }),
  z.strictObject({
    kind: z.literal('create_firewall'),
    ...createFields,
    managementAddress: z.ipv4(),
  }),
  z.strictObject({
    kind: z.literal('create_primary_ip'),
    ...createFields,
    region: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('create_server'),
    ...createFields,
    serverType: z.string().min(1),
    region: z.string().min(1),
    imageId: imageProviderIdSchema,
    primaryIpId: imageProviderIdSchema,
    sshKeyId: imageProviderIdSchema,
    firewallId: imageProviderIdSchema,
    bootData: z.strictObject({
      kind: z.literal('image_build_secret'),
      id: z.uuid(),
      digest: imageDigestSchema,
    }),
  }),
  z.strictObject({
    kind: z.literal('power_off'),
    serverId: imageProviderIdSchema,
    sanitation: z.strictObject({
      kind: z.literal('sanitized'),
      builderId: imageBuildIdSchema,
      manifestDigest: imageDigestSchema,
    }),
  }),
  z.strictObject({
    kind: z.literal('create_snapshot'),
    ...createFields,
    serverId: imageProviderIdSchema,
  }),
  z.strictObject({ kind: z.literal('delete'), resource: imageResourceRefSchema }),
]);
export type ImageProviderCommand = z.infer<typeof imageProviderCommandSchema>;
export function isImageCreate(
  command: ImageProviderCommand,
): command is Extract<ImageProviderCommand, { labels: unknown }> {
  return 'labels' in command;
}
export const imageSubmissionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('accepted'),
    resource: imageResourceRefSchema,
    actionId: imageProviderIdSchema,
  }),
  z.strictObject({ kind: z.literal('completed'), resource: imageResourceRefSchema }),
  z.strictObject({ kind: z.literal('rejected'), reason: z.string().min(1).max(256) }),
  z.strictObject({ kind: z.literal('unknown'), reason: z.string().min(1).max(256) }),
]);
export type ImageSubmission = z.infer<typeof imageSubmissionSchema>;
export const imageEffectOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('prepared') }),
  ...imageSubmissionSchema.options,
]);
export const imageEffectResolutionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pending') }),
  z.strictObject({ kind: z.literal('superseded'), byEffectId: z.uuid() }),
  z.strictObject({ kind: z.literal('confirmed'), at: z.iso.datetime() }),
  z.strictObject({ kind: z.literal('failed'), reason: z.string().min(1).max(256) }),
]);
export type ImageEffectResolution = z.infer<typeof imageEffectResolutionSchema>;

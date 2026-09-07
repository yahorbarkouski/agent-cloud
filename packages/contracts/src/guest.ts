import { z } from 'zod';
import { architectureSchema } from './catalog.js';
import { accountIdSchema, allocationIdSchema, machineIdSchema, operationIdSchema } from './ids.js';

const publicKey = z
  .string()
  .max(512)
  .regex(/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/);
const caPublicKey = z
  .string()
  .max(512)
  .regex(/^(ssh-ed25519|ecdsa-sha2-nistp256) [A-Za-z0-9+/]+={0,2}$/);
export const guestImageSchema = z.strictObject({
  providerImage: z.string().min(1).max(128),
  architecture: architectureSchema,
  version: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/),
  manifestDigest: z.string().regex(/^[0-9a-f]{64}$/),
  sshUserCa: caPublicKey,
  sshHostCa: caPublicKey,
  tlsRoot: z.string().min(1).max(8192),
});
export type GuestImage = z.infer<typeof guestImageSchema>;

export const bootstrapSpecSchema = z.strictObject({
  version: z.literal(1),
  accountId: accountIdSchema,
  machineId: machineIdSchema,
  allocationId: allocationIdSchema,
  operationId: operationIdSchema,
  expiresAt: z.iso.datetime(),
  enrollmentUrl: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  }, 'Enrollment needs a plain HTTPS endpoint without credentials or query data.'),
  image: guestImageSchema,
});
export type BootstrapSpec = z.infer<typeof bootstrapSpecSchema>;
export const bootstrapReferenceSchema = z.strictObject({
  version: z.literal(1),
  allocationId: allocationIdSchema,
});
export type BootstrapReference = z.infer<typeof bootstrapReferenceSchema>;
export const guestEnrollmentInputSchema = z.strictObject({
  bootstrap: bootstrapReferenceSchema,
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  sshHostPublicKey: publicKey,
  tlsCsr: z.string().min(1).max(8192),
  imageVersion: z.string().min(1).max(64),
});
export type GuestEnrollmentInput = z.infer<typeof guestEnrollmentInputSchema>;
const identityFields = guestEnrollmentInputSchema.pick({
  sshHostPublicKey: true,
  tlsCsr: true,
  imageVersion: true,
}).shape;
const certificate = z.string().min(1).max(16384).regex(/\S/);
export const issuedGuestIdentitySchema = z.strictObject({
  kind: z.literal('issued'),
  ...identityFields,
  sshHostCertificate: certificate,
  tlsCertificate: certificate,
  issuedAt: z.iso.datetime(),
});
export type IssuedGuestIdentity = z.infer<typeof issuedGuestIdentitySchema>;
export const guestIdentitySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('claimed'), ...identityFields }),
  issuedGuestIdentitySchema,
]);
export type GuestIdentity = z.infer<typeof guestIdentitySchema>;
export const guestProofSchema = z.strictObject({
  version: z.literal(1),
  allocationId: allocationIdSchema,
  imageVersion: guestEnrollmentInputSchema.shape.imageVersion,
  manifestDigest: guestImageSchema.shape.manifestDigest,
  sshHostPublicKey: publicKey,
  tlsCsr: guestEnrollmentInputSchema.shape.tlsCsr,
});
export type GuestProof = z.infer<typeof guestProofSchema>;

export const guestManifestSchema = z.strictObject({
  format: z.literal(1),
  version: guestImageSchema.shape.version,
  architecture: architectureSchema,
  components: z.strictObject({
    node: z.string().min(1),
    docker: z.string().min(1),
    compose: z.string().min(1),
    caddy: z.string().min(1),
    step: z.string().min(1),
    guestctlSha256: guestImageSchema.shape.manifestDigest,
  }),
  trust: guestImageSchema.pick({ sshUserCa: true, sshHostCa: true, tlsRoot: true }),
});
export type GuestManifest = z.infer<typeof guestManifestSchema>;
export const guestBootstrapFileSchema = z.strictObject({
  spec: bootstrapSpecSchema,
  token: guestEnrollmentInputSchema.shape.token,
});
export type GuestBootstrapFile = z.infer<typeof guestBootstrapFileSchema>;

const versionCheck = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ok'), version: z.string().min(1).max(64) }),
  z.strictObject({ kind: z.literal('unavailable') }),
]);
export const guestRuntimeSchema = z.strictObject({
  version: z.literal(1),
  proof: guestProofSchema,
  manifest: guestManifestSchema,
  architecture: architectureSchema,
  bootId: z.uuid(),
  checks: z.strictObject({
    node: versionCheck,
    docker: versionCheck,
    compose: versionCheck,
    caddy: versionCheck,
    step: versionCheck,
    disk: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('ok'),
        availableBytes: z.int().nonnegative(),
        totalBytes: z.int().positive(),
      }),
      z.strictObject({ kind: z.literal('unavailable') }),
    ]),
    proxy: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('ok'),
        allocationId: allocationIdSchema,
        imageVersion: guestImageSchema.shape.version,
      }),
      z.strictObject({ kind: z.literal('unavailable') }),
    ]),
  }),
});
export type GuestRuntime = z.infer<typeof guestRuntimeSchema>;

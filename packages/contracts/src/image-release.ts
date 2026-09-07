import { z } from 'zod';
import { guestManifestSchema } from './guest.js';
import { imageArtifactsSchema, imageDigestSchema, imageInputsSchema } from './image-inputs.js';

const providerId = z
  .string()
  .max(20)
  .regex(/^[1-9][0-9]*$/);
export const imageReleasePayloadSchema = z.strictObject({
  format: z.literal(1),
  buildId: z.uuid(),
  issuedAt: z.iso.datetime(),
  retainUntil: z.iso.datetime(),
  manifest: guestManifestSchema,
  inputs: imageInputsSchema,
  artifacts: imageArtifactsSchema,
  sanitation: z.strictObject({
    kind: z.literal('sanitized'),
    builderId: z.uuid(),
    serverId: providerId,
    manifestDigest: imageDigestSchema,
  }),
  snapshot: z.strictObject({
    provider: z.literal('hetzner'),
    id: providerId,
    sourceServerId: providerId,
    diskGb: z.int().positive().max(1024),
    sourceStoppedAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
  }),
  verifiedBoot: z.strictObject({
    serverId: providerId,
    bootId: z.uuid(),
    manifestDigest: imageDigestSchema,
    checkedAt: z.iso.datetime(),
  }),
});
export type ImageReleasePayload = z.infer<typeof imageReleasePayloadSchema>;

export const signedImageReleaseSchema = z.strictObject({
  payload: imageReleasePayloadSchema,
  signature: z.strictObject({
    algorithm: z.literal('Ed25519'),
    keyId: imageDigestSchema,
    value: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  }),
});
export type SignedImageRelease = z.infer<typeof signedImageReleaseSchema>;

export const imageReleaseEvidenceSchema = imageReleasePayloadSchema.omit({ issuedAt: true });
export type ImageReleaseEvidence = z.infer<typeof imageReleaseEvidenceSchema>;
export const imagePublicationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('waiting') }),
  z.strictObject({ kind: z.literal('prepared'), evidence: imageReleaseEvidenceSchema }),
  z.strictObject({ kind: z.literal('published'), release: signedImageReleaseSchema }),
]);

export const imageReleaseKeySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('trusted'),
    publicKey: z
      .string()
      .max(1024)
      .regex(
        /^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PUBLIC KEY-----\r?\n?$/,
      ),
    signedFrom: z.iso.datetime(),
    signedUntil: z.iso.datetime(),
    verifyUntil: z.iso.datetime(),
  }),
  z.strictObject({ kind: z.literal('revoked'), keyId: imageDigestSchema }),
]);
export type ImageReleaseKey = z.infer<typeof imageReleaseKeySchema>;

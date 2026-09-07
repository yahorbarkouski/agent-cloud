import { z } from 'zod';
import { imageProviderIdSchema } from './ids.js';
import {
  guestIdentitySchema,
  imageVerifierSpecSchema,
  imageVerifierRuntimeSchema,
  issuedGuestIdentitySchema,
} from './guest.js';

export const imageVerificationResultSchema = z.strictObject({
  serverId: imageProviderIdSchema,
  effectId: z.uuid(),
  snapshotId: imageProviderIdSchema,
  runtime: imageVerifierRuntimeSchema,
  verifiedAt: z.iso.datetime(),
});
export type ImageVerificationResult = z.infer<typeof imageVerificationResultSchema>;
const prepared = { spec: imageVerifierSpecSchema };
export const imageVerificationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('waiting') }),
  z.strictObject({ kind: z.literal('prepared'), ...prepared }),
  z.strictObject({
    kind: z.literal('claimed'),
    ...prepared,
    identity: guestIdentitySchema.options[0],
  }),
  z.strictObject({ kind: z.literal('enrolled'), ...prepared, identity: issuedGuestIdentitySchema }),
  z.strictObject({
    kind: z.literal('verified'),
    ...prepared,
    identity: issuedGuestIdentitySchema,
    result: imageVerificationResultSchema,
  }),
]);

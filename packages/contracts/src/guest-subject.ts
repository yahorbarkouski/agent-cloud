import { z } from 'zod';
import { allocationIdSchema, imageBuildIdSchema } from './ids.js';

export const allocationSubjectSchema = z.strictObject({
  kind: z.literal('allocation'),
  id: allocationIdSchema,
});
export const imageVerifierSubjectSchema = z.strictObject({
  kind: z.literal('image_verifier'),
  id: imageBuildIdSchema,
});
export const guestSubjectSchema = z.discriminatedUnion('kind', [
  allocationSubjectSchema,
  imageVerifierSubjectSchema,
]);
export type GuestSubject = z.infer<typeof guestSubjectSchema>;

/** Separate namespaces preserve existing allocation principals without inventing allocations. */
export function guestSubjectKey(subject: GuestSubject): string {
  const parsed = guestSubjectSchema.parse(subject);
  switch (parsed.kind) {
    case 'allocation':
      return parsed.id;
    case 'image_verifier':
      return `verify_${parsed.id}`;
    default: {
      const exhaustive: never = parsed;
      return exhaustive;
    }
  }
}
export function sameGuestSubject(left: GuestSubject, right: GuestSubject) {
  return left.kind === right.kind && left.id === right.id;
}

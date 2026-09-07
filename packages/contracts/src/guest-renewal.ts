import { z } from 'zod';
import { allocationIdSchema } from './ids.js';

export const guestRenewalClaimsSchema = z.strictObject({
  version: z.literal(1),
  allocationId: allocationIdSchema,
  requestedAt: z.iso.datetime(),
});
export const guestRenewalInputSchema = guestRenewalClaimsSchema.extend({
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
export type GuestRenewalInput = z.infer<typeof guestRenewalInputSchema>;

/** Domain separation and explicit field order keep signatures independent of JSON object order. */
export function guestRenewalMessage(input: z.infer<typeof guestRenewalClaimsSchema>): string {
  return JSON.stringify(['agent-cloud:guest-renewal:v1', input.allocationId, input.requestedAt]);
}

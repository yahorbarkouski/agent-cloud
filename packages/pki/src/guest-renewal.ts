import { sign, verify, type KeyObject } from 'node:crypto';
import {
  CloudError,
  guestRenewalInputSchema,
  guestRenewalMessage,
  type GuestRenewalInput,
} from '@agent-cloud/contracts';

function requireKey(key: KeyObject) {
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
    throw new CloudError('unauthenticated', 'Guest renewal requires its registered P-256 key.');
}

export function signGuestRenewal(input: {
  allocationId: GuestRenewalInput['allocationId'];
  requestedAt: string;
  key: KeyObject;
}): GuestRenewalInput {
  requireKey(input.key);
  const claims = {
    version: 1,
    allocationId: input.allocationId,
    requestedAt: input.requestedAt,
  } satisfies Pick<GuestRenewalInput, 'version' | 'allocationId' | 'requestedAt'>;
  return guestRenewalInputSchema.parse({
    ...claims,
    signature: sign('sha256', Buffer.from(guestRenewalMessage(claims)), {
      key: input.key,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url'),
  });
}

/** An expired certificate supplies the registry key, not a new trust decision. */
export function verifyGuestRenewal(input: {
  request: GuestRenewalInput;
  key: KeyObject;
  now: Date;
}): void {
  const request = guestRenewalInputSchema.parse(input.request);
  requireKey(input.key);
  const skew = input.now.getTime() - Date.parse(request.requestedAt);
  if (
    skew < -30_000 ||
    skew > 300_000 ||
    !verify(
      'sha256',
      Buffer.from(guestRenewalMessage(request)),
      { key: input.key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(request.signature, 'base64url'),
    )
  )
    throw new CloudError('unauthenticated', 'Guest renewal proof is invalid or expired.');
}

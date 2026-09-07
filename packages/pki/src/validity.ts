import { CloudError } from '@agent-cloud/contracts';

export type CertificateTiming =
  | { kind: 'signing'; startedAt: number }
  | { kind: 'installed'; issuedAt: number };

/** The persisted issuance timestamp follows signing; it is not the signing start time. */
export function inspectValidity(input: {
  after: number;
  before: number;
  maximum: number;
  timing: CertificateTiming;
}) {
  const { after, before, maximum, timing } = input;
  const now = Date.now();
  const incompatible =
    timing.kind === 'signing'
      ? after < timing.startedAt - 65_000 || before > timing.startedAt + maximum + 1000
      : after > timing.issuedAt ||
        before <= timing.issuedAt ||
        timing.issuedAt > now ||
        before - after > maximum + 65_000;
  if (after > now || before <= now + 30_000 || incompatible)
    throw new CloudError(
      'provider_unavailable',
      'CA returned an incompatible certificate validity period.',
    );
}

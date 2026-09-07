import type { KeyObject, X509Certificate } from 'node:crypto';
import { CloudError } from '@agent-cloud/contracts';
import { z } from 'zod';
import { inspectValidity, type CertificateTiming } from './validity.js';

/** Chain validation is performed by Smallstep before this allocation-specific check. */
export function inspectIssuedTls(
  leaf: X509Certificate,
  expected: { name: string; key: KeyObject; timing: CertificateTiming },
): void {
  if (
    leaf.ca ||
    leaf.subjectAltName !== `DNS:${expected.name}` ||
    leaf.checkHost(expected.name) !== expected.name ||
    !z.tuple([z.literal('1.3.6.1.5.5.7.3.1')]).safeParse(leaf.keyUsage).success ||
    !leaf.publicKey
      .export({ type: 'spki', format: 'der' })
      .equals(expected.key.export({ type: 'spki', format: 'der' }))
  )
    throw new CloudError('provider_unavailable', 'CA returned an incompatible guest certificate.');
  inspectValidity({
    after: leaf.validFromDate.getTime(),
    before: leaf.validToDate.getTime(),
    maximum: 3_600_000,
    timing: expected.timing,
  });
}

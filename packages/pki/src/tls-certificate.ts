import type { KeyObject, X509Certificate } from 'node:crypto';
import { CloudError } from '@agent-cloud/contracts';
import { z } from 'zod';

/** Chain validation is performed by Smallstep before this allocation-specific check. */
export function inspectIssuedTls(
  leaf: X509Certificate,
  expected: { name: string; key: KeyObject; startedAt: number },
): void {
  const now = Date.now();
  if (
    leaf.ca ||
    leaf.subjectAltName !== `DNS:${expected.name}` ||
    leaf.checkHost(expected.name) !== expected.name ||
    !z.tuple([z.literal('1.3.6.1.5.5.7.3.1')]).safeParse(leaf.keyUsage).success ||
    !leaf.publicKey
      .export({ type: 'spki', format: 'der' })
      .equals(expected.key.export({ type: 'spki', format: 'der' })) ||
    leaf.validFromDate.getTime() > now ||
    leaf.validFromDate.getTime() < expected.startedAt - 65_000 ||
    leaf.validToDate.getTime() <= now + 30_000 ||
    leaf.validToDate.getTime() > expected.startedAt + 3_601_000
  )
    throw new CloudError('provider_unavailable', 'CA returned an incompatible guest certificate.');
}

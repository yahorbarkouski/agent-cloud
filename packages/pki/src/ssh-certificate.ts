import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CloudError } from '@agent-cloud/contracts';
import { inspectValidity, type CertificateTiming } from './validity.js';

function fingerprint(publicKey: string) {
  const encoded = publicKey.split(' ')[1];
  if (!encoded) throw new Error('Expected an SSH public key.');
  return (
    'SHA256:' +
    createHash('sha256').update(Buffer.from(encoded, 'base64')).digest('base64').replace(/=+$/, '')
  );
}
/** Validate native Smallstep inspection before exposing a CA response to any guest. */
export function inspectIssuedSsh(
  value: unknown,
  expected: {
    kind: 'host' | 'probe';
    key: string;
    ca: string;
    principal: string;
    timing: CertificateTiming;
  },
) {
  const schema = z.object({
    Type: z.literal(expected.kind === 'host' ? 'host' : 'user'),
    KeyName: z.literal('ssh-ed25519-cert-v01@openssh.com'),
    KeyFingerprint: z.literal(fingerprint(expected.key)),
    SigningKeyFingerprint: z.literal(fingerprint(expected.ca)),
    KeyID: z.literal(expected.principal),
    Principals: z.tuple([z.literal(expected.principal)]),
    ValidAfter: z.iso.datetime({ offset: true }),
    ValidBefore: z.iso.datetime({ offset: true }),
    CriticalOptions:
      expected.kind === 'host'
        ? z.strictObject({})
        : z.strictObject({ 'force-command': z.literal('/usr/local/bin/guestctl identity --json') }),
    Extensions: z.strictObject({}),
  });
  const result = schema.safeParse(value);
  if (!result.success)
    throw new CloudError('provider_unavailable', 'CA returned an incompatible SSH certificate.');
  const after = Date.parse(result.data.ValidAfter);
  const before = Date.parse(result.data.ValidBefore);
  const maximum = expected.kind === 'host' ? 3_600_000 : 300_000;
  inspectValidity({ after, before, maximum, timing: expected.timing });
  return { expiresAt: new Date(before).toISOString() };
}

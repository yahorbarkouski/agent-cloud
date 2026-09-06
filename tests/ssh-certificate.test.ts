import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { inspectIssuedSsh } from '../packages/pki/src/ssh-certificate.js';

it('rejects certificates that expand a probe beyond its key, CA, allocation or forced command', () => {
  const fingerprint = (value: string) =>
    'SHA256:' +
    createHash('sha256').update(Buffer.from(value, 'base64')).digest('base64').replace(/=+$/, '');
  const now = Date.now();
  const expected = {
    kind: 'probe',
    key: 'ssh-ed25519 AAAA',
    ca: 'ssh-ed25519 BBBB',
    principal: 'probe-allocation',
    startedAt: now,
  } satisfies Parameters<typeof inspectIssuedSsh>[1];
  const valid = {
    Type: 'user',
    KeyName: 'ssh-ed25519-cert-v01@openssh.com',
    KeyID: expected.principal,
    KeyFingerprint: fingerprint('AAAA'),
    SigningKeyFingerprint: fingerprint('BBBB'),
    Principals: [expected.principal],
    ValidAfter: new Date(now - 60_000).toISOString(),
    ValidBefore: new Date(now + 300_000).toISOString(),
    CriticalOptions: { 'force-command': '/usr/local/bin/guestctl identity --json' },
    Extensions: {},
  };
  expect(inspectIssuedSsh(valid, expected).expiresAt).toBe(valid.ValidBefore);
  for (const mutation of [
    { Type: 'host' },
    { KeyFingerprint: fingerprint('CCCC') },
    { SigningKeyFingerprint: fingerprint('CCCC') },
    { Principals: [expected.principal, 'other-allocation'] },
    { Principals: [] },
    { KeyID: 'other-allocation' },
    { CriticalOptions: {} },
    { CriticalOptions: { 'force-command': '/bin/sh' } },
    { Extensions: { 'permit-port-forwarding': '' } },
    { ValidAfter: new Date(now - 120_000).toISOString() },
    { ValidBefore: new Date(now + 3_600_000).toISOString() },
    { ValidBefore: new Date(now - 1).toISOString() },
    { ValidBefore: 'forever' },
  ])
    expect(() => inspectIssuedSsh({ ...valid, ...mutation }, expected)).toThrow('incompatible SSH');
});

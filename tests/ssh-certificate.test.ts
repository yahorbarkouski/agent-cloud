import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { inspectIssuedSsh } from '../packages/pki/src/ssh-certificate.js';

it.each<'probe' | 'runtime' | 'backup'>(['probe', 'runtime', 'backup'])(
  'rejects certificates that expand %s beyond its key, CA, allocation or forced command',
  (kind) => {
    const fingerprint = (value: string) =>
      'SHA256:' +
      createHash('sha256').update(Buffer.from(value, 'base64')).digest('base64').replace(/=+$/, '');
    const now = Date.now();
    const expected = {
      kind,
      key: 'ssh-ed25519 AAAA',
      ca: 'ssh-ed25519 BBBB',
      principal: 'probe-allocation',
      timing: { kind: 'signing', startedAt: now },
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
      CriticalOptions: {
        'force-command':
          kind === 'probe'
            ? '/usr/local/bin/guestctl identity --json'
            : kind === 'backup'
              ? '/usr/bin/sudo -n -- /usr/local/bin/guestctl backup-dispatch'
              : '/usr/bin/sudo -n -- /usr/local/bin/guestctl inspect --json',
      },
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
      {
        CriticalOptions: {
          'force-command':
            kind === 'runtime'
              ? '/usr/local/bin/guestctl identity --json'
              : '/usr/bin/sudo -n -- /usr/local/bin/guestctl inspect --json',
        },
      },
      { Extensions: { 'permit-port-forwarding': '' } },
      { ValidAfter: new Date(now - 120_000).toISOString() },
      { ValidBefore: new Date(now + 3_600_000).toISOString() },
      { ValidBefore: new Date(now - 1).toISOString() },
      { ValidBefore: 'forever' },
    ])
      expect(() => inspectIssuedSsh({ ...valid, ...mutation }, expected)).toThrow('incompatible');
  },
);

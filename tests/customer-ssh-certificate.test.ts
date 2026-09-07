import { expect, it } from 'vitest';
import { type AccessSessionRecord } from '../packages/contracts/src/index.js';
import { customerSshClaim, inspectCustomerSsh } from '../packages/pki/src/customer-ssh.js';
import { sshFingerprint } from '../packages/pki/src/ssh-certificate.js';
import { accessPublicKey, accessTime, pendingAccessSession } from './access-fixture.js';

function attemptedSession() {
  return {
    ...pendingAccessSession(),
    issuance: { kind: 'attempted', attemptedAt: accessTime(1) },
    gateway: {
      id: 'local',
      origin: 'ws://127.0.0.1:4322',
      egressCidrs: ['::1/128', '127.0.0.1/32'],
    },
  } satisfies AccessSessionRecord;
}
const authority = { checkedAt: new Date(accessTime(10)), expiresAt: new Date(accessTime(3600)) };

it('bounds absolute customer validity by the earliest authority and original hard deadline', () => {
  const session = attemptedSession();
  const claim = customerSshClaim({ session, authority });
  expect(claim.validAfter).toBe(accessTime(-50));
  expect(claim.validBefore).toBe(accessTime(250));
  expect(claim.sourceAddresses).toEqual(['127.0.0.1/32', '::1/128']);
  expect(claim.publicKeyWire).toBe(session.publicKey.slice('ssh-ed25519 '.length));
  const shorter = customerSshClaim({
    session,
    authority: { ...authority, expiresAt: new Date(accessTime(30)) },
  });
  expect(shorter.validBefore).toBe(accessTime(30));
  const hard = customerSshClaim({
    session: { ...session, hardDeadline: accessTime(120) },
    authority,
  });
  expect(hard.validBefore).toBe(accessTime(120));
  const fractional = customerSshClaim({
    session,
    authority: {
      checkedAt: new Date(Date.parse(accessTime(10)) + 501),
      expiresAt: new Date(Date.parse(accessTime(12)) + 999),
    },
  });
  expect(fractional.validAfter).toBe(accessTime(-50));
  expect(fractional.validBefore).toBe(accessTime(12));
});

it('requires an open recorded attempt and unexpired authority at signing', () => {
  const session = attemptedSession();
  for (const invalid of [
    pendingAccessSession(),
    { ...session, issuance: { kind: 'unavailable', reason: 'signing_unknown' } },
    {
      ...session,
      connection: {
        kind: 'closed',
        closedAt: accessTime(9),
        reason: 'authorization_changed',
        previous: { kind: 'unclaimed' },
      },
    },
  ] satisfies AccessSessionRecord[])
    expect(() => customerSshClaim({ session: invalid, authority })).toThrow();
  for (const timing of [
    { ...authority, checkedAt: new Date(accessTime(0)) },
    { ...authority, checkedAt: new Date(accessTime(90)) },
    { ...authority, expiresAt: new Date(accessTime(10)) },
    { ...authority, expiresAt: new Date(Date.parse(accessTime(10)) + 999) },
    { ...authority, checkedAt: new Date(Number.NaN) },
    { ...authority, expiresAt: new Date(Number.NaN) },
  ])
    expect(() => customerSshClaim({ session, authority: timing })).toThrow();
});

it('rejects response policies that expand customer identity, sources, permissions or absolute validity', () => {
  const session = attemptedSession();
  const claim = customerSshClaim({ session, authority });
  const userCa = accessPublicKey();
  const inspection = {
    Type: 'user',
    KeyName: 'ssh-ed25519-cert-v01@openssh.com',
    KeyID: claim.keyId,
    KeyFingerprint: sshFingerprint(session.publicKey),
    SigningKeyFingerprint: sshFingerprint(userCa),
    Principals: [claim.principal],
    ValidAfter: claim.validAfter,
    ValidBefore: claim.validBefore,
    CriticalOptions: { 'source-address': claim.sourceAddresses.join(',') },
    Extensions: { 'permit-pty': '' },
  };
  expect(inspectCustomerSsh(inspection, { claim, userCa }).expiresAt).toBe(claim.validBefore);
  for (const mutation of [
    { Type: 'host' },
    { KeyName: 'ssh-rsa-cert-v01@openssh.com' },
    { KeyID: 'customer:other' },
    { KeyFingerprint: sshFingerprint(accessPublicKey()) },
    { SigningKeyFingerprint: sshFingerprint(accessPublicKey()) },
    { Principals: [] },
    { Principals: [claim.principal, 'root'] },
    { CriticalOptions: {} },
    { CriticalOptions: { 'source-address': '0.0.0.0/0' } },
    { CriticalOptions: { ...inspection.CriticalOptions, 'force-command': '/bin/sh' } },
    { Extensions: {} },
    { Extensions: { ...inspection.Extensions, 'permit-port-forwarding': '' } },
    { Extensions: { 'permit-pty': 'unexpected' } },
    { ValidAfter: accessTime(-51) },
    { ValidBefore: accessTime(251) },
    { ValidBefore: accessTime(249) },
    { ValidBefore: 'forever' },
  ])
    expect(() => inspectCustomerSsh({ ...inspection, ...mutation }, { claim, userCa })).toThrow(
      'incompatible',
    );
});

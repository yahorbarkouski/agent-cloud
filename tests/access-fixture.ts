import { generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  newId,
  type AccessIssuance,
  type AccessSessionRecord,
} from '../packages/contracts/src/index.js';

export function accessPublicKey() {
  const { publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const header = Buffer.from('0000000b7373682d6564323535313900000020', 'hex');
  return `ssh-ed25519 ${Buffer.concat([header, raw]).toString('base64')}`;
}

export function accessP256PublicKey() {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-65);
  const header = Buffer.from(
    '0000001365636473612d736861322d6e69737470323536000000086e6973747032353600000041',
    'hex',
  );
  return `ecdsa-sha2-nistp256 ${Buffer.concat([header, raw]).toString('base64')}`;
}

export const accessTime = (seconds: number) =>
  new Date(Date.UTC(2026, 8, 7, 15, 0, seconds)).toISOString();

export function pendingAccessSession() {
  const allocationId = newId.allocation();
  const key = accessPublicKey();
  return {
    id: newId.accessSession(),
    accountId: newId.account(),
    projectId: newId.project(),
    grantId: newId.grant(),
    machineId: newId.machine(),
    allocationId,
    machineVersion: 2,
    requestKey: randomUUID(),
    fingerprint: 'a'.repeat(64),
    publicKey: key,
    ticketHash: 'b'.repeat(64),
    identityPin: {
      provider: 'simulated',
      serverId: 'server-1',
      primaryIpId: 'ip-1',
      hostAlias: `${allocationId.replace('alloc_', 'alloc-')}.guest.agent-cloud.internal`,
      sshHostCa: key,
      guestHostPublicKey: key,
      imageManifestDigest: 'c'.repeat(64),
    },
    gateway: { id: 'local', origin: 'ws://127.0.0.1:4322', egressCidrs: ['127.0.0.1/32'] },
    admittedAt: accessTime(0),
    issueDeadline: accessTime(90),
    hardDeadline: accessTime(3600),
    issuance: { kind: 'pending' },
    connection: { kind: 'unclaimed' },
  } satisfies AccessSessionRecord;
}

export function issuedAccessSession(session = pendingAccessSession()) {
  const issuance = {
    kind: 'issued',
    certificate: 'Certificate cryptography is verified by the signer, not this shape fixture.',
    issuedAt: new Date(Date.parse(session.admittedAt) + 20_000).toISOString(),
    ticketDeadline: new Date(Date.parse(session.admittedAt) + 80_000).toISOString(),
    certificateExpiresAt: new Date(Date.parse(session.admittedAt) + 320_000).toISOString(),
    target: { ...session.identityPin, address: '127.0.0.1', port: 22 },
  } satisfies AccessIssuance;
  return { ...session, issuance };
}

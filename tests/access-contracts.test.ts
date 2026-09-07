import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  accessGatewaySchema,
  accessSessionRecordSchema,
  accessSessionRequestSchema,
  customerPublicKeySchema,
  newId,
} from '../packages/contracts/src/index.js';
import {
  accessPublicKey as publicKey,
  accessTime as at,
  pendingAccessSession as pending,
  issuedAccessSession as issued,
} from './access-fixture.js';

it('accepts native Ed25519 public keys and rejects altered wire algorithms and lengths', () => {
  const key = publicKey();
  expect(customerPublicKeySchema.parse(key)).toBe(key);
  const wire = Buffer.from(key.slice('ssh-ed25519 '.length), 'base64');
  const highBitAlgorithm = Buffer.from(wire);
  highBitAlgorithm[4] = 0xf3;
  const wrongLength = Buffer.from(wire);
  wrongLength.writeUInt32BE(31, 15);
  for (const malformed of [
    `${key} comment`,
    `command="id" ${key}`,
    `${key}\n`,
    key.replace('ssh-ed25519 ', 'ssh-rsa '),
    `ssh-ed25519 ${highBitAlgorithm.toString('base64')}`,
    `ssh-ed25519 ${wrongLength.toString('base64')}`,
    `ssh-ed25519 ${wire.subarray(1).toString('base64')}`,
  ]) {
    expect(customerPublicKeySchema.safeParse(malformed).success).toBe(false);
  }
  expect(
    accessSessionRequestSchema.safeParse({
      publicKey: key,
      ticketHash: 'a'.repeat(64),
      host: 'other',
    }).success,
  ).toBe(false);
});

it('refuses public SSH sources and gateway origins that carry cleartext or caller data', () => {
  const gateway = pending().gateway;
  expect(accessGatewaySchema.parse(gateway)).toEqual(gateway);
  expect(
    accessGatewaySchema.safeParse({ ...gateway, origin: 'wss://gateway.example' }).success,
  ).toBe(true);
  for (const origin of [
    'ws://gateway.example',
    'wss://secret@gateway.example',
    'wss://gateway.example/path',
    'wss://gateway.example?ticket=secret',
  ]) {
    expect(accessGatewaySchema.safeParse({ ...gateway, origin }).success).toBe(false);
  }
  for (const egressCidrs of [['0.0.0.0/0'], ['::/0'], ['127.0.0.1/32', '127.0.0.1/32'], []]) {
    expect(accessGatewaySchema.safeParse({ ...gateway, egressCidrs }).success).toBe(false);
  }
});

it('bounds issuance, tickets and certificates by the original admission and authority', () => {
  const session = issued();
  expect(accessSessionRecordSchema.safeParse(session).success).toBe(true);
  for (const changed of [
    { ...session, issueDeadline: at(91) },
    { ...session, hardDeadline: at(3601) },
    { ...session, hardDeadline: at(100) },
    { ...session, issuance: { ...session.issuance, ticketDeadline: at(81) } },
    { ...session, issuance: { ...session.issuance, certificateExpiresAt: at(321) } },
    { ...session, issuance: { kind: 'attempted', attemptedAt: at(90) } },
    {
      ...session,
      issuance: {
        ...session.issuance,
        target: { ...session.issuance.target, serverId: 'different' },
      },
    },
    { ...session, allocationId: newId.allocation() },
  ]) {
    expect(accessSessionRecordSchema.safeParse(changed).success).toBe(false);
  }
});

it('requires issued authority at claim and preserves the claim receipt after closure', () => {
  const connection = {
    kind: 'claimed',
    gatewayInstanceId: randomUUID(),
    connectionId: randomUUID(),
    claimedAt: at(30),
  };
  const session = issued();
  expect(accessSessionRecordSchema.safeParse({ ...pending(), connection }).success).toBe(false);
  expect(accessSessionRecordSchema.safeParse({ ...session, connection }).success).toBe(true);
  expect(
    accessSessionRecordSchema.safeParse({
      ...session,
      connection: { ...connection, claimedAt: at(80) },
    }).success,
  ).toBe(false);
  const closed = {
    kind: 'closed',
    closedAt: at(40),
    reason: 'client_closed',
    previous: connection,
  };
  expect(accessSessionRecordSchema.safeParse({ ...session, connection: closed }).success).toBe(
    true,
  );
  expect(
    accessSessionRecordSchema.safeParse({ ...session, connection: { ...closed, closedAt: at(25) } })
      .success,
  ).toBe(false);
  expect(
    accessSessionRecordSchema.safeParse({
      ...session,
      connection: { kind: 'closed', closedAt: at(40), reason: 'client_closed' },
    }).success,
  ).toBe(false);
});

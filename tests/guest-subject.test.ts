import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  guestBootProofSchema,
  guestSubject,
  guestSubjectKey,
  imageBuildIdSchema,
  newId,
  sameGuestSubject,
} from '../packages/contracts/dist/index.js';
import {
  backupPrincipal,
  guestName,
  probePrincipal,
  runtimePrincipal,
  type ProbeCredential,
} from '../packages/pki/dist/index.js';
import { createGuestProbe } from '../packages/remote/dist/index.js';

it('keeps customer names stable and places verifier subjects in a separate namespace', () => {
  const allocation = newId.allocation();
  const build = imageBuildIdSchema.parse(allocation.slice('alloc_'.length));
  const customer = guestSubject({ version: 1, allocationId: allocation });
  const verifier = guestSubject({ version: 2, subject: { kind: 'image_verifier', id: build } });
  expect(guestName(customer)).toBe(`${allocation.replace('_', '-')}.guest.agent-cloud.internal`);
  expect(probePrincipal(customer)).toBe(`probe-${allocation}`);
  expect(runtimePrincipal(customer)).toBe(`runtime-${allocation}`);
  expect(backupPrincipal(customer)).toBe(`backup-${allocation}`);
  expect(guestName(verifier)).toBe(`verify-${build}.guest.agent-cloud.internal`);
  expect(probePrincipal(verifier)).toBe(`probe-verify_${build}`);
  expect(sameGuestSubject(customer, verifier)).toBe(false);
  expect(guestSubjectKey(customer)).not.toBe(guestSubjectKey(verifier));
});

it('rejects evidence that mixes customer and verifier ownership', () => {
  const fields = {
    imageVersion: 'fixture-v1',
    manifestDigest: 'a'.repeat(64),
    sshHostPublicKey: 'ssh-ed25519 AAAA',
    tlsCsr: 'fixture-csr',
  };
  const customer = { version: 1, allocationId: newId.allocation(), ...fields };
  const verifier = {
    version: 2,
    subject: { kind: 'image_verifier', id: imageBuildIdSchema.parse(randomUUID()) },
    ...fields,
  };
  expect(guestBootProofSchema.parse(customer)).toEqual(customer);
  expect(guestBootProofSchema.parse(verifier)).toEqual(verifier);
  expect(() =>
    guestBootProofSchema.parse({ ...verifier, allocationId: customer.allocationId }),
  ).toThrow();
  expect(() => guestBootProofSchema.parse({ ...customer, subject: verifier.subject })).toThrow();
  expect(() =>
    guestBootProofSchema.parse({
      ...verifier,
      subject: { kind: 'allocation', id: customer.allocationId },
    }),
  ).toThrow();
});

it('refuses a verifier credential on a customer target before opening SSH', async () => {
  const probe = createGuestProbe({ sshBinary: '/must-not-execute' });
  const subject = guestSubject({ version: 1, allocationId: newId.allocation() });
  const credential: ProbeCredential = {
    kind: 'probe',
    subject: { kind: 'image_verifier', id: imageBuildIdSchema.parse(randomUUID()) },
    privateKey: 'unused',
    certificate: 'unused',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  await expect(
    probe.readIdentity({
      subject,
      credential,
      address: '127.0.0.1',
      trust: { kind: 'pinned_key', publicKey: 'ssh-ed25519 AAAA' },
    }),
  ).rejects.toThrow('another guest subject');
  await expect(
    probe.readRuntime({
      subject,
      credential: { ...credential, kind: 'runtime' },
      address: '127.0.0.1',
      trust: { kind: 'host_ca', publicKey: 'ssh-ed25519 AAAA' },
    }),
  ).rejects.toThrow('another guest subject');
});

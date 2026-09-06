import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  allocations,
  operations,
  guestBootstraps,
  guestIdentities,
  guestSigningAttempts,
  providerResources,
  auditEvents,
} from '../packages/db/src/index.js';
import {
  operationResponseSchema,
  operationProgressSchema,
  guestImageSchema,
  guestEnrollmentInputSchema,
  guestProofSchema,
  simulatedCatalog,
  CloudError,
  newId,
} from '../packages/contracts/dist/index.js';
import type { Signer } from '../packages/pki/dist/index.js';
import { createApp } from '../apps/control/src/app.js';
import { SimulatedProvider } from '../apps/control/src/simulated-provider.js';
import { advanceOperation } from '../apps/control/src/advance-operation.js';
import { BootstrapSeal } from '../apps/control/src/bootstrap-seal.js';
import {
  prepareGuestBootstrap,
  recoverGuestBootstrap,
} from '../apps/control/src/guest-bootstrap.js';
import { createEnrollmentService } from '../apps/control/src/guest-enrollment.js';
import { seedAccount, testDatabase } from './database.js';

let fixture: Awaited<ReturnType<typeof testDatabase>>;
const limits = { currency: 'EUR', maxMachines: 100, maxHourlyMicros: 1_000_000 };
const image = guestImageSchema.parse({
  providerImage: 'fixture',
  architecture: 'x86',
  version: 'fixture-v1',
  manifestDigest: 'a'.repeat(64),
  sshUserCa: 'ssh-ed25519 AAAA',
  sshHostCa: 'ssh-ed25519 BBBB',
  tlsRoot: 'fixture-root',
});
beforeAll(async () => {
  fixture = await testDatabase();
});
afterAll(async () => {
  await fixture.close();
});
beforeEach(async () => {
  await fixture.reset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function admittedGuest() {
  const account = await seedAccount(fixture.connection.db);
  const provider = new SimulatedProvider({ db: fixture.connection.db });
  const admission = createApp({
    db: fixture.connection.db,
    provider: 'simulated',
    catalog: simulatedCatalog,
    limits,
  });
  const response = await admission.request(`/v1/projects/${account.projectId}/machines`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${account.token}`,
      'Idempotency-Key': randomUUID(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'enrollment', size: 'small', region: 'nbg1' }),
  });
  expect(response.status).toBe(202);
  const { operation } = operationResponseSchema.parse(await response.json());
  const [allocation] = await fixture.connection.db
    .select()
    .from(allocations)
    .where(eq(allocations.machineId, operation.machineId));
  if (!allocation) throw new Error('Expected allocation.');
  const seal = new BootstrapSeal(randomBytes(32).toString('base64'));
  const reference = await fixture.connection.db.transaction((tx) =>
    prepareGuestBootstrap(tx, {
      allocation,
      operation,
      image,
      seal,
      enrollmentUrl: 'https://enrollment.example.test/guest/enroll',
    }),
  );
  const recovered = await recoverGuestBootstrap(fixture.connection.db, { reference, seal });
  for (let tick = 0; tick < 10; tick++) {
    await advanceOperation({
      connection: fixture.connection,
      operationId: operation.id,
      provider,
      limits,
    });
    const [row] = await fixture.connection.db
      .select()
      .from(operations)
      .where(eq(operations.id, operation.id));
    if (operationProgressSchema.parse(row?.progress).kind === 'succeeded') break;
  }
  const [confirmed] = await fixture.connection.db
    .select()
    .from(allocations)
    .where(eq(allocations.id, allocation.id));
  if (!confirmed?.serverId) throw new Error('Expected confirmed provider server.');
  // The simulator stops at provider completion; this suite exercises the subsequent live phase.
  await fixture.connection.db
    .update(operations)
    .set({ progress: { kind: 'waiting_guest', serverId: confirmed.serverId, stage: 'enrollment' } })
    .where(eq(operations.id, operation.id));
  const proposal = guestEnrollmentInputSchema.parse({
    bootstrap: reference,
    token: recovered.token,
    sshHostPublicKey: 'ssh-ed25519 CCCC',
    tlsCsr: 'fixture-csr',
    imageVersion: image.version,
  });
  const proof = guestProofSchema.parse({
    version: 1,
    allocationId: reference.allocationId,
    sshHostPublicKey: proposal.sshHostPublicKey,
    tlsCsr: proposal.tlsCsr,
    imageVersion: image.version,
    manifestDigest: image.manifestDigest,
  });
  const signer = {
    trust: { tlsRoot: image.tlsRoot, sshHostCa: image.sshHostCa, sshUserCa: image.sshUserCa },
    validateTlsRequest: vi.fn<Signer['validateTlsRequest']>().mockResolvedValue(),
    issueProbeCredential: vi
      .fn<Signer['issueProbeCredential']>()
      .mockImplementation((allocationId) =>
        Promise.resolve({
          allocationId,
          certificate: 'fixture-probe',
          privateKey: 'fixture-private-key',
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        }),
      ),
    signHost: vi.fn<Signer['signHost']>().mockResolvedValue('fixture-host-cert'),
    signTls: vi.fn<Signer['signTls']>().mockResolvedValue('fixture-tls-cert'),
  } satisfies Signer;
  const probe = { readIdentity: vi.fn().mockResolvedValue(proof) };
  const ports = { connection: fixture.connection, provider, seal, signer, probe };
  const service = createEnrollmentService(ports);
  const app = createApp({
    db: fixture.connection.db,
    provider: 'simulated',
    catalog: simulatedCatalog,
    limits,
    enrollment: service,
  });
  const request = (body: unknown = proposal) =>
    app.request('/guest/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return {
    account,
    provider,
    operation,
    allocation,
    seal,
    reference,
    proposal,
    proof,
    signer,
    probe,
    service,
    ports,
    request,
  };
}

it('enrolls from owned provider addresses and replays persisted certificates without signing again', async () => {
  const guest = await admittedGuest();
  const first = await guest.request();
  expect(first.status).toBe(200);
  expect(
    (
      await fixture.connection.db
        .select()
        .from(operations)
        .where(eq(operations.id, guest.operation.id))
    )[0]?.progress,
  ).toMatchObject({ kind: 'waiting_guest', stage: 'runtime' });
  const issued: unknown = await first.json();
  const second = await guest.request();
  expect(second.status).toBe(200);
  expect(await second.json()).toEqual(issued);
  expect(
    await fixture.connection.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.event, 'guest.enrolled')),
  ).toHaveLength(1);
  expect(guest.signer.signHost).toHaveBeenCalledTimes(1);
  expect(guest.signer.signTls).toHaveBeenCalledTimes(1);
  expect(guest.probe.readIdentity).toHaveBeenCalledTimes(1);
  const [stored] = await fixture.connection.db.select().from(guestBootstraps);
  expect(stored?.sealedToken).toBeNull();
  expect(JSON.stringify(issued)).not.toContain(guest.proposal.token);
  const attempts = await fixture.connection.db.select().from(guestSigningAttempts);
  expect(attempts.map((attempt) => attempt.purpose).sort()).toEqual(['identity', 'probe']);
  await expect(fixture.connection.db.delete(guestSigningAttempts)).rejects.toThrow();
  await expect(
    fixture.connection.db.update(guestSigningAttempts).set({ sequence: 1 }),
  ).rejects.toThrow();
});

it('repairs an issued replay handoff without reopening blocked or completed operations', async () => {
  const guest = await admittedGuest();
  const issued = await guest.service.enroll(guest.proposal);
  const [allocation] = await fixture.connection.db
    .select()
    .from(allocations)
    .where(eq(allocations.id, guest.reference.allocationId));
  if (!allocation?.serverId) throw new Error('Expected provider VM.');
  await fixture.connection.db
    .update(operations)
    .set({
      progress: { kind: 'waiting_guest', serverId: allocation.serverId, stage: 'enrollment' },
    })
    .where(eq(operations.id, guest.operation.id));
  expect(await guest.service.enroll(guest.proposal)).toEqual(issued);
  expect(
    (
      await fixture.connection.db
        .select()
        .from(operations)
        .where(eq(operations.id, guest.operation.id))
    )[0]?.progress,
  ).toMatchObject({ kind: 'waiting_guest', stage: 'runtime' });
  for (const progress of [
    { kind: 'blocked', reason: 'provider_resource_mismatch' },
    { kind: 'succeeded', completedAt: new Date().toISOString() },
  ]) {
    await fixture.connection.db
      .update(operations)
      .set({ progress })
      .where(eq(operations.id, guest.operation.id));
    expect(await guest.service.enroll(guest.proposal)).toEqual(issued);
    expect(
      (
        await fixture.connection.db
          .select()
          .from(operations)
          .where(eq(operations.id, guest.operation.id))
      )[0]?.progress,
    ).toEqual(progress);
  }
  expect(guest.signer.signHost).toHaveBeenCalledTimes(1);
});

it('rejects wrong credentials, foreign allocation references, extra fields and invalid CSRs before claiming keys', async () => {
  const guest = await admittedGuest();
  expect(
    (await guest.request({ ...guest.proposal, token: randomBytes(32).toString('base64url') }))
      .status,
  ).toBe(401);
  expect(
    (
      await guest.request({
        ...guest.proposal,
        bootstrap: { version: 1, allocationId: newId.allocation() },
      })
    ).status,
  ).toBe(401);
  expect((await guest.request({ ...guest.proposal, address: '127.0.0.1' })).status).toBe(400);
  guest.signer.validateTlsRequest.mockRejectedValueOnce(
    new CloudError('invalid_input', 'Invalid CSR.'),
  );
  expect((await guest.request()).status).toBe(400);
  expect(guest.signer.issueProbeCredential).not.toHaveBeenCalled();
  expect(await fixture.connection.db.select().from(guestIdentities)).toHaveLength(0);
  expect((await guest.request()).status).toBe(200);
  expect(
    (await guest.request({ ...guest.proposal, sshHostPublicKey: 'ssh-ed25519 DDDD' })).status,
  ).toBe(403);
});

it('rejects foreign provider ownership and mismatched SSH image or TLS evidence before host signing', async () => {
  const guest = await admittedGuest();
  const original = guest.provider.getServer.bind(guest.provider);
  const serverRead = vi.spyOn(guest.provider, 'getServer').mockImplementationOnce(async (input) => {
    const server = await original(input);
    return server
      ? { ...server, labels: { ...server.labels, allocation_id: newId.allocation() } }
      : null;
  });
  expect((await guest.request()).status).toBe(503);
  expect(guest.signer.issueProbeCredential).not.toHaveBeenCalled();
  serverRead.mockRestore();
  for (const mismatch of [
    { tlsCsr: 'wrong-csr' },
    { manifestDigest: 'b'.repeat(64) },
    { imageVersion: 'other-image' },
    { sshHostPublicKey: 'ssh-ed25519 DDDD' },
  ]) {
    guest.probe.readIdentity.mockResolvedValueOnce({ ...guest.proof, ...mismatch });
    expect((await guest.request()).status).toBe(403);
  }
  expect(guest.signer.issueProbeCredential).toHaveBeenCalledTimes(1);
  expect(guest.signer.signHost).not.toHaveBeenCalled();
  expect(await fixture.connection.db.select().from(guestIdentities)).toHaveLength(0);
});

it('does not enroll a lifecycle-blocked or unconfirmed create even with valid owned resource records', async () => {
  const guest = await admittedGuest();
  for (const progress of [
    { kind: 'blocked', reason: 'duplicate_provider_resources' },
    { kind: 'blocked', reason: 'provider_outcome_unknown' },
    { kind: 'queued' },
    { kind: 'succeeded', completedAt: new Date().toISOString() },
  ]) {
    await fixture.connection.db
      .update(operations)
      .set({ progress })
      .where(eq(operations.id, guest.operation.id));
    expect((await guest.request()).status).toBe(503);
  }
  expect(guest.signer.issueProbeCredential).not.toHaveBeenCalled();
  expect(guest.signer.signHost).not.toHaveBeenCalled();
});

it('derives ownership from the bootstrap rather than trusting incomplete stored label maps', async () => {
  const guest = await admittedGuest();
  await fixture.connection.db
    .update(providerResources)
    .set({ labels: {} })
    .where(eq(providerResources.allocationId, guest.reference.allocationId));
  expect((await guest.request()).status).toBe(503);
  await fixture.connection.db
    .update(providerResources)
    .set({ labels: { managed_by: 'agent-cloud', allocation_id: guest.reference.allocationId } })
    .where(eq(providerResources.allocationId, guest.reference.allocationId));
  expect((await guest.request()).status).toBe(503);
  expect(guest.signer.issueProbeCredential).not.toHaveBeenCalled();
});

it('serializes concurrent enrollment and retains one key claim when TLS issuance fails', async () => {
  const guest = await admittedGuest();
  const started = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<typeof guest.proof>();
  guest.probe.readIdentity.mockImplementationOnce(() => {
    started.resolve(undefined);
    return release.promise;
  });
  const first = guest.request();
  await started.promise;
  expect((await guest.request()).status).toBe(409);
  guest.signer.signTls.mockRejectedValueOnce(
    new CloudError('provider_unavailable', 'CA unavailable.', true),
  );
  release.resolve(guest.proof);
  expect((await first).status).toBe(503);
  expect((await fixture.connection.db.select().from(guestIdentities))[0]?.identity).toMatchObject({
    kind: 'claimed',
  });
  expect(
    (await fixture.connection.db.select().from(guestBootstraps))[0]?.sealedToken,
  ).not.toBeNull();
  expect((await guest.request({ ...guest.proposal, tlsCsr: 'replacement-csr' })).status).toBe(403);
  expect((await guest.request()).status).toBe(409);
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + 31_000);
  expect((await guest.request()).status).toBe(200);
  expect(guest.signer.issueProbeCredential).toHaveBeenCalledTimes(1);
  expect(guest.signer.signHost).toHaveBeenCalledTimes(2);
});

it('persists signing budgets across process restarts and never erases failed issuance history', async () => {
  const guest = await admittedGuest();
  guest.signer.issueProbeCredential.mockRejectedValue(
    new CloudError('provider_unavailable', 'CA response lost.', true),
  );
  const now = Date.now();
  const time = vi.spyOn(Date, 'now');
  for (let count = 0; count < 12; count++) {
    time.mockReturnValue(now + 31_000 * count);
    await expect(createEnrollmentService(guest.ports).enroll(guest.proposal)).rejects.toThrow(
      'CA response lost',
    );
  }
  time.mockReturnValue(now + 31_000 * 13);
  await expect(createEnrollmentService(guest.ports).enroll(guest.proposal)).rejects.toThrow(
    'attempt limit',
  );
  expect(guest.signer.issueProbeCredential).toHaveBeenCalledTimes(12);
  expect(await fixture.connection.db.select().from(guestSigningAttempts)).toHaveLength(12);
  await expect(
    fixture.connection.db.insert(guestSigningAttempts).values({
      accountId: guest.account.principal.accountId,
      allocationId: guest.reference.allocationId,
      purpose: 'probe',
      sequence: 13,
    }),
  ).rejects.toThrow();
});

it('does not persist issued identity if the bootstrap expires during signing and rejects retired allocation replay', async () => {
  const guest = await admittedGuest();
  const [bootstrap] = await fixture.connection.db.select().from(guestBootstraps);
  if (!bootstrap) throw new Error('Expected bootstrap.');
  guest.signer.signTls.mockImplementationOnce(() => {
    vi.spyOn(Date, 'now').mockReturnValue(bootstrap.expiresAt.getTime());
    return Promise.resolve('fixture-tls-cert');
  });
  expect((await guest.request()).status).toBe(401);
  expect((await fixture.connection.db.select().from(guestIdentities))[0]?.identity).toMatchObject({
    kind: 'claimed',
  });
  expect(
    (await fixture.connection.db.select().from(guestBootstraps))[0]?.sealedToken,
  ).not.toBeNull();
  vi.restoreAllMocks();
  await fixture.connection.db
    .update(allocations)
    .set({ retiredAt: new Date() })
    .where(
      and(
        eq(allocations.accountId, guest.account.principal.accountId),
        eq(allocations.id, guest.reference.allocationId),
      ),
    );
  expect((await guest.request()).status).toBe(401);
});

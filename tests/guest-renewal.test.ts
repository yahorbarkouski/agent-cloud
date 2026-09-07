import { execFile } from 'node:child_process';
import type { createPrivateKey } from 'node:crypto';
import { createPublicKey, generateKeyPairSync, randomUUID, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  guestImageSchema,
  guestProofSchema,
  issuedGuestIdentitySchema,
  newId,
  type GuestRenewalInput,
} from '../packages/contracts/src/index.js';
import {
  allocations,
  databaseTime,
  guestBootstraps,
  guestCertificateRenewals,
  guestIdentities,
  withMachineLock,
} from '../packages/db/src/index.js';
import { signGuestRenewal, verifyGuestRenewal, type Signer } from '../packages/pki/src/index.js';
import type { createGuestProbe } from '../packages/remote/src/index.js';
import { createApp } from '../apps/control/src/app.js';
import { createGuestRenewalService } from '../apps/control/src/guest-renewal.js';
import { prepareEnrollmentFixture } from '../scripts/support/enrollment-fixture.js';
import { testDatabase } from './database.js';

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let privateKey: ReturnType<typeof createPrivateKey>;
let certificate: string;
const image = guestImageSchema.parse({
  providerImage: 'fixture',
  architecture: 'x86',
  version: 'renewal-v1',
  manifestDigest: 'a'.repeat(64),
  sshUserCa: 'ssh-ed25519 AAAA',
  sshHostCa: 'ssh-ed25519 BBBB',
  tlsRoot: 'fixture-root',
});
beforeAll(async () => {
  fixture = await testDatabase();
  const dir = await mkdtemp(join(tmpdir(), 'agent-cloud-renewal-test-'));
  try {
    privateKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    await writeFile(join(dir, 'key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), {
      mode: 0o600,
    });
    await promisify(execFile)('/usr/bin/openssl', [
      'req',
      '-new',
      '-x509',
      '-key',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
      '-subj',
      '/CN=renewal-fixture',
      '-days',
      '1',
    ]);
    certificate = await readFile(join(dir, 'cert.pem'), 'utf8');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
afterAll(async () => {
  await fixture.close();
});
beforeEach(async () => {
  await fixture.reset();
});

async function enrolled() {
  const prepared = await prepareEnrollmentFixture({
    connection: fixture.connection,
    image,
    address: '127.0.0.1',
    enrollmentUrl: 'https://enrollment.example.test/guest/enroll',
  });
  const { spec } = prepared.bootstrap;
  const proof = guestProofSchema.parse({
    version: 1,
    allocationId: spec.allocationId,
    imageVersion: spec.image.version,
    manifestDigest: spec.image.manifestDigest,
    sshHostPublicKey: 'ssh-ed25519 CCCC',
    tlsCsr: 'fixture-csr',
  });
  const original = issuedGuestIdentitySchema.parse({
    kind: 'issued',
    sshHostPublicKey: proof.sshHostPublicKey,
    tlsCsr: proof.tlsCsr,
    imageVersion: proof.imageVersion,
    sshHostCertificate: 'original-host',
    tlsCertificate: certificate,
    issuedAt: new Date(
      (await databaseTime(fixture.connection.db)).getTime() - 7_200_000,
    ).toISOString(),
  });
  await fixture.connection.db.insert(guestIdentities).values({
    accountId: spec.accountId,
    allocationId: spec.allocationId,
    identity: {
      kind: 'claimed',
      sshHostPublicKey: proof.sshHostPublicKey,
      tlsCsr: proof.tlsCsr,
      imageVersion: proof.imageVersion,
    },
  });
  await fixture.connection.db
    .update(guestIdentities)
    .set({ identity: original })
    .where(eq(guestIdentities.allocationId, spec.allocationId));
  await fixture.connection.db
    .update(guestBootstraps)
    .set({ sealedToken: null, consumedAt: sql`now()` })
    .where(eq(guestBootstraps.allocationId, spec.allocationId));
  const signer = {
    trust: { tlsRoot: image.tlsRoot, sshHostCa: image.sshHostCa, sshUserCa: image.sshUserCa },
    issueProbeCredential: vi.fn<Signer['issueProbeCredential']>().mockImplementation((subject) =>
      Promise.resolve({
        kind: 'probe',
        subject,
        certificate: 'probe',
        privateKey: 'fixture',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      }),
    ),
    signHost: vi.fn<Signer['signHost']>().mockResolvedValue('renewed-host'),
    signTls: vi.fn<Signer['signTls']>().mockResolvedValue(certificate),
  };
  const probe = {
    readIdentity: vi
      .fn<ReturnType<typeof createGuestProbe>['readIdentity']>()
      .mockResolvedValue(proof),
  };
  const ports = { connection: fixture.connection, provider: prepared.provider, signer, probe };
  const service = createGuestRenewalService(ports);
  const request = async (change: Partial<GuestRenewalInput> = {}) => ({
    ...signGuestRenewal({
      allocationId: spec.allocationId,
      requestedAt: (await databaseTime(fixture.connection.db)).toISOString(),
      key: privateKey,
    }),
    ...change,
  });
  return { ...prepared, spec, original, proof, signer, probe, ports, service, request };
}

it('binds signed requests to purpose, allocation, key and database-time freshness', async () => {
  const value = await enrolled();
  const request = await value.request();
  const now = await databaseTime(fixture.connection.db);
  const key = new X509Certificate(certificate).publicKey;
  expect(() => {
    verifyGuestRenewal({ request, key, now });
  }).not.toThrow();
  for (const changed of [
    { ...request, allocationId: newId.allocation() },
    { ...request, requestedAt: new Date(now.getTime() + 1000).toISOString() },
    { ...request, signature: 'A'.repeat(86) },
  ])
    expect(() => {
      verifyGuestRenewal({ request: changed, key, now });
    }).toThrow();
  for (const skew of [-31_000, 300_001])
    expect(() => {
      verifyGuestRenewal({ request, key, now: new Date(now.getTime() + skew) });
    }).toThrow();
  expect(() => {
    verifyGuestRenewal({
      request,
      now,
      key: createPublicKey(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey),
    });
  }).toThrow();
});

it('renews after bootstrap erasure and reuses the persisted response across process restart', async () => {
  const value = await enrolled();
  const result = await value.service.renew(await value.request());
  expect(result.sshHostCertificate).toBe('renewed-host');
  expect(result.tlsCsr).toBe(value.original.tlsCsr);
  expect(value.probe.readIdentity.mock.calls[0]?.[0].trust).toEqual({
    kind: 'pinned_key',
    publicKey: value.original.sshHostPublicKey,
  });
  const restarted = createGuestRenewalService(value.ports);
  expect(await restarted.renew(await value.request())).toEqual(result);
  expect(value.signer.signHost).toHaveBeenCalledTimes(1);
  expect(await fixture.connection.db.select().from(guestCertificateRenewals)).toHaveLength(1);
});

it('rejects wrong signatures and retired ownership before signing', async () => {
  const value = await enrolled();
  await expect(
    value.service.renew(await value.request({ signature: 'A'.repeat(86) })),
  ).rejects.toMatchObject({ failure: { code: 'unauthenticated' } });
  await fixture.connection.db
    .update(allocations)
    .set({ retiredAt: sql`now()` })
    .where(eq(allocations.id, value.spec.allocationId));
  await expect(value.service.renew(await value.request())).rejects.toMatchObject({
    failure: { code: 'unauthenticated' },
  });
  expect(value.signer.issueProbeCredential).not.toHaveBeenCalled();
});

it('rejects changed current provider ownership without consuming a signing slot', async () => {
  const value = await enrolled();
  const provider = {
    ...value.ports.provider,
    getServer: async (input: Parameters<typeof value.ports.provider.getServer>[0]) => {
      const server = await value.ports.provider.getServer(input);
      return server && { ...server, labels: {} };
    },
  };
  await expect(
    createGuestRenewalService({ ...value.ports, provider }).renew(await value.request()),
  ).rejects.toMatchObject({ failure: { code: 'provider_unavailable' } });
  expect(await fixture.connection.db.select().from(guestCertificateRenewals)).toHaveLength(0);
});

it('preserves a signing slot after lost probe response and enforces cooldown across restart', async () => {
  const value = await enrolled();
  value.probe.readIdentity.mockRejectedValue(new Error('lost response'));
  await expect(value.service.renew(await value.request())).rejects.toThrow('lost response');
  await expect(
    createGuestRenewalService(value.ports).renew(await value.request()),
  ).rejects.toMatchObject({ failure: { code: 'resource_busy' } });
  expect(value.signer.issueProbeCredential).toHaveBeenCalledTimes(1);
  expect(value.signer.signHost).not.toHaveBeenCalled();
});

it('refuses a mismatched SSH proof and retirement during signing', async () => {
  const value = await enrolled();
  value.probe.readIdentity.mockResolvedValue({ ...value.proof, tlsCsr: 'different' });
  await expect(value.service.renew(await value.request())).rejects.toMatchObject({
    failure: { code: 'permission_denied' },
  });
  expect(value.signer.signHost).not.toHaveBeenCalled();
  await fixture.reset();
  const retired = await enrolled();
  retired.signer.signTls.mockImplementation(async () => {
    await fixture.connection.db
      .update(allocations)
      .set({ retiredAt: sql`now()` })
      .where(eq(allocations.id, retired.spec.allocationId));
    return certificate;
  });
  await expect(retired.service.renew(await retired.request())).rejects.toMatchObject({
    failure: { code: 'unauthenticated' },
  });
  const attempts = await fixture.connection.db.select().from(guestCertificateRenewals);
  expect(attempts).toHaveLength(1);
  expect(attempts[0]?.identity).toBeNull();
});

it('serializes renewal with machine operations', async () => {
  const value = await enrolled();
  await withMachineLock({
    pool: fixture.connection.pool,
    machineId: value.spec.machineId,
    work: async () => {
      await expect(value.service.renew(await value.request())).rejects.toMatchObject({
        failure: { code: 'resource_busy' },
      });
    },
  });
  expect(value.signer.issueProbeCredential).not.toHaveBeenCalled();
});

it('keeps renewal history immutable and enforces identity and budget guards in SQL', async () => {
  const value = await enrolled();
  await value.service.renew(await value.request());
  await expect(fixture.connection.db.delete(guestCertificateRenewals)).rejects.toThrow();
  await expect(
    fixture.connection.db.update(guestCertificateRenewals).set({ identity: value.original }),
  ).rejects.toThrow();
  await expect(
    fixture.connection.db.insert(guestCertificateRenewals).values({
      id: randomUUID(),
      accountId: value.spec.accountId,
      allocationId: value.spec.allocationId,
    }),
  ).rejects.toThrow();
});

it('exposes renewal only when configured and returns typed HTTP errors', async () => {
  const value = await enrolled();
  const config = {
    db: fixture.connection.db,
    provider: value.provider.kind,
    catalog: value.catalog,
    limits: value.limits,
  };
  const request = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(await value.request()),
  };
  expect((await createApp(config).request('/guest/renew', request)).status).toBe(404);
  const app = createApp({ ...config, renewal: value.service });
  expect((await app.request('/guest/renew', request)).status).toBe(200);
  expect(
    (
      await app.request('/guest/renew', {
        ...request,
        body: JSON.stringify(await value.request({ signature: 'A'.repeat(86) })),
      })
    ).status,
  ).toBe(401);
});

it('uses the registered public key after certificate expiry at the authorization clock', async () => {
  const value = await enrolled();
  const registered = new X509Certificate(certificate);
  const now = new Date(registered.validToDate.getTime() + 1_000);
  const request = signGuestRenewal({
    allocationId: value.spec.allocationId,
    requestedAt: now.toISOString(),
    key: privateKey,
  });
  expect(registered.validToDate.getTime()).toBeLessThan(now.getTime());
  expect(() => {
    verifyGuestRenewal({ request, key: registered.publicKey, now });
  }).not.toThrow();
});

it('caps fresh signing across four unknown outcomes in the rolling hour', async () => {
  const value = await enrolled();
  // Historical crash records belong only to this test-owned database. Restore the real guard before testing admission.
  await fixture.connection.db.transaction(async (tx) => {
    await tx.execute(
      'ALTER TABLE guest_certificate_renewals DISABLE TRIGGER guest_certificate_renewal_guard',
    );
    for (let sequence = 1; sequence <= 4; sequence++)
      await tx.insert(guestCertificateRenewals).values({
        id: randomUUID(),
        accountId: value.spec.accountId,
        allocationId: value.spec.allocationId,
        createdAt: sql`now()-(${sequence} * interval '1 minute')`,
      });
    await tx.execute(
      'ALTER TABLE guest_certificate_renewals ENABLE TRIGGER guest_certificate_renewal_guard',
    );
  });
  await expect(value.service.renew(await value.request())).rejects.toMatchObject({
    failure: { code: 'quota_exceeded' },
  });
  expect(value.signer.issueProbeCredential).not.toHaveBeenCalled();
  await expect(
    fixture.connection.db.insert(guestCertificateRenewals).values({
      id: randomUUID(),
      accountId: value.spec.accountId,
      allocationId: value.spec.allocationId,
    }),
  ).rejects.toThrow();
});

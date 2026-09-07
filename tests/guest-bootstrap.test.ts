import * as databaseClock from '../packages/db/dist/index.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  operationResponseSchema,
  guestImageSchema,
  guestIdentitySchema,
  simulatedCatalog,
} from '../packages/contracts/dist/index.js';
import { allocations, guestBootstraps, guestIdentities } from '../packages/db/src/index.js';
import { createApp } from '../apps/control/src/app.js';
import { BootstrapSeal } from '../apps/control/src/bootstrap-seal.js';
import {
  prepareGuestBootstrap,
  recoverGuestBootstrap,
} from '../apps/control/src/guest-bootstrap.js';
import { seedAccount, testDatabase } from './database.js';

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let account: Awaited<ReturnType<typeof seedAccount>>;
let app: ReturnType<typeof createApp>;
let seal: BootstrapSeal;
const image = guestImageSchema.parse({
  providerImage: 'test-image',
  architecture: 'x86',
  version: 'test-v1',
  manifestDigest: 'a'.repeat(64),
  sshUserCa: 'ssh-ed25519 AAAA',
  sshHostCa: 'ssh-ed25519 BBBB',
  tlsRoot: 'test-root',
});
beforeAll(async () => {
  fixture = await testDatabase();
});
afterAll(async () => {
  await fixture.close();
});
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(async () => {
  await fixture.reset();
  account = await seedAccount(fixture.connection.db);
  seal = new BootstrapSeal(randomBytes(32).toString('base64'));
  app = createApp({
    db: fixture.connection.db,
    provider: 'simulated',
    catalog: simulatedCatalog,
    limits: { currency: 'EUR', maxMachines: 100, maxHourlyMicros: 1_000_000 },
  });
});
async function preparation() {
  const response = await app.request(`/v1/projects/${account.projectId}/machines`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${account.token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify({ name: `guest-${randomUUID()}`, size: 'small', region: 'nbg1' }),
  });
  expect(response.status).toBe(202);
  const { operation } = operationResponseSchema.parse(await response.json());
  const [allocation] = await fixture.connection.db
    .select()
    .from(allocations)
    .where(eq(allocations.machineId, operation.machineId));
  if (!allocation) throw new Error('Expected admitted allocation.');
  return {
    operation,
    allocation,
    image,
    seal,
    enrollmentUrl: 'https://enrollment.example.test/guest/enroll',
  };
}

it('binds sealed tokens to their allocation metadata and rejects modified data or another sealing key', () => {
  const issued = seal.issue('allocation-one');
  const token = seal.recover(issued.sealed, 'allocation-one');
  expect(seal.matches(token, issued.hash)).toBe(true);
  expect(JSON.stringify(issued)).not.toContain(token);
  expect(() => seal.recover(issued.sealed, 'allocation-two')).toThrow('authenticated');
  expect(() =>
    new BootstrapSeal(randomBytes(32).toString('base64')).recover(issued.sealed, 'allocation-one'),
  ).toThrow('authenticated');
  expect(() =>
    seal.recover({ ...issued.sealed, tag: Buffer.alloc(16).toString('base64') }, 'allocation-one'),
  ).toThrow('authenticated');
  expect(seal.matches(randomBytes(32).toString('base64url'), issued.hash)).toBe(false);
  expect(seal.matches(token, 'invalid hash')).toBe(false);
});

it('concurrent preparation keeps one encrypted token and pins the original image and endpoint', async () => {
  const input = await preparation();
  const references = await Promise.all(
    Array.from({ length: 6 }, () =>
      fixture.connection.db.transaction((tx) => prepareGuestBootstrap(tx, input)),
    ),
  );
  expect(new Set(references.map((ref) => ref.allocationId)).size).toBe(1);
  const reference = references[0];
  if (!reference) throw new Error('Expected bootstrap reference.');
  const recovered = await recoverGuestBootstrap(fixture.connection.db, { reference, seal });
  await fixture.connection.db.transaction((tx) =>
    prepareGuestBootstrap(tx, {
      ...input,
      image: { ...image, version: 'other-image' },
      enrollmentUrl: 'https://elsewhere.example.test/enroll',
    }),
  );
  expect(await recoverGuestBootstrap(fixture.connection.db, { reference, seal })).toEqual(
    recovered,
  );
  const rows = await fixture.connection.db.select().from(guestBootstraps);
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toContain(recovered.token);
  expect(JSON.stringify(reference)).not.toContain(recovered.token);
});

it('rejects incompatible images, plaintext enrollment URLs, changed expiry and cross-tenant ownership', async () => {
  const input = await preparation();
  await expect(
    fixture.connection.db.transaction((tx) =>
      prepareGuestBootstrap(tx, { ...input, image: { ...image, architecture: 'arm' } }),
    ),
  ).rejects.toThrow('architecture');
  await expect(
    fixture.connection.db.transaction((tx) =>
      prepareGuestBootstrap(tx, { ...input, enrollmentUrl: 'http://example.test/enroll' }),
    ),
  ).rejects.toThrow('HTTPS');
  const reference = await fixture.connection.db.transaction((tx) =>
    prepareGuestBootstrap(tx, input),
  );
  const foreign = await seedAccount(fixture.connection.db);
  await expect(
    fixture.connection.db.update(guestBootstraps).set({ accountId: foreign.principal.accountId }),
  ).rejects.toThrow();
  await expect(
    fixture.connection.db.update(guestBootstraps).set({ expiresAt: new Date(Date.now() + 60_000) }),
  ).rejects.toThrow();
  await expect(
    fixture.connection.db
      .update(guestBootstraps)
      .set({ consumedAt: new Date(), sealedToken: null }),
  ).rejects.toThrow();
  await fixture.connection.db
    .update(allocations)
    .set({ retiredAt: new Date() })
    .where(eq(allocations.id, reference.allocationId));
  await expect(recoverGuestBootstrap(fixture.connection.db, { reference, seal })).rejects.toThrow(
    'absent',
  );
});

it('claims keys once and erases recoverable bootstrap material only after certificates are persisted', async () => {
  const input = await preparation();
  const reference = await fixture.connection.db.transaction((tx) =>
    prepareGuestBootstrap(tx, input),
  );
  const claimed = {
    kind: 'claimed',
    sshHostPublicKey: 'ssh-ed25519 AAAA',
    tlsCsr: 'test-csr',
    imageVersion: image.version,
  };
  await fixture.connection.db.insert(guestIdentities).values({
    accountId: input.operation.accountId,
    allocationId: reference.allocationId,
    identity: claimed,
  });
  await expect(
    fixture.connection.db
      .update(guestIdentities)
      .set({ identity: { ...claimed, sshHostPublicKey: 'ssh-ed25519 BBBB' } }),
  ).rejects.toThrow();
  await expect(
    fixture.connection.db.update(guestIdentities).set({
      identity: {
        sshHostPublicKey: claimed.sshHostPublicKey,
        tlsCsr: claimed.tlsCsr,
        imageVersion: claimed.imageVersion,
      },
    }),
  ).rejects.toThrow();
  const issued = {
    ...claimed,
    kind: 'issued',
    sshHostCertificate: 'test-host-cert',
    tlsCertificate: 'test-tls-cert',
    issuedAt: new Date().toISOString(),
  };
  for (const field of ['sshHostCertificate', 'tlsCertificate', 'issuedAt']) {
    for (const value of ['', '   ', null, 42]) {
      const invalid = { ...issued, [field]: value };
      expect(guestIdentitySchema.safeParse(invalid).success).toBe(false);
      await expect(
        fixture.connection.db.transaction(async (tx) => {
          await tx.update(guestIdentities).set({ identity: invalid });
          await tx.update(guestBootstraps).set({ consumedAt: new Date(), sealedToken: null });
        }),
      ).rejects.toThrow();
      await expect(
        recoverGuestBootstrap(fixture.connection.db, { reference, seal }),
      ).resolves.toHaveProperty('token');
    }
  }
  await expect(
    fixture.connection.db
      .update(guestIdentities)
      .set({ identity: { ...issued, issuedAt: 'not-a-date' } }),
  ).rejects.toThrow();
  await fixture.connection.db.transaction(async (tx) => {
    await tx
      .update(guestIdentities)
      .set({ identity: issued })
      .where(eq(guestIdentities.allocationId, reference.allocationId));
    await tx
      .update(guestBootstraps)
      .set({ consumedAt: new Date(), sealedToken: null })
      .where(eq(guestBootstraps.allocationId, reference.allocationId));
  });
  await expect(recoverGuestBootstrap(fixture.connection.db, { reference, seal })).rejects.toThrow(
    'consumed',
  );
  await expect(
    fixture.connection.db
      .update(guestIdentities)
      .set({ identity: { ...issued, sshHostCertificate: 'another-cert' } }),
  ).rejects.toThrow();
  const [bootstrap] = await fixture.connection.db.select().from(guestBootstraps);
  expect(bootstrap?.sealedToken).toBe(null);
  expect(bootstrap?.tokenHash.length).toBe(64);
});

it('expires preparation and recovery without minting a replacement token', async () => {
  const input = await preparation();
  const reference = await fixture.connection.db.transaction((tx) =>
    prepareGuestBootstrap(tx, input),
  );
  const [stored] = await fixture.connection.db.select().from(guestBootstraps);
  if (!stored) throw new Error('Expected bootstrap.');
  vi.spyOn(databaseClock, 'databaseTime').mockResolvedValue(stored.expiresAt);
  await expect(recoverGuestBootstrap(fixture.connection.db, { reference, seal })).rejects.toThrow(
    'expired',
  );
  await expect(
    fixture.connection.db.transaction((tx) => prepareGuestBootstrap(tx, input)),
  ).rejects.toThrow('no longer usable');
  expect((await fixture.connection.db.select().from(guestBootstraps))[0]?.tokenHash).toBe(
    stored.tokenHash,
  );
});

it.each([-86_400_000, 86_400_000])(
  'preserves preparation and recovery under %i ms application clock drift',
  async (skew) => {
    const input = await preparation();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + skew);
    const reference = await fixture.connection.db.transaction((tx) =>
      prepareGuestBootstrap(tx, input),
    );
    const first = await recoverGuestBootstrap(fixture.connection.db, { reference, seal });
    expect(
      await fixture.connection.db.transaction((tx) => prepareGuestBootstrap(tx, input)),
    ).toEqual(reference);
    expect(await recoverGuestBootstrap(fixture.connection.db, { reference, seal })).toEqual(first);
  },
);

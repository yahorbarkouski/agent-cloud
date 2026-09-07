import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { type ImageReleaseKey } from '../packages/contracts/dist/index.js';
import { connect, imageBuilds, imagePublications } from '../packages/db/dist/index.js';
import { imageReleaseKeyId, signImageRelease } from '../packages/images/dist/index.js';
import { advanceImageBuild } from '../apps/control/dist/advance-image-build.js';
import { admitImageBuild, requestImageCleanup } from '../apps/control/dist/image-builds.js';
import { planImageCleanup } from '../apps/control/dist/image-cleanup.js';
import { runImageEffect } from '../apps/control/dist/image-effect-journal.js';
import { parseImageReservations } from '../apps/control/dist/image-budget.js';
import {
  prepareImagePublication,
  publishImageRelease,
  readPublishedImage,
} from '../apps/control/dist/image-publication.js';
import { imageVerifierScenario } from './image-verifier-fixture.js';
import { imageBuildFixture } from './image-build-fixture.js';
import { testDatabase } from './database.js';

let database: Awaited<ReturnType<typeof testDatabase>>;
let directory: string;
beforeAll(async () => {
  database = await testDatabase();
});
afterAll(async () => {
  await database.close();
});
beforeEach(async () => {
  await database.reset();
  directory = await mkdtemp(join(tmpdir(), 'agent-cloud-publication-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
const pair = generateKeyPairSync('ed25519');
function signing() {
  const now = Date.now();
  const key: ImageReleaseKey = {
    kind: 'trusted',
    publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    signedFrom: new Date(now - 60_000).toISOString(),
    signedUntil: new Date(now + 86_400_000).toISOString(),
    verifyUntil: new Date(now + 2 * 86_400_000).toISOString(),
  };
  return { privateKey: pair.privateKey, keys: [key] };
}
async function scenario(retain = true) {
  const f = await imageVerifierScenario(database.connection, directory, retain);
  await f.service.enroll(f.proposal);
  await f.runtimeService.check(f.buildId);
  const publication = signing();
  return { ...f, publication, advance: () => advanceImageBuild({ ...f, publication }) };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;
async function finishTemporary(f: Scenario) {
  for (let pass = 0; pass < 15; pass++) {
    const plan = await planImageCleanup({ ...f, intent: 'release' });
    if (plan.kind === 'busy') throw new Error('Unexpected fixture lock.');
    if (plan.value.kind === 'ready_to_publish') return;
    if (plan.value.kind !== 'delete') throw new Error('Unexpected incomplete fixture cleanup.');
    await runImageEffect({ ...f, command: plan.value.command });
  }
  throw new Error('Fixture cleanup did not converge.');
}
async function retained(f: Scenario) {
  for (let pass = 0; pass < 16; pass++) {
    const result = await f.advance();
    if (result.kind === 'retained') return result.release;
  }
  throw new Error('Fixture publication did not converge.');
}
function snapshot(f: Scenario) {
  const value = [...f.provider.resources.values()].find((resource) => resource.kind === 'snapshot');
  if (!value) throw new Error('Missing fixture snapshot.');
  return value;
}

it('publishes only after temporary cleanup, preserves the exact release across connections and selects its live snapshot', async () => {
  const f = await scenario();
  expect(await f.advance()).toMatchObject({ kind: 'publication_prepared' });
  await expect(publishImageRelease({ ...f, ...f.publication })).rejects.toThrow('absent temporary');
  await expect(
    database.connection.db
      .update(imageBuilds)
      .set({ state: { kind: 'retained', at: new Date().toISOString() } }),
  ).rejects.toThrow();
  await finishTemporary(f);
  // Provider source metadata may disappear after deletion. Persisted provenance remains exact.
  const image = snapshot(f);
  f.provider.add({ ...image, sourceServerId: null });
  const restarted = connect(database.databaseUrl);
  let release;
  try {
    const result = await advanceImageBuild({ ...f, connection: restarted });
    if (result.kind !== 'retained') throw new Error('Expected retained publication.');
    release = result.release;
    expect(await advanceImageBuild({ ...f, connection: restarted })).toEqual(result);
  } finally {
    await restarted.pool.end();
  }
  expect([...f.provider.resources.values()].map((resource) => resource.kind)).toEqual(['snapshot']);
  expect(await readdir(join(directory, 'keys'))).toEqual([]);
  const selected = await readPublishedImage({ ...f, keys: f.publication.keys });
  expect(selected).toMatchObject({ value: { release, image: { providerImage: image.id } } });
  expect(release.payload.sanitation.serverId).toBe(image.sourceServerId);
  expect(JSON.stringify(await f.inspection())).not.toContain(f.bootstrap.token);
  await expect(database.connection.db.delete(imagePublications)).rejects.toThrow();
  await expect(database.connection.db.update(imagePublications).set({ release })).rejects.toThrow();
});

it('rejects publication without verification or retained admission', async () => {
  const f = await imageVerifierScenario(database.connection, directory, true);
  await expect(prepareImagePublication(f)).rejects.toThrow('verified boot');
  expect((await f.inspection()).state.kind).toBe('running');
  await database.reset();
  const verificationOnly = await scenario(false);
  await expect(prepareImagePublication(verificationOnly)).rejects.toThrow(
    'admitted retained snapshot',
  );
  for (let pass = 0; pass < 16; pass++)
    if ((await verificationOnly.advance()).kind === 'cleaned') break;
  expect((await verificationOnly.inspection()).state.kind).toBe('cleaned');
  expect(verificationOnly.provider.resources.size).toBe(0);
  expect(await database.connection.db.select().from(imagePublications)).toEqual([]);
});

it('rejects altered evidence and refuses signing or snapshot deletion during retained cleanup', async () => {
  const f = await scenario();
  await prepareImagePublication(f);
  const build = await f.inspection();
  if (build.publication.kind !== 'prepared') throw new Error('Expected evidence.');
  const evidence = build.publication.evidence;
  await expect(
    database.connection.db.update(imagePublications).set({
      evidence: { ...evidence, retainUntil: new Date(Date.now() + 99_000_000).toISOString() },
    }),
  ).rejects.toThrow();
  const release = signImageRelease(
    { ...evidence, issuedAt: new Date().toISOString() },
    pair.privateKey,
  );
  await expect(database.connection.db.update(imagePublications).set({ release })).rejects.toThrow();
  await expect(
    runImageEffect({
      ...f,
      command: { kind: 'delete', resource: { kind: 'snapshot', id: snapshot(f).id } },
    }),
  ).rejects.toThrow('cannot delete');
  expect((await f.inspection()).publication.kind).toBe('prepared');
});

it.each(['preparing', 'publishing', 'selecting'])(
  'honors cancellation during %s provider observations',
  async (phase) => {
    const f = await scenario();
    if (phase !== 'preparing') {
      await prepareImagePublication(f);
      await finishTemporary(f);
    }
    if (phase === 'selecting') await publishImageRelease({ ...f, ...f.publication });
    const original = f.provider.get.bind(f.provider);
    let cancelled = false;
    vi.spyOn(f.provider, 'get').mockImplementation(async (ref) => {
      if (!cancelled) {
        cancelled = true;
        await requestImageCleanup(database.connection.db, f.buildId);
      }
      return original(ref);
    });
    if (phase === 'preparing')
      await expect(prepareImagePublication(f)).rejects.toThrow('no longer active');
    if (phase === 'publishing')
      await expect(publishImageRelease({ ...f, ...f.publication })).rejects.toThrow();
    if (phase === 'selecting')
      await expect(readPublishedImage({ ...f, keys: f.publication.keys })).rejects.toThrow(
        'cancelled',
      );
    expect((await f.inspection()).state.kind).toBe('cleaning');
    for (let pass = 0; pass < 16; pass++) if ((await f.advance()).kind === 'cleaned') break;
    expect(f.provider.resources.size).toBe(0);
  },
);

it.each(['labels', 'source', 'size', 'created', 'unavailable', 'missing'])(
  'refuses a retained snapshot with changed %s',
  async (change) => {
    const f = await scenario();
    await retained(f);
    const image = snapshot(f);
    if (change === 'labels')
      f.provider.add({ ...image, labels: { ...image.labels, effect_id: randomUUID() } });
    if (change === 'source') f.provider.add({ ...image, sourceServerId: '9999' });
    if (change === 'size') f.provider.add({ ...image, diskGb: 80 });
    if (change === 'created')
      f.provider.add({ ...image, createdAt: new Date(Date.now() + 1).toISOString() });
    if (change === 'unavailable') f.provider.add({ ...image, status: 'unavailable' });
    if (change === 'missing') f.provider.resources.clear();
    await expect(readPublishedImage({ ...f, keys: f.publication.keys })).rejects.toThrow(
      'snapshot is missing',
    );
    await expect(f.advance()).rejects.toThrow('snapshot is missing');
    await expect(publishImageRelease({ ...f, ...f.publication })).rejects.toThrow(
      'snapshot is missing',
    );
  },
);

it('refuses an untrusted signature, retries after trust repair, and enforces revocation on selection', async () => {
  const f = await scenario();
  await prepareImagePublication(f);
  await finishTemporary(f);
  await expect(publishImageRelease({ ...f, ...f.publication, keys: [] })).rejects.toThrow(
    'not trusted',
  );
  expect((await f.inspection()).publication.kind).toBe('prepared');
  await publishImageRelease({ ...f, ...f.publication });
  await expect(
    readPublishedImage({
      ...f,
      keys: [...f.publication.keys, { kind: 'revoked', keyId: imageReleaseKeyId(pair.publicKey) }],
    }),
  ).rejects.toThrow('not trusted');
  const revoked = {
    ...f.publication,
    keys: [
      ...f.publication.keys,
      { kind: 'revoked', keyId: imageReleaseKeyId(pair.publicKey) } satisfies ImageReleaseKey,
    ],
  };
  await expect(publishImageRelease({ ...f, ...revoked })).rejects.toThrow('not trusted');
  await expect(advanceImageBuild({ ...f, publication: revoked })).rejects.toThrow('not trusted');
});

it('keeps the snapshot unsigned when key removal fails and resumes without creating another machine', async () => {
  const f = await scenario();
  await prepareImagePublication(f);
  await finishTemporary(f);
  const creates = f.provider.submitted.filter((command) =>
    command.kind.startsWith('create_'),
  ).length;
  vi.spyOn(f.access, 'remove').mockRejectedValueOnce(new Error('Fixture key-store error.'));
  await expect(f.advance()).rejects.toThrow('key-store error');
  expect((await f.inspection()).publication.kind).toBe('prepared');
  expect((await f.advance()).kind).toBe('retained');
  expect(f.provider.submitted.filter((command) => command.kind.startsWith('create_'))).toHaveLength(
    creates,
  );
});

it('releases VM capacity while retaining storage allowance and eventually deletes an expired release', async () => {
  const f = await scenario();
  const release = await retained(f);
  const reservations = parseImageReservations([await f.inspection()]);
  expect(reservations).toEqual([
    { currency: 'USD', openBuilds: 0, vmGrossMicros: 0, snapshotMonthlyGrossMicros: 1_000_000 },
  ]);
  const sourceDirectory = join(directory, 'second-inputs');
  const next = await imageBuildFixture(sourceDirectory);
  await expect(
    admitImageBuild({ ...next, sourceDirectory, db: database.connection.db }),
  ).rejects.toThrow('retained snapshots');
  await admitImageBuild({
    ...next,
    sourceDirectory,
    db: database.connection.db,
    limits: { ...next.limits, maxSnapshotMonthlyGrossMicros: 2_000_000 },
  });
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(release.payload.retainUntil));
  for (let pass = 0; pass < 5; pass++) if ((await f.advance()).kind === 'cleaned') break;
  expect((await f.inspection()).state.kind).toBe('cleaned');
  expect(f.provider.resources.size).toBe(0);
  expect(parseImageReservations([await f.inspection()])[0]?.snapshotMonthlyGrossMicros).toBe(0);
  await expect(readPublishedImage({ ...f, keys: f.publication.keys })).rejects.toThrow(
    'Only a retained',
  );
  expect((await f.inspection()).publication.kind).toBe('published');
});

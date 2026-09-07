import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  CloudError,
  bootstrapSpecSchema,
  imageBuildIdSchema,
  newId,
  operationResponseSchema,
  providerCommandSchema,
  type MachineProvider,
} from '../packages/contracts/dist/index.js';
import {
  allocationImages,
  allocations,
  attempts,
  guestBootstraps,
  operations,
  simulatedServers,
  withImageBuildLock,
} from '../packages/db/dist/index.js';
import { createApp } from '../apps/control/dist/app.js';
import { advanceOperation } from '../apps/control/dist/advance-operation.js';
import {
  createAllocationImageResolver,
  imageSnapshotInUse,
} from '../apps/control/dist/allocation-image.js';
import { createGuestRenderer } from '../apps/control/dist/guest-renderer.js';
import { prepareGuestBootstrap } from '../apps/control/dist/guest-bootstrap.js';
import { requestImageCleanup } from '../apps/control/dist/image-builds.js';
import { runImageEffect } from '../apps/control/dist/image-effect-journal.js';
import {
  SimulatedProvider,
  type SimulationFault,
} from '../apps/control/dist/simulated-provider.js';
import { seedAccount, testDatabase } from './database.js';
import { verifiedImageScenario } from './image-publication-fixture.js';

let database: Awaited<ReturnType<typeof testDatabase>>;
let directory: string;
const limits = { currency: 'USD', maxMachines: 100, maxHourlyMicros: 1_000_000 };
beforeAll(async () => {
  database = await testDatabase();
});
afterAll(async () => {
  await database.close();
});
beforeEach(async () => {
  await database.reset();
  directory = await mkdtemp(join(tmpdir(), 'agent-cloud-image-use-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function scenario(fault: SimulationFault = { kind: 'none' }) {
  const f = await verifiedImageScenario(database.connection, directory);
  const release = await f.publish();
  const account = await seedAccount(database.connection.db, { currency: 'USD' });
  const imageRelease = { buildId: f.buildId, readKeys: f.publication.readKeys };
  const simulation = new SimulatedProvider({
    db: database.connection.db,
    fault,
    catalog: () => f.catalog,
  });
  const resolveImage = createAllocationImageResolver({ ...f, readKeys: f.publication.readKeys });
  const render = vi.fn(createGuestRenderer(database.connection.db, f.seal, resolveImage));
  const submit = vi.fn<MachineProvider['submit']>(async (input) => {
    if (input.command.kind === 'create_guest') {
      try {
        await render({ attemptId: input.attemptId, command: input.command });
      } catch (error) {
        if (!(error instanceof CloudError)) throw error;
        return { kind: 'rejected', error: error.failure };
      }
    }
    return simulation.submit(input);
  });
  const customerProvider: MachineProvider = {
    kind: 'hetzner',
    getCatalog: () => simulation.getCatalog(),
    submit,
    getAction: (input) => simulation.getAction(input),
    getServer: (input) => simulation.getServer(input),
    findServers: (input) => simulation.findServers(input),
    getPrimaryIp: (input) => simulation.getPrimaryIp(input),
    findPrimaryIps: (input) => simulation.findPrimaryIps(input),
  };
  const configuration = {
    db: database.connection.db,
    provider: 'hetzner',
    limits,
    catalog: () => f.catalog,
    imageRelease,
  } satisfies Parameters<typeof createApp>[0];
  const app = createApp(configuration);
  const key = randomUUID();
  const request = (target = app, requestKey = key) =>
    target.request(`/v1/projects/${account.projectId}/machines`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${account.token}`,
        'Idempotency-Key': requestKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'image-customer', size: 'small', region: 'nbg1' }),
    });
  const response = await request();
  expect(response.status).toBe(202);
  const { operation } = operationResponseSchema.parse(await response.json());
  const [allocation] = await database.connection.db
    .select()
    .from(allocations)
    .where(eq(allocations.machineId, operation.machineId));
  if (!allocation) throw new Error('Expected customer allocation.');
  const guest = {
    kind: 'enabled',
    resolveImage,
    prepareBootstrap: (tx, input) =>
      prepareGuestBootstrap(tx, { ...input, seal: f.seal, enrollmentUrl: f.enrollmentUrl }),
    runtime: { check: () => Promise.resolve({ kind: 'waiting' }) },
  } satisfies NonNullable<Parameters<typeof advanceOperation>[0]['guest']>;
  const tick = () =>
    advanceOperation({
      connection: database.connection,
      operationId: operation.id,
      provider: customerProvider,
      limits,
      guest,
    });
  const history = () =>
    database.connection.db
      .select()
      .from(attempts)
      .where(eq(attempts.operationId, operation.id))
      .orderBy(attempts.sequence);
  const pinned = () => imageSnapshotInUse(database.connection.db, f.buildId);
  const commands = async () =>
    (await history()).map((row) => providerCommandSchema.parse(row.command).kind);
  async function cleanImage() {
    for (let pass = 0; pass < 8; pass++) if ((await f.advance()).kind === 'cleaned') return;
    throw new Error('Image cleanup did not converge.');
  }
  return {
    ...f,
    release,
    account,
    configuration,
    request,
    operation,
    allocation,
    guest,
    tick,
    history,
    commands,
    pinned,
    submit,
    render,
    cleanImage,
  };
}

it('pins the original signed release across idempotent admission and uses it for the real bootstrap renderer', async () => {
  const f = await scenario();
  expect(await f.pinned()).toBe(true);
  const changedDefault = createApp({
    ...f.configuration,
    imageRelease: {
      buildId: imageBuildIdSchema.parse(randomUUID()),
      readKeys: () => Promise.resolve([]),
    },
  });
  const replay = await f.request(changedDefault);
  expect(operationResponseSchema.parse(await replay.json()).operation.id).toBe(f.operation.id);
  expect(await database.connection.db.select().from(allocationImages)).toHaveLength(1);
  for (let pass = 0; pass < 7; pass++) await f.tick();
  expect(await f.commands()).toEqual(['create_primary_ip', 'create_guest']);
  expect(f.render).toHaveBeenCalledTimes(1);
  const [bootstrap] = await database.connection.db.select().from(guestBootstraps);
  const spec = bootstrapSpecSchema.parse(bootstrap?.spec);
  expect(spec.image.providerImage).toBe(f.release.payload.snapshot.id);
  expect(Date.parse(spec.expiresAt)).toBe(Date.parse(f.operation.createdAt) + 30 * 60_000);
  expect(await f.pinned()).toBe(false);
  await requestImageCleanup(database.connection.db, f.buildId);
  await f.cleanImage();
  expect(f.provider.resources.size).toBe(0);
  // Reconciliation of a completed create no longer depends on the boot snapshot.
  await f.tick();
  expect(await f.commands()).toEqual(['create_primary_ip', 'create_guest']);
});

it('rolls back new admissions with incompatible or untrusted releases', async () => {
  const f = await scenario();
  const untrusted = createApp({
    ...f.configuration,
    imageRelease: { buildId: f.buildId, readKeys: () => Promise.resolve([]) },
  });
  expect((await f.request(untrusted, randomUUID())).status).toBeGreaterThanOrEqual(400);
  const incompatible = createApp({
    ...f.configuration,
    catalog: () => ({
      ...f.catalog,
      items: f.catalog.items.map((offer) => ({ ...offer, architecture: 'arm' })),
    }),
  });
  expect((await f.request(incompatible, randomUUID())).status).toBeGreaterThanOrEqual(400);
  expect(await database.connection.db.select().from(allocations)).toHaveLength(1);
  expect(await database.connection.db.select().from(operations)).toHaveLength(1);
  expect(await database.connection.db.select().from(allocationImages)).toHaveLength(1);
});

it('refuses a substituted bootstrap, mutable pin and a second guest-create effect in SQL', async () => {
  const f = await scenario();
  const image = await f.guest.resolveImage(f.allocation);
  await expect(
    database.connection.db.transaction((tx) =>
      f.guest.prepareBootstrap(tx, {
        allocation: f.allocation,
        operation: f.operation,
        image: { ...image, providerImage: 'other-snapshot' },
      }),
    ),
  ).rejects.toThrow();
  await expect(
    database.connection.db.update(allocationImages).set({ snapshotId: 'other' }),
  ).rejects.toThrow();
  await expect(database.connection.db.delete(allocationImages)).rejects.toThrow();
  for (let pass = 0; pass < 7; pass++) await f.tick();
  const created = (await f.history()).find(
    (row) => providerCommandSchema.parse(row.command).kind === 'create_guest',
  );
  if (!created) throw new Error('Expected original create.');
  await expect(
    database.connection.db
      .insert(attempts)
      .values({ ...created, id: newId.attempt(), sequence: created.sequence + 1 }),
  ).rejects.toThrow();
});

it.each([false, true])(
  'cancels the release before a fresh VM create and retires its allocation, with IP: %s',
  async (withIp) => {
    const f = await scenario();
    if (withIp) {
      await f.tick();
      await f.tick();
    }
    await requestImageCleanup(database.connection.db, f.buildId);
    await f.advance();
    expect(await f.pinned()).toBe(true);
    expect([...f.provider.resources.values()].map((resource) => resource.kind)).toEqual([
      'snapshot',
    ]);
    for (let pass = 0; pass < 8; pass++) await f.tick();
    expect(await f.commands()).toEqual(withIp ? ['create_primary_ip', 'delete_primary_ip'] : []);
    expect(await f.pinned()).toBe(false);
    await f.cleanImage();
    expect(f.provider.resources.size).toBe(0);
    await expect(
      database.connection.db.update(allocations).set({ retiredAt: null }),
    ).rejects.toThrow();
  },
);

it('holds snapshot ownership through an unknown create until its original server becomes visible', async () => {
  const f = await scenario({ kind: 'lose_response', visibilityDelayMs: 86_400_000 });
  for (let pass = 0; pass < 7; pass++) await f.tick();
  expect(await f.pinned()).toBe(true);
  await requestImageCleanup(database.connection.db, f.buildId);
  for (let pass = 0; pass < 3; pass++) await f.advance();
  expect(f.provider.resources.size).toBe(1);
  await expect(
    runImageEffect({
      ...f,
      command: {
        kind: 'delete',
        resource: { kind: 'snapshot', id: f.release.payload.snapshot.id },
      },
    }),
  ).rejects.toThrow();
  await database.connection.db.update(simulatedServers).set({ visibleAt: new Date(0) });
  for (let pass = 0; pass < 4; pass++) await f.tick();
  expect(await f.pinned()).toBe(false);
  await f.cleanImage();
  expect(f.provider.resources.size).toBe(0);
  expect(await f.commands()).toEqual(['create_primary_ip', 'create_guest']);
  expect(f.render).toHaveBeenCalledTimes(1);
});

it('retains the snapshot indefinitely for a create whose outcome remains unknown', async () => {
  const f = await scenario({ kind: 'timeout_before_submit' });
  for (let pass = 0; pass < 7; pass++) await f.tick();
  await requestImageCleanup(database.connection.db, f.buildId);
  for (let pass = 0; pass < 4; pass++) {
    await f.tick();
    await f.advance();
  }
  expect(await f.pinned()).toBe(true);
  expect(f.provider.resources.size).toBe(1);
  expect(await f.commands()).toEqual(['create_primary_ip', 'create_guest']);
});

it('releases a rejected create only after IP compensation and allocation retirement', async () => {
  const f = await scenario({ kind: 'reject' });
  for (let pass = 0; pass < 9; pass++) await f.tick();
  expect(await f.commands()).toEqual(['create_primary_ip', 'create_guest', 'delete_primary_ip']);
  expect(await f.pinned()).toBe(false);
  await requestImageCleanup(database.connection.db, f.buildId);
  await f.cleanImage();
  expect(f.provider.resources.size).toBe(0);
});

it('waits for a busy publication without failing the allocation or renting an IP', async () => {
  const f = await scenario();
  await withImageBuildLock({
    pool: database.connection.pool,
    buildId: f.buildId,
    work: async () => {
      await f.tick();
      expect(await f.commands()).toEqual([]);
      const [row] = await database.connection.db
        .select()
        .from(operations)
        .where(eq(operations.id, f.operation.id));
      expect(row?.progress).toEqual({ kind: 'queued' });
    },
  });
  await f.tick();
  expect(await f.commands()).toEqual(['create_primary_ip']);
});

it.each([false, true])(
  'compensates when trust is revoked after admission, at rendering: %s',
  async (atRendering) => {
    const f = await scenario();
    await f.tick();
    await f.tick();
    if (atRendering) {
      const render = createGuestRenderer(database.connection.db, f.seal, f.guest.resolveImage);
      f.render.mockImplementationOnce(async (input) => {
        f.publication.keys.splice(0);
        return render(input);
      });
    } else f.publication.keys.splice(0);
    for (let pass = 0; pass < 9; pass++) await f.tick();
    expect(await f.commands()).toEqual(
      atRendering
        ? ['create_primary_ip', 'create_guest', 'delete_primary_ip']
        : ['create_primary_ip', 'delete_primary_ip'],
    );
    expect(await f.pinned()).toBe(false);
    expect(await database.connection.db.select().from(simulatedServers)).toEqual([]);
    await requestImageCleanup(database.connection.db, f.buildId);
    await f.cleanImage();
    expect(f.provider.resources.size).toBe(0);
  },
);

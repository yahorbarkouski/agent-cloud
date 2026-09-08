import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { eq, sql } from 'drizzle-orm';
import { run, runOnce } from 'graphile-worker';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { connect, imageBuilds } from '../packages/db/dist/index.js';
import {
  admitImageBuild,
  inspectImageBuild,
  requestImageCleanup,
} from '../apps/control/dist/image-builds.js';
import { createImageTasks } from '../apps/control/dist/image-tasks.js';
import { advanceImageBuild } from '../apps/control/dist/advance-image-build.js';
import {
  enqueueImageBuild,
  requestImageRun,
  scheduleImageBuild,
} from '../apps/control/dist/image-scheduling.js';
import { verifiedImageScenario } from './image-publication-fixture.js';
import { imageBuildFixture } from './image-build-fixture.js';
import { testDatabase } from './database.js';

let database: Awaited<ReturnType<typeof testDatabase>>;
let directory: string;
beforeEach(async () => {
  database = await testDatabase();
  directory = await mkdtemp(join(tmpdir(), 'agent-cloud-image-work-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await database.close();
  await rm(directory, { recursive: true, force: true });
});
async function queued(buildId: string) {
  const result = await database.connection.pool.query<{
    run_at: Date;
    attempts: number;
    last_error: string | null;
  }>('SELECT run_at, attempts, last_error FROM graphile_worker.jobs WHERE key=$1', [
    'image:' + buildId,
  ]);
  return result.rows[0];
}

it('admission queues only a deadline, and an early delivered job cannot construct a cloud controller', async () => {
  const f = await imageBuildFixture(directory);
  await admitImageBuild({ ...f, db: database.connection.db, sourceDirectory: directory });
  expect((await queued(f.admission.id))?.run_at.toISOString()).toBe(f.admission.deadlineAt);
  const advance = vi.fn<Parameters<typeof createImageTasks>[0]['advance']>(() => {
    throw new Error('Unexpected cloud work.');
  });
  // Even a duplicate or premature queue delivery must not start unrequested work.
  await enqueueImageBuild(database.connection.db, f.admission.id);
  await runOnce({
    pgPool: database.connection.pool,
    concurrency: 1,
    noHandleSignals: true,
    taskList: createImageTasks({ connection: database.connection, advance }),
  });
  expect(advance).not.toHaveBeenCalled();
  expect((await queued(f.admission.id))?.run_at.toISOString()).toBe(f.admission.deadlineAt);
  expect(
    (await inspectImageBuild(database.connection.db, f.admission.id)).runRequestedAt,
  ).toBeNull();
});

it('starts explicitly, resumes publication on a real worker, and queues retained expiry', async () => {
  const f = await verifiedImageScenario(database.connection, directory);
  const started = await promisify(execFile)(
    process.execPath,
    ['scripts/image-build.ts', 'start', f.buildId],
    {
      env: {
        ...process.env,
        DATABASE_URL: database.databaseUrl,
        ACLD_CONTROL_GENERATION_FILE: await database.controlIdentity(),
      },
    },
  );
  expect(started.stderr).toBe('');
  const requestedAt = (await f.inspection()).runRequestedAt;
  const startedBuild: unknown = JSON.parse(started.stdout);
  expect(requestedAt).not.toBeNull();
  expect(startedBuild).toMatchObject({ runRequestedAt: requestedAt });
  const restart = connect(database.databaseUrl);
  const runner = await run({
    pgPool: restart.pool,
    concurrency: 2,
    pollInterval: 100,
    noHandleSignals: true,
    taskList: createImageTasks({
      connection: restart,
      advance: () => advanceImageBuild({ ...f, connection: restart }),
    }),
    crontab: '* * * * * reconcile_image_builds',
  });
  try {
    await expect
      .poll(async () => (await f.inspection()).state.kind, { timeout: 30_000, interval: 100 })
      .toBe('retained');
    await expect
      .poll(async () => (await queued(f.buildId))?.run_at.toISOString())
      .toBe(
        f.admission.retention.kind === 'retain'
          ? f.admission.retention.deleteAfter
          : 'unexpected verification-only fixture',
      );
    expect((await f.inspection()).accessRemovedAt).not.toBeNull();
    // Replaying start after progress preserves its first intent and never rebuilds.
    const creates = f.provider.submitted.filter((command) =>
      command.kind.startsWith('create_'),
    ).length;
    await requestImageRun(database.connection.db, f.buildId);
    expect((await f.inspection()).runRequestedAt).toBe(requestedAt);
    await requestImageCleanup(database.connection.db, f.buildId);
    await expect
      .poll(async () => (await f.inspection()).state.kind, { timeout: 10_000, interval: 100 })
      .toBe('cleaned');
    expect(f.provider.resources.size).toBe(0);
    expect(
      f.provider.submitted.filter((command) => command.kind.startsWith('create_')),
    ).toHaveLength(creates);
  } finally {
    await runner.stop();
    await runner.promise;
    await restart.pool.end();
  }
}, 45_000);

it('reconciles filesystem cleanup after a failed job and a new database connection', async () => {
  const f = await verifiedImageScenario(database.connection, directory);
  await requestImageCleanup(database.connection.db, f.buildId);
  const failingAccess = {
    ...f.access,
    remove: vi.fn().mockRejectedValue(new Error('fixture filesystem unavailable')),
  };
  const taskList = createImageTasks({
    connection: database.connection,
    advance: () => advanceImageBuild({ ...f, access: failingAccess }),
  });
  // Run due jobs through Graphile, making each next pass due explicitly for this failure test.
  for (let pass = 0; pass < 15 && (await f.inspection()).state.kind !== 'cleaned'; pass++) {
    await enqueueImageBuild(database.connection.db, f.buildId);
    await runOnce({
      pgPool: database.connection.pool,
      concurrency: 1,
      noHandleSignals: true,
      taskList,
    });
  }
  expect((await f.inspection()).state.kind).toBe('cleaned');
  expect((await f.inspection()).accessRemovedAt).toBeNull();
  expect(failingAccess.remove).toHaveBeenCalled();
  expect((await queued(f.buildId))?.last_error).toContain('filesystem unavailable');
  const restart = connect(database.databaseUrl);
  try {
    const restartedTasks = createImageTasks({
      connection: restart,
      advance: () => advanceImageBuild({ ...f, connection: restart }),
    });
    await restart.db.execute(sql`SELECT graphile_worker.add_job('reconcile_image_builds')`);
    await runOnce({
      pgPool: restart.pool,
      concurrency: 1,
      noHandleSignals: true,
      taskList: restartedTasks,
    });
    expect((await queued(f.buildId))?.attempts).toBe(0);
    await enqueueImageBuild(restart.db, f.buildId);
    await runOnce({
      pgPool: restart.pool,
      concurrency: 1,
      noHandleSignals: true,
      taskList: restartedTasks,
    });
  } finally {
    await restart.pool.end();
  }
  expect((await f.inspection()).accessRemovedAt).not.toBeNull();
  expect(f.provider.resources.size).toBe(0);
  expect(await queued(f.buildId)).toBeUndefined();
});

it('serializes retention scheduling with cancellation so a stale timer cannot postpone cleanup', async () => {
  const f = await verifiedImageScenario(database.connection, directory);
  await f.publish();
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const held = database.connection.db.transaction(async (tx) => {
    await tx.select().from(imageBuilds).where(eq(imageBuilds.id, f.buildId)).for('update');
    entered.resolve(undefined);
    await release.promise;
    await tx
      .update(imageBuilds)
      .set({ state: { kind: 'cleaning', reason: 'requested' } })
      .where(eq(imageBuilds.id, f.buildId));
    await enqueueImageBuild(tx, f.buildId);
  });
  await entered.promise;
  const scheduling = scheduleImageBuild(database.connection.db, f.buildId);
  // The scheduling transaction is concurrent with cancellation's held row lock.
  await setTimeout(25);
  release.resolve(undefined);
  await Promise.all([held, scheduling]);
  expect((await queued(f.buildId))?.run_at.getTime()).toBeLessThan(Date.now() + 2000);
  await expect(requestImageRun(database.connection.db, f.buildId)).rejects.toThrow(
    'active admitted',
  );
  await expect(
    database.connection.db.update(imageBuilds).set({ accessRemovedAt: null }),
  ).rejects.toThrow();
});

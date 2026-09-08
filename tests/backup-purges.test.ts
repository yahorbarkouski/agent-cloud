import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { runOnce } from 'graphile-worker';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  backupCaptureRequestSchema,
  backupPurgeRequestSchema,
  backupPurgeResponseSchema,
  backupSummarySchema,
  restoreRequestSchema,
  newId,
  simulatedCatalog,
} from '../packages/contracts/src/index.js';
import {
  allocations,
  backups,
  backupPurges,
  backupRestores,
  backupSchedules,
  backupScheduleRuns,
  grants,
  machines,
  withBackupWorkerLock,
} from '../packages/db/src/index.js';
import { createTasks } from '../apps/control/src/tasks.js';
import { SimulatedProvider } from '../apps/control/src/simulated-provider.js';
import { enqueueBackup, createBackups } from '../apps/control/src/backups.js';
import { createApp } from '../apps/control/src/app.js';
import { issueGrant } from '../apps/control/src/auth.js';
import {
  backupControlConfigSchema,
  backupRecord,
  backupWorkSchema,
} from '../apps/control/src/backup-records.js';
import { createBackupRetention } from '../apps/control/src/backup-retention.js';
import { admitExpiredBackup } from '../apps/control/src/backup-purges.js';
import { seedAccount, testDatabase } from './database.js';

let database: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  database = await testDatabase();
});
beforeEach(async () => {
  await database.reset();
});
afterAll(async () => {
  await database.close();
});
async function fixture() {
  const db = database.connection.db;
  const owner = await seedAccount(db);
  const machineId = newId.machine();
  const allocationId = newId.allocation();
  await db.insert(machines).values({
    id: machineId,
    accountId: owner.principal.accountId,
    projectId: owner.projectId,
    name: 'purge-source',
    provider: 'simulated',
    spec: { name: 'purge-source', size: 'small', region: 'fsn1' },
    state: {
      kind: 'allocated',
      allocationId,
      serverId: '1',
      power: 'running',
      guest: {
        kind: 'ssh',
        verifiedAt: new Date().toISOString(),
        imageVersion: 'fixture',
        manifestDigest: 'a'.repeat(64),
        bootId: randomUUID(),
      },
    },
  });
  const offer = simulatedCatalog('EUR').items[0];
  if (!offer) throw new Error('Fixture offer missing.');
  await db.insert(allocations).values({
    id: allocationId,
    accountId: owner.principal.accountId,
    machineId,
    provider: 'simulated',
    networkProfile: 'managed_ipv4',
    hourlyMicros: offer.hourlyMicros,
    currency: 'EUR',
    offer,
  });
  const config = backupControlConfigSchema.parse({
    version: 1,
    directory: '/tmp/purge-admission-fixture',
    store: {
      endpoint: 'http://127.0.0.1:9000',
      region: 'us-east-1',
      bucket: 'fixture-backups',
      keyPrefix: 'protected',
      maxBytes: 1_048_576,
      requestTimeoutMs: 1000,
    },
    writerCredentialsFile: '/tmp/not-read-writer',
    readerCredentialsFile: '/tmp/not-read-reader',
    keyringFile: '/tmp/not-read-keyring',
    limits: { maxBytes: 1_048_576, timeoutSeconds: 30 },
    maxGlobalBytes: 20_971_520,
  });
  const service = createBackups({ db, config, advance: async () => {} });
  const app = createApp({
    db,
    provider: 'simulated',
    catalog: () => simulatedCatalog('EUR'),
    limits: { currency: 'EUR', maxMachines: 20, maxHourlyMicros: 1_000_000 },
    backups: service,
  });
  const request = backupCaptureRequestSchema.parse({
    id: randomUUID(),
    recipe: {
      kind: 'compose-postgres',
      app: 'sample',
      releaseId: randomUUID(),
      service: 'database',
      database: 'reference',
      user: 'reference',
      files: [],
    },
  });
  const scheduleId = randomUUID();
  await db.insert(backupSchedules).values({
    id: scheduleId,
    accountId: owner.principal.accountId,
    projectId: owner.projectId,
    machineId,
    allocationId,
    grantId: owner.principal.grantId,
    digest: 'a'.repeat(64),
    recipe: request.recipe,
    nextRunAt: new Date(),
  });
  async function capture(
    input: {
      daysAgo?: number;
      scheduled?: boolean;
      failed?: boolean;
      files?: string[];
      pendingCleanup?: boolean;
    } = {},
  ) {
    // Explicit stored receipt fixture: transport/encryption have separate actual MinIO/native tests.
    const id = backupCaptureRequestSchema.shape.id.parse(randomUUID());
    const createdAt = new Date(Date.now() - (input.daysAgo ?? 10) * 86_400_000);
    const at = createdAt.toISOString();
    const retainUntil = new Date(createdAt.getTime() + 7 * 86_400_000).toISOString();
    const recipe = { ...request.recipe, releaseId: randomUUID(), files: input.files ?? [] };
    const manifest = {
      version: 1,
      recipe,
      capturedAt: at,
      completedAt: at,
      postgresVersion: '17.11',
      sourceFiles: 1,
      declaredFiles: [],
      consistency: 'database-consistent-files-best-effort',
      exclusions: [],
    };
    const record = backupSummarySchema.parse({
      id,
      accountId: owner.principal.accountId,
      projectId: owner.projectId,
      machineId,
      allocationId,
      createdAt: at,
      retainUntil,
      state: input.failed
        ? { kind: 'blocked', reason: 'Fixture capture failed.' }
        : { kind: 'captured', bytes: 16, capturedAt: at, validation: 'captured', manifest },
    });
    const intent = {
      storeId: 'a'.repeat(64),
      bucket: 'fixture-backups',
      key: `protected/${id}.enc`,
      attemptId: id,
      ciphertextSha256: 'a'.repeat(64),
      contentMd5: Buffer.alloc(16).toString('base64'),
      size: 16,
      retention: { mode: 'COMPLIANCE', retainUntil },
    };
    const work = backupWorkSchema.parse({
      kind: 'stored',
      capture: { kind: 'captured', id, manifest, bytes: 16, sha256: 'a'.repeat(64) },
      encryption: {
        version: 1,
        algorithm: 'aes-256-gcm',
        keyVersion: 'fixture',
        accountId: owner.principal.accountId,
        backupId: id,
        manifestSha256: 'a'.repeat(64),
        iv: Buffer.alloc(12).toString('base64'),
        tag: Buffer.alloc(16).toString('base64'),
        wrappedKey: Buffer.alloc(32).toString('base64'),
        wrappingIv: Buffer.alloc(12).toString('base64'),
        wrappingTag: Buffer.alloc(16).toString('base64'),
        plaintextBytes: 16,
        plaintextSha256: 'a'.repeat(64),
        ciphertextBytes: 16,
        ciphertextSha256: 'a'.repeat(64),
      },
      intent,
      receipt: { ...intent, versionId: randomUUID() },
      guestCleanup: input.pendingCleanup ? 'pending' : 'done',
      attempts: 0,
    });
    await db.insert(backups).values({
      id,
      accountId: record.accountId,
      projectId: record.projectId,
      machineId,
      allocationId,
      grantId: owner.principal.grantId,
      digest: 'a'.repeat(64),
      request: { kind: 'capture', id, recipe, limits: config.limits },
      record,
      work,
      reservedBytes: 16,
      createdAt,
    });
    if (input.scheduled)
      await db
        .insert(backupScheduleRuns)
        .values({ accountId: record.accountId, scheduleId, backupId: id, dueAt: createdAt });
    return record;
  }
  const purgeRequest = () =>
    backupPurgeRequestSchema.parse({ id: randomUUID(), allowDataLoss: true });
  const row = async (id: string) => {
    const [row] = await db.select().from(backups).where(eq(backups.id, id));
    if (!row) throw new Error('Missing capture.');
    return row;
  };
  const due = (id: string) =>
    db
      .update(backupPurges)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(backupPurges.id, id));
  const restore = (backupId: string) =>
    service.restore(
      owner.principal,
      restoreRequestSchema.parse({
        id: randomUUID(),
        backupId,
        app: 'recovered',
        machine: { name: `restore-${randomUUID().slice(0, 8)}`, size: 'small', region: 'fsn1' },
      }),
      {
        provider: 'simulated',
        catalog: () => simulatedCatalog('EUR'),
        limits: { currency: 'EUR', maxMachines: 20, maxHourlyMicros: 1_000_000 },
      },
    );
  return { db, owner, machineId, service, app, capture, purgeRequest, row, due, restore };
}

it('accepts a real CLI purge, keeps accounting through a lost deletion reply and resumes after disconnect/revocation', async () => {
  const f = await fixture();
  const captured = await f.capture();
  const request = f.purgeRequest();
  const scratch = await mkdtemp(join(tmpdir(), 'backup-purge-cli-'));
  const server = serve({ fetch: f.app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing listener.');
  const credentialFile = join(scratch, 'credentials.json');
  await writeFile(
    credentialFile,
    JSON.stringify({ server: `http://127.0.0.1:${address.port}`, token: f.owner.token }),
    { mode: 0o600 },
  );
  const cli = async (args: string[]) =>
    (
      await promisify(execFile)(process.execPath, ['apps/cli/dist/index.js', ...args], {
        env: { ...process.env, ACLD_CREDENTIALS: credentialFile },
        timeout: 10_000,
        maxBuffer: 65536,
      })
    ).stdout;
  try {
    await expect(cli(['backup', 'purge', captured.id, '--id', request.id])).rejects.toThrow();
    expect(await f.db.select().from(backupPurges)).toHaveLength(0);
    const args = ['backup', 'purge', captured.id, '--id', request.id, '--allow-data-loss'];
    const purge = backupPurgeResponseSchema.parse(JSON.parse(await cli(args))).purge;
    expect(purge.state.kind).toBe('waiting');
    expect(backupPurgeResponseSchema.parse(JSON.parse(await cli(args))).purge).toEqual(purge);
    await expect(f.restore(captured.id)).rejects.toMatchObject({
      failure: { code: 'resource_busy' },
    });
    let calls = 0;
    const worker = () =>
      createBackupRetention({
        connection: database.connection,
        deleter: {
          purge: async () => {
            calls++;
            const [intent] = await f.db
              .select()
              .from(backupPurges)
              .where(eq(backupPurges.id, purge.id));
            expect(intent?.record).toMatchObject({ state: { kind: 'submitted' } });
            if (calls === 1) throw new Error('Secret provider message must stay private');
            return { kind: 'absent' };
          },
        },
      });
    await worker().advance(purge.id);
    expect((await f.row(captured.id)).reservedBytes).toBe(16);
    const failed = backupPurgeResponseSchema.parse(
      JSON.parse(await cli(['backup', 'purge-inspect', purge.id])),
    ).purge;
    expect(failed.state.kind).toBe('blocked');
    expect(JSON.stringify(failed)).not.toContain('Secret');
    await f.db
      .update(grants)
      .set({ revokedAt: new Date() })
      .where(eq(grants.id, f.owner.principal.grantId));
    await f.due(purge.id);
    await Promise.all([worker().advance(purge.id), worker().advance(purge.id)]);
    expect(calls).toBe(2);
    expect(backupRecord(await f.row(captured.id)).state.kind).toBe('purged');
    expect((await f.row(captured.id)).reservedBytes).toBe(0);
    await worker().advance(purge.id);
    expect(calls).toBe(2);
  } finally {
    if ('closeAllConnections' in server) server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    await rm(scratch, { recursive: true, force: true });
  }
});

it('enforces account, capability, fresh revocation, replay and pending-retention boundaries', async () => {
  const f = await fixture();
  const backup = await f.capture({ daysAgo: 0 });
  const foreign = await seedAccount(f.db);
  const grant = await issueGrant(f.db, {
    principal: f.owner.principal,
    name: 'reader',
    policy: { ...f.owner.principal.policy, capabilities: ['backup:read'] },
    expiresAt: new Date(Date.now() + 60_000),
  });
  const readOnly = {
    ...f.owner.principal,
    grantId: grant.id,
    policy: {
      ...f.owner.principal.policy,
      capabilities: ['backup:read'] satisfies Array<'backup:read'>,
    },
  };
  await expect(
    f.service.purges.request(foreign.principal, backup.id, f.purgeRequest()),
  ).rejects.toMatchObject({ failure: { code: 'not_found' } });
  await expect(
    f.service.purges.request(readOnly, backup.id, f.purgeRequest()),
  ).rejects.toMatchObject({ failure: { code: 'permission_denied' } });
  const request = f.purgeRequest();
  const purges = await Promise.all([
    f.service.purges.request(f.owner.principal, backup.id, request),
    f.service.purges.request(f.owner.principal, backup.id, request),
  ]);
  expect(purges[0]).toEqual(purges[1]);
  const other = await f.capture();
  await expect(
    f.service.purges.request(f.owner.principal, other.id, request),
  ).rejects.toMatchObject({ failure: { code: 'idempotency_conflict' } });
  await expect(f.service.purges.inspect(foreign.principal, request.id)).rejects.toMatchObject({
    failure: { code: 'not_found' },
  });
  const extension = new Date(Date.now() + 10 * 86_400_000).toISOString();
  let effects = 0;
  const worker = createBackupRetention({
    connection: database.connection,
    deleter: {
      purge: () => {
        effects++;
        return Promise.resolve({ kind: 'retained', retainUntil: extension });
      },
    },
  });
  await worker.advance(request.id);
  expect(effects).toBe(0);
  await f.due(request.id);
  await worker.advance(request.id);
  expect((await f.service.purges.inspect(readOnly, request.id)).state).toEqual({
    kind: 'waiting',
    notBefore: extension,
  });
  expect((await f.row(backup.id)).reservedBytes).toBe(16);
  await f.db
    .update(grants)
    .set({ revokedAt: new Date() })
    .where(eq(grants.id, f.owner.principal.grantId));
  await expect(
    f.service.purges.request(f.owner.principal, other.id, f.purgeRequest()),
  ).rejects.toMatchObject({ failure: { code: 'unauthenticated' } });
});

it('serializes purge against restore admission and pins failed targets until destruction', async () => {
  const f = await fixture();
  const backup = await f.capture();
  const attempts = await Promise.allSettled([
    f.restore(backup.id),
    f.service.purges.request(f.owner.principal, backup.id, f.purgeRequest()),
  ]);
  expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const second = await f.capture();
  const restore = await f.restore(second.id);
  await f.db
    .update(backupRestores)
    .set({
      record: { ...restore, state: { kind: 'blocked', reason: 'Unresolved SQL receipt.' } },
      work: { kind: 'submitted', attempts: 5 },
    })
    .where(eq(backupRestores.id, restore.id));
  await expect(
    f.service.purges.request(f.owner.principal, second.id, f.purgeRequest()),
  ).rejects.toMatchObject({ failure: { code: 'resource_busy' } });
  await f.db
    .update(machines)
    .set({ state: { kind: 'destroyed', destroyedAt: new Date().toISOString() } })
    .where(eq(machines.id, restore.machineId));
  expect(
    (await f.service.purges.request(f.owner.principal, second.id, f.purgeRequest())).state.kind,
  ).toBe('waiting');
  const dirty = await f.capture({ pendingCleanup: true });
  await expect(
    f.service.purges.request(f.owner.principal, dirty.id, f.purgeRequest()),
  ).rejects.toMatchObject({ failure: { code: 'resource_busy' } });
  await f.db
    .update(machines)
    .set({ state: { kind: 'destroyed', destroyedAt: new Date().toISOString() } })
    .where(eq(machines.id, f.machineId));
  const purge = await f.service.purges.request(f.owner.principal, dirty.id, f.purgeRequest());
  let effects = 0;
  const worker = createBackupRetention({
    connection: database.connection,
    deleter: {
      purge: () => {
        effects++;
        return Promise.resolve({ kind: 'absent' });
      },
    },
  });
  await withBackupWorkerLock({
    pool: database.connection.pool,
    work: async () => {
      expect((await worker.advance(purge.id)).kind).toBe('busy');
    },
  });
  expect(effects).toBe(0);
});

it('prunes expired scheduled points only after seven newer successful days, preserving manual backups and failures', async () => {
  const f = await fixture();
  const oldest = await f.capture({ daysAgo: 20, scheduled: true });
  const manual = await f.capture({ daysAgo: 21 });
  const differentFiles = await f.capture({
    daysAgo: 22,
    scheduled: true,
    files: ['important.txt'],
  });
  for (const daysAgo of [9, 8, 7, 6, 5, 4]) await f.capture({ daysAgo, scheduled: true });
  await f.capture({ daysAgo: 0, scheduled: true, failed: true });
  await f.capture({ daysAgo: 1 });
  await f.capture({ daysAgo: 4, scheduled: true }); // Same day cannot substitute for another daily recovery point.
  expect(await admitExpiredBackup(f.db, oldest.id)).toBeNull();
  await f.capture({ daysAgo: 3, scheduled: true });
  const attempts = await Promise.all([
    admitExpiredBackup(f.db, oldest.id),
    admitExpiredBackup(f.db, oldest.id),
  ]);
  expect(attempts.filter(Boolean)).toHaveLength(1);
  expect(await admitExpiredBackup(f.db, manual.id)).toBeNull();
  expect(await admitExpiredBackup(f.db, differentFiles.id)).toBeNull();
  const anotherEligible = await f.capture({ daysAgo: 19, scheduled: true });
  const worker = createBackupRetention({
    connection: database.connection,
    deleter: { purge: () => Promise.resolve({ kind: 'absent' }) },
  });
  // An older unmatched recipe cannot starve eligible captures in a bounded operator run.
  expect(
    (await worker.run({ maxObjects: 1, maxRunSeconds: 60, pruneScheduled: true })).admitted,
  ).toBe(1);
  expect(backupRecord(await f.row(anotherEligible.id)).state.kind).toBe('purge_pending');
  await worker.run({ maxObjects: 1, maxRunSeconds: 60, pruneScheduled: true });
  expect(backupRecord(await f.row(anotherEligible.id)).state.kind).toBe('purged');
  expect(backupRecord(await f.row(oldest.id)).state.kind).toBe('purged');
  const captured = (await f.db.select().from(backups))
    .map(backupRecord)
    .filter((row) => row.state.kind === 'captured');
  expect(captured).toHaveLength(11);
  expect(captured.some((row) => row.id === manual.id)).toBe(true);
});

it('does not requeue ordinary capture work after a destroyed-source purge', async () => {
  const f = await fixture();
  const backup = await f.capture({ pendingCleanup: true });
  await f.db
    .update(machines)
    .set({ state: { kind: 'destroyed', destroyedAt: new Date().toISOString() } })
    .where(eq(machines.id, f.machineId));
  await f.service.purges.request(f.owner.principal, backup.id, f.purgeRequest());
  await enqueueBackup(f.db, 'backup', backup.id);
  await runOnce({
    pgPool: database.connection.pool,
    concurrency: 1,
    noHandleSignals: true,
    taskList: createTasks({
      connection: database.connection,
      backups: f.service,
      limits: { currency: 'EUR', maxMachines: 20, maxHourlyMicros: 1_000_000 },
      provider: new SimulatedProvider({ db: f.db, catalog: () => simulatedCatalog('EUR') }),
    }),
  });
  // Graphile starts completion asynchronously; wait for deletion rather than racing its acknowledgement.
  await expect
    .poll(
      async () =>
        (
          await database.connection.pool.query<{ id: string }>(
            'SELECT id FROM graphile_worker.jobs WHERE key = $1',
            [`backup:${backup.id}`],
          )
        ).rows,
      { timeout: 2000, interval: 20 },
    )
    .toHaveLength(0);
});

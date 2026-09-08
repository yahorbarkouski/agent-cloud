import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { serve } from '@hono/node-server';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  backupScheduleRequestSchema,
  backupScheduleResponseSchema,
  backupSchedulesResponseSchema,
  backupSummarySchema,
  newId,
  simulatedCatalog,
} from '../packages/contracts/src/index.js';
import {
  allocations,
  backups,
  backupSchedules,
  backupScheduleRuns,
  grants,
  machines,
} from '../packages/db/src/index.js';
import { createBackups } from '../apps/control/src/backups.js';
import { createApp } from '../apps/control/src/app.js';
import { issueGrant } from '../apps/control/src/auth.js';
import { backupControlConfigSchema } from '../apps/control/src/backup-records.js';
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
  const owner = await seedAccount(database.connection.db);
  const machineId = newId.machine();
  const allocationId = newId.allocation();
  await database.connection.db.insert(machines).values({
    id: machineId,
    accountId: owner.principal.accountId,
    projectId: owner.projectId,
    name: 'daily-source',
    provider: 'simulated',
    spec: { name: 'daily-source', size: 'small', region: 'fsn1' },
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
  await database.connection.db.insert(allocations).values({
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
    directory: '/tmp/schedule-admission-fixture',
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
    maxAccountBytes: 2_097_152,
    maxGlobalBytes: 4_194_304,
  });
  const service = () =>
    createBackups({ db: database.connection.db, config, advance: async () => {} });
  const control = service();
  const app = createApp({
    db: database.connection.db,
    provider: 'simulated',
    catalog: () => simulatedCatalog('EUR'),
    limits: { currency: 'EUR', maxMachines: 20, maxHourlyMicros: 1_000_000 },
    backups: control,
  });
  const request = backupScheduleRequestSchema.parse({
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
  const due = (id = request.id) =>
    database.connection.db
      .update(backupSchedules)
      .set({ nextRunAt: new Date(Date.now() - 3 * 86_400_000) })
      .where(eq(backupSchedules.id, id));
  return { owner, machineId, request, service, control, app, due };
}

it('runs one admission after the real CLI exits, survives scheduler reconstruction and disables idempotently', async () => {
  const f = await fixture();
  const scratch = await mkdtemp(join(tmpdir(), 'backup-schedule-cli-'));
  const server = serve({ fetch: f.app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture listener missing.');
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
    const args = [
      'backup',
      'schedule',
      f.machineId,
      'sample',
      '--id',
      f.request.id,
      '--release',
      f.request.recipe.releaseId,
      '--service',
      'database',
      '--database',
      'reference',
      '--user',
      'reference',
    ];
    const first = backupScheduleResponseSchema.parse(JSON.parse(await cli(args))).schedule;
    expect(first.lastAttempt.kind).toBe('none');
    // The CLI process has exited. Competing/restarted schedulers share durable admission.
    await Promise.all([f.service().schedules.reconcile(), f.service().schedules.reconcile()]);
    const observed = backupScheduleResponseSchema.parse(
      JSON.parse(await cli(['backup', 'schedule-inspect', first.id])),
    ).schedule;
    expect(observed.lastAttempt.kind).toBe('admitted');
    expect(observed.state.kind).toBe('enabled');
    if (observed.state.kind !== 'enabled') throw new Error('Expected enabled schedule.');
    expect(Date.parse(observed.state.nextRunAt) - Date.now()).toBeGreaterThan(86_000_000);
    expect(await database.connection.db.select().from(backups)).toHaveLength(1);
    expect(await database.connection.db.select().from(backupScheduleRuns)).toHaveLength(1);
    expect(backupScheduleResponseSchema.parse(JSON.parse(await cli(args))).schedule).toEqual(
      observed,
    );
    const listed = backupSchedulesResponseSchema.parse(
      JSON.parse(await cli(['backup', 'schedule-list', f.machineId])),
    );
    expect(listed.schedules).toEqual([observed]);
    await expect(
      f.control.schedules.create(f.owner.principal, f.machineId, {
        ...f.request,
        recipe: { ...f.request.recipe, releaseId: randomUUID() },
      }),
    ).rejects.toMatchObject({ failure: { code: 'idempotency_conflict' } });
    const disabled = backupScheduleResponseSchema.parse(
      JSON.parse(await cli(['backup', 'schedule-disable', first.id])),
    ).schedule;
    expect(disabled.state.kind).toBe('disabled');
    expect(
      backupScheduleResponseSchema.parse(
        JSON.parse(await cli(['backup', 'schedule-disable', first.id])),
      ).schedule,
    ).toEqual(disabled);
    await f.due();
    await f.service().schedules.reconcile();
    expect(await database.connection.db.select().from(backups)).toHaveLength(1);
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

it('keeps the last good recovery point after failed capture and quota refusal, without outage catch-up bursts', async () => {
  const f = await fixture();
  await f.control.schedules.create(f.owner.principal, f.machineId, f.request);
  await f.control.schedules.advance(f.request.id);
  const initial = await f.control.schedules.inspect(f.owner.principal, f.request.id);
  if (initial.lastAttempt.kind !== 'admitted') throw new Error('Missing scheduled admission.');
  const first = initial.lastAttempt.backup;
  // Simulate the existing capture worker's terminal receipts; cryptography/restore run in their own integration scenario.
  const captured = backupSummarySchema.parse({
    ...first,
    state: {
      kind: 'captured',
      bytes: 16,
      capturedAt: first.createdAt,
      validation: 'captured',
      manifest: {
        version: 1,
        recipe: f.request.recipe,
        capturedAt: first.createdAt,
        completedAt: first.createdAt,
        postgresVersion: '17.11',
        sourceFiles: 1,
        declaredFiles: [],
        consistency: 'database-consistent-files-best-effort',
        exclusions: [],
      },
    },
  });
  await database.connection.db
    .update(backups)
    .set({ record: captured, reservedBytes: 16 })
    .where(eq(backups.id, first.id));
  await f.due();
  await Promise.all([f.service().schedules.reconcile(), f.service().schedules.reconcile()]);
  const second = await f.control.schedules.inspect(f.owner.principal, f.request.id);
  if (second.lastAttempt.kind !== 'admitted') throw new Error('Missing second admission.');
  const failed = {
    ...second.lastAttempt.backup,
    state: { kind: 'blocked', reason: 'Guest capture failed.' },
  };
  await database.connection.db
    .update(backups)
    .set({ record: failed })
    .where(eq(backups.id, failed.id));
  const degraded = await f.control.schedules.inspect(f.owner.principal, f.request.id);
  expect(degraded.lastSuccessfulBackup).toEqual(captured);
  expect(degraded.lastAttempt).toMatchObject({
    kind: 'admitted',
    backup: { state: { kind: 'blocked' } },
  });
  await f.due();
  await f.control.schedules.reconcile();
  const refused = await f.control.schedules.inspect(f.owner.principal, f.request.id);
  expect(refused.lastAttempt).toMatchObject({
    kind: 'refused',
    failure: { code: 'quota_exceeded' },
  });
  expect(refused.lastSuccessfulBackup).toEqual(captured);
  expect(await database.connection.db.select().from(backups)).toHaveLength(2);
});

it('rechecks revoked authority, keeps account boundaries and never follows a replacement allocation', async () => {
  const f = await fixture();
  const foreign = await seedAccount(database.connection.db);
  await f.control.schedules.create(f.owner.principal, f.machineId, f.request);
  const reader = await issueGrant(database.connection.db, {
    principal: f.owner.principal,
    name: 'backup-reader',
    policy: { ...f.owner.principal.policy, capabilities: ['backup:read'] },
    expiresAt: new Date(Date.now() + 60_000),
  });
  const readOnly = {
    ...f.owner.principal,
    grantId: reader.id,
    policy: {
      ...f.owner.principal.policy,
      capabilities: ['backup:read'] satisfies Array<'backup:read'>,
    },
  };
  expect((await f.control.schedules.inspect(readOnly, f.request.id)).id).toBe(f.request.id);
  await expect(f.control.schedules.disable(readOnly, f.request.id)).rejects.toMatchObject({
    failure: { code: 'permission_denied' },
  });
  await expect(f.control.schedules.create(readOnly, f.machineId, f.request)).rejects.toMatchObject({
    failure: { code: 'permission_denied' },
  });
  await expect(f.control.schedules.inspect(foreign.principal, f.request.id)).rejects.toMatchObject({
    failure: { code: 'not_found' },
  });
  await expect(f.control.schedules.disable(foreign.principal, f.request.id)).rejects.toMatchObject({
    failure: { code: 'not_found' },
  });
  await expect(
    f.control.schedules.create(foreign.principal, f.machineId, f.request),
  ).rejects.toMatchObject({ failure: { code: 'idempotency_conflict' } });
  await database.connection.db
    .update(grants)
    .set({ revokedAt: new Date() })
    .where(eq(grants.id, f.owner.principal.grantId));
  await f.service().schedules.reconcile();
  const [row] = await database.connection.db.select().from(backupSchedules);
  expect(row?.disabledAt).toBeInstanceOf(Date);
  expect(row?.lastAttempt).toMatchObject({ kind: 'refused', failure: { code: 'unauthenticated' } });
  expect(await database.connection.db.select().from(backups)).toHaveLength(0);
  await expect(
    f.control.schedules.create(f.owner.principal, f.machineId, f.request),
  ).rejects.toMatchObject({ failure: { code: 'unauthenticated' } });
  // Fresh authorized schedule must not capture a later allocation occupying the same machine record.
  await database.connection.db
    .update(grants)
    .set({ revokedAt: null })
    .where(eq(grants.id, f.owner.principal.grantId));
  const replacement = {
    ...f.request,
    id: backupScheduleRequestSchema.shape.id.parse(randomUUID()),
  };
  await f.control.schedules.create(f.owner.principal, f.machineId, replacement);
  await database.connection.db.execute(
    sql`UPDATE machines SET state=jsonb_set(state, '{allocationId}', ${JSON.stringify(newId.allocation())}::jsonb) WHERE id=${f.machineId}`,
  );
  await f.control.schedules.reconcile();
  expect(
    (await f.control.schedules.inspect(f.owner.principal, replacement.id)).lastAttempt,
  ).toMatchObject({ kind: 'refused', failure: { code: 'resource_busy' } });
  expect(await database.connection.db.select().from(backups)).toHaveLength(0);
});

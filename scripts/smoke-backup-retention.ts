import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { setTimeout } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import { serve } from '@hono/node-server';
import { z } from 'zod';
import {
  backupResponseSchema,
  usageResponseSchema,
  backupPurgeResponseSchema,
  newId,
  simulatedCatalog,
} from '../packages/contracts/dist/index.js';
import { allocations, backups, machines } from '../packages/db/src/index.js';
import {
  createBackupReader,
  createBackupWriter,
  backupStoreCredentialsSchema,
} from '../packages/backup-store/dist/index.js';
import { createBackups } from '../apps/control/src/backups.js';
import { createBackupWorker, type WithBackupGuest } from '../apps/control/src/backup-work.js';
import {
  backupControlConfigSchema,
  backupRecord,
  backupWorkSchema,
} from '../apps/control/src/backup-records.js';
import { backupKeyringSchema } from '../apps/control/src/backup-crypto.js';
import { createApp } from '../apps/control/src/app.js';
import { prepareProtectedStoreFixture } from './support/backup-store-fixture.js';
import { seedAccount, testDatabase } from '../tests/database.js';
import { createControlRecoveryVerifiers } from '../apps/control/src/control-recovery-verifiers.js';
import { readConfig } from '../apps/control/src/config.js';

const recoveryScenario = process.env.AGENT_CLOUD_BACKUP_RECOVERY_SCENARIO === '1';
const scratch = await mkdtemp(join(tmpdir(), 'acld-retention-cli-'));
const database = await testDatabase();
const controlPath = await database.controlIdentity();
let fixture: Awaited<ReturnType<typeof prepareProtectedStoreFixture>> | undefined;
let writer: ReturnType<typeof createBackupWriter> | undefined;
let reader: ReturnType<typeof createBackupReader> | undefined;
let server: ReturnType<typeof serve> | undefined;
let stage = 'local storage setup';
try {
  fixture = await prepareProtectedStoreFixture({ scratch });
  const config = backupControlConfigSchema.parse(
    JSON.parse(await readFile(fixture.configFile, 'utf8')),
  );
  writer = createBackupWriter(
    config.store,
    backupStoreCredentialsSchema.parse(
      JSON.parse(await readFile(config.writerCredentialsFile, 'utf8')),
    ),
  );
  reader = createBackupReader(
    config.store,
    backupStoreCredentialsSchema.parse(
      JSON.parse(await readFile(config.readerCredentialsFile, 'utf8')),
    ),
  );
  const owner = await seedAccount(database.connection.db);
  const machineId = newId.machine();
  const allocationId = newId.allocation();
  const offer = simulatedCatalog('EUR').items[0];
  assert.ok(offer);
  await database.connection.db.insert(machines).values({
    id: machineId,
    accountId: owner.principal.accountId,
    projectId: owner.projectId,
    name: 'retention-source',
    provider: 'simulated',
    spec: { name: 'retention-source', size: 'small', region: 'fsn1' },
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
  // This fixture exercises encryption/storage/CLI, not a PostgreSQL guest. Native capture/restore has its own smoke.
  const bytes = Buffer.from(
    'fixture archive bytes for the real retention CLI and protected S3 path',
  );
  const withGuest: WithBackupGuest = (_scope, work) =>
    work({
      capture: (request) =>
        Promise.resolve({
          kind: 'captured',
          id: request.id,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          manifest: {
            version: 1,
            recipe: request.recipe,
            capturedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            postgresVersion: '17-fixture',
            sourceFiles: 1,
            declaredFiles: [],
            consistency: 'database-consistent-files-best-effort',
            exclusions: ['This fixture does not execute PostgreSQL.'],
          },
        }),
      read: (_id, _maximum, callback) => callback(Readable.from([bytes])),
      remove: () => Promise.resolve(),
      restore: () => Promise.reject(new Error('Retention smoke does not restore a guest.')),
      inspectRestore: () => Promise.resolve(null),
    });
  const storageWriter = writer;
  const worker = createBackupWorker({
    connection: database.connection,
    config,
    writer: {
      ...writer,
      upload: async (input) => {
        const receipt = await storageWriter.upload(input);
        if (recoveryScenario) throw new Error('Fixture lost upload acknowledgement');
        return receipt;
      },
    },
    reader,
    withGuest,
    keyring: async () =>
      backupKeyringSchema.parse(JSON.parse(await readFile(config.keyringFile, 'utf8'))),
  });
  const service = createBackups({ db: database.connection.db, config, advance: worker.advance });
  const app = createApp({
    db: database.connection.db,
    provider: 'simulated',
    catalog: () => simulatedCatalog('EUR'),
    limits: { currency: 'EUR', maxMachines: 20, maxHourlyMicros: 1_000_000 },
    backups: service,
  });
  server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await new Promise<void>((resolve) => server?.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const credentials = join(scratch, 'credentials.json');
  await writeFile(
    credentials,
    JSON.stringify({ server: `http://127.0.0.1:${address.port}`, token: owner.token }),
    { mode: 0o600 },
  );
  const cli = async (args: string[]) => {
    try {
      return (
        await promisify(execFile)(process.execPath, ['apps/cli/dist/index.js', ...args], {
          env: { ACLD_CREDENTIALS: credentials },
          timeout: 10_000,
          maxBuffer: 65_536,
        })
      ).stdout;
    } catch {
      throw new Error('Retention fixture CLI failed.');
    }
  };
  stage = 'CLI capture and actual encrypted protected upload';
  const id = randomUUID();
  const captured = backupResponseSchema.parse(
    JSON.parse(
      await cli([
        'backup',
        'capture',
        machineId,
        'sample',
        '--id',
        id,
        '--release',
        randomUUID(),
        '--service',
        'database',
        '--database',
        'sample',
        '--user',
        'sample',
      ]),
    ),
  ).backup;
  // Shorten only this isolated fixture's admitted deadline before upload. Production requires >= 1 day.
  const retainUntil = new Date(Math.ceil((Date.now() + 12_000) / 1000) * 1000).toISOString();
  await database.connection.db
    .update(backups)
    .set({ record: { ...captured, retainUntil } })
    .where(eq(backups.id, id));
  if (recoveryScenario) {
    await assert.rejects(worker.advance('backup', id), /lost upload acknowledgement/);
    const [pending] = await database.connection.db.select().from(backups).where(eq(backups.id, id));
    assert.ok(pending);
    const pendingWork = backupWorkSchema.parse(pending.work);
    assert.equal(pendingWork.kind, 'upload_submitted');
    await database.connection.db
      .update(backups)
      .set({ work: { ...pendingWork, attempts: 5 } })
      .where(eq(backups.id, id));
    await worker.advance('backup', id);
    assert.equal((await service.inspect(owner.principal, id)).state.kind, 'blocked');
    while (Date.now() <= Date.parse(retainUntil) + 500) await setTimeout(100);
    stage = 'operator CLI recovery after protection expiry without repeating PUT';
    const operator = async (args: string[], configured = false) => {
      try {
        return (
          await promisify(execFile)(
            process.execPath,
            ['--import', 'tsx', 'scripts/backup-recover.ts', ...args],
            {
              env: {
                DATABASE_URL: database.databaseUrl,
                ACLD_CONTROL_GENERATION_FILE: controlPath,
                ...(configured ? { ACLD_BACKUP_CONFIG: fixture?.configFile } : {}),
              },
              timeout: 30_000,
              maxBuffer: 65536,
            },
          )
        ).stdout;
      } catch {
        throw new Error('Operator backup recovery CLI failed.');
      }
    };
    const inspected = z
      .object({
        receiptDigest: z.string().regex(/^[a-f0-9]{64}$/),
        canResolveUpload: z.literal(true),
      })
      .parse(JSON.parse(await operator(['inspect', id])));
    const recoveryRequest = join(scratch, 'recovery-request.json');
    await writeFile(
      recoveryRequest,
      JSON.stringify({ backupId: id, expectedReceiptDigest: inspected.receiptDigest }),
      { mode: 0o600 },
    );
    // Recovery only needs read/list privileges and the persisted envelope, not the wrapping key or reader file.
    await Promise.all([config.readerCredentialsFile, config.keyringFile].map((path) => rm(path)));
    const recovered = backupResponseSchema.parse(
      JSON.parse(await operator(['apply', recoveryRequest], true)),
    ).backup;
    assert.equal(recovered.state.kind, 'captured');
    assert.deepEqual(
      backupResponseSchema.parse(JSON.parse(await operator(['apply', recoveryRequest], true)))
        .backup,
      recovered,
    );
    await worker.advance('backup', id);
  } else await worker.advance('backup', id);
  const result = backupResponseSchema.parse(
    JSON.parse(await cli(['backup', 'inspect', id])),
  ).backup;
  assert.equal(result.state.kind, 'captured');
  const [row] = await database.connection.db.select().from(backups).where(eq(backups.id, id));
  assert.ok(row);
  const work = backupWorkSchema.parse(row.work);
  assert.equal(work.kind, 'stored');
  await reader.inspect(work.receipt);
  const controlVerifiers = createControlRecoveryVerifiers({
    connection: database.connection,
    config: readConfig({
      DATABASE_URL: database.databaseUrl,
      ACLD_BACKUP_CONFIG: fixture.configFile,
    }),
  });
  try {
    const verified = await controlVerifiers.verifyBackup({
      backupId: row.id,
      accountId: row.accountId,
      record: backupRecord(row),
      work,
    });
    // The uncertain-upload scenario deliberately removed the reader credential above.
    assert.equal(verified.ok, !recoveryScenario);
  } finally {
    controlVerifiers.close();
  }
  const retainedUsage = usageResponseSchema.parse(JSON.parse(await cli(['usage']))).usage.backups;
  assert.equal(retainedUsage.reservedBytes, row.reservedBytes);
  assert.equal(retainedUsage.retainedCount, 1);
  assert.equal(retainedUsage.limits?.maxAccountBytes, config.maxAccountBytes);
  stage = recoveryScenario
    ? 'purge after expired upload recovery'
    : 'CLI purge and separate retention process while Object Lock is active';
  const purgeId = randomUUID();
  await cli(['backup', 'purge', id, '--id', purgeId, '--allow-data-loss']);
  assert.equal(
    usageResponseSchema.parse(JSON.parse(await cli(['usage']))).usage.backups.purgePendingCount,
    1,
  );
  const retentionConfig = join(scratch, 'retention.json');
  await writeFile(
    retentionConfig,
    JSON.stringify({
      version: 1,
      store: config.store,
      deleterCredentialsFile: fixture.deleterCredentialsFile,
      pruneScheduled: true,
      maxObjects: 20,
      maxRunSeconds: 60,
    }),
    { mode: 0o600 },
  );
  const run = async () => {
    try {
      const result = await promisify(execFile)(
        process.execPath,
        ['apps/control/dist/backup-retention-main.js'],
        {
          env: {
            DATABASE_URL: database.databaseUrl,
            ACLD_CONTROL_GENERATION_FILE: controlPath,
            ACLD_BACKUP_RETENTION_CONFIG: retentionConfig,
          },
          timeout: 30_000,
          maxBuffer: 4096,
        },
      );
      return z
        .object({
          event: z.literal('backup.retention_finished'),
          admitted: z.int(),
          advanced: z.int(),
        })
        .parse(JSON.parse(result.stdout));
    } catch {
      throw new Error('Separate retention process failed.');
    }
  };
  if (!recoveryScenario) {
    assert.equal((await run()).advanced, 0);
    assert.equal((await service.purges.inspect(owner.principal, purgeId)).state.kind, 'waiting');
    await reader.inspect(work.receipt);
  }
  // Retention must not load writer, reader or wrapping-key files.
  writer.close();
  reader.close();
  await Promise.all(
    [config.writerCredentialsFile, config.readerCredentialsFile, config.keyringFile].map((path) =>
      rm(path, { force: true }),
    ),
  );
  while (Date.now() <= Date.parse(retainUntil) + 500) await setTimeout(100);
  stage = 'expired exact-version deletion and CLI reconnect';
  assert.equal((await run()).advanced, 1);
  const purged = backupPurgeResponseSchema.parse(
    JSON.parse(await cli(['backup', 'purge-inspect', purgeId])),
  ).purge;
  assert.equal(purged.state.kind, 'purged');
  const [after] = await database.connection.db.select().from(backups).where(eq(backups.id, id));
  assert.ok(after);
  assert.equal(after.reservedBytes, 0);
  assert.deepEqual(usageResponseSchema.parse(JSON.parse(await cli(['usage']))).usage.backups, {
    ...retainedUsage,
    reservedBytes: 0,
    retainedCount: 0,
    purgePendingCount: 0,
    limits: { ...retainedUsage.limits, remainingBytes: config.maxAccountBytes },
  });
  assert.equal(backupRecord(after).state.kind, 'purged');
  assert.equal((await run()).advanced, 0);
  process.stdout.write(
    JSON.stringify({
      cliCapture: true,
      encryptedProtectedUpload: true,
      purgeAfterCliExit: true,
      separateDeletionProcess: true,
      ...(recoveryScenario ? { recoveredExpiredUpload: true } : { retentionEnforced: true }),
      exactVersionAbsent: true,
      reservedBytes: 0,
      providerResourcesCreated: 0,
    }) + '\n',
  );
} catch {
  process.stderr.write(`Backup retention smoke failed during ${stage}.\n`);
  process.exitCode = 1;
} finally {
  writer?.close();
  reader?.close();
  if (server) {
    if ('closeAllConnections' in server) server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server?.close(() => {
        resolve();
      }),
    );
  }
  await fixture?.stop();
  await database.close();
  await rm(scratch, { recursive: true, force: true });
}

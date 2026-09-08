import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  backupCaptureRequestSchema,
  backupResponseSchema,
  restoreRequestSchema,
  restoreResponseSchema,
  newId,
  simulatedCatalog,
  restoreCompletedStateSchema,
  type RestoreGuestRequest,
} from '../packages/contracts/src/index.js';
import {
  allocations,
  backups,
  backupRestores,
  grants,
  machines,
  operations,
} from '../packages/db/src/index.js';
import {
  backupObjectReceiptSchema,
  backupUploadIntentSchema,
} from '../packages/backup-store/src/index.js';
import { createApp } from '../apps/control/src/app.js';
import { createBackups, assertRestoreAccessible } from '../apps/control/src/backups.js';
import {
  createBackupWorker,
  type BackupGuest,
  type WithBackupGuest,
} from '../apps/control/src/backup-work.js';
import { createBackupRecovery } from '../apps/control/src/backup-recovery.js';
import {
  backupControlConfigSchema,
  backupRecord,
  backupWorkSchema,
} from '../apps/control/src/backup-records.js';
import { seedAccount, testDatabase } from './database.js';

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let owner: Awaited<ReturnType<typeof seedAccount>>;
let foreign: Awaited<ReturnType<typeof seedAccount>>;
let directory: string;
let machineId: ReturnType<typeof newId.machine>;
let service: ReturnType<typeof createBackups>;
let app: ReturnType<typeof createApp>;
let worker: ReturnType<typeof createBackupWorker>;
const plaintext = Buffer.from('fixture PostgreSQL custom dump and declared file bytes');
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const objects = new Map<
  string,
  { bytes: Buffer; receipt: ReturnType<typeof backupObjectReceiptSchema.parse> }
>();
const effects = { captures: 0, uploads: 0, restores: 0, cleanup: 0 };
let loseUploadReply = true;
let loseRestoreReply = true;
let failRestorePreparation = true;
let restored: ReturnType<typeof restoreCompletedStateSchema.parse> | undefined;
let blockCapture: Promise<void> | undefined;
let availableScratchBytes = 8_589_934_592n;
let readEffects = 0;
let downloadEffects = 0;
const guest: BackupGuest = {
  capture: async (request) => {
    effects.captures++;
    if (blockCapture) await blockCapture;
    return {
      kind: 'captured',
      id: request.id,
      bytes: plaintext.length,
      sha256: sha256(plaintext),
      manifest: {
        version: 1,
        recipe: request.recipe,
        capturedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        postgresVersion: '17.7',
        sourceFiles: 1,
        declaredFiles: [],
        consistency: 'database-consistent-files-best-effort',
        exclusions: ['Only the declared recipe is captured.'],
      },
    };
  },
  read: (_id, _maximum, work) => {
    readEffects++;
    return work(Readable.from([plaintext]));
  },
  remove: () => {
    effects.cleanup++;
    return Promise.resolve();
  },
  restore: async (
    request: RestoreGuestRequest,
    source: Readable,
    beforeSubmit: () => Promise<void>,
  ) => {
    if (failRestorePreparation) {
      failRestorePreparation = false;
      throw new Error('Credential preparation failed before submission');
    }
    await beforeSubmit();
    effects.restores++;
    const chunks: Buffer[] = [];
    for await (const chunk of source) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Expected binary restore.');
      chunks.push(chunk);
    }
    expect(Buffer.concat(chunks)).toEqual(plaintext);
    restored = restoreCompletedStateSchema.parse({
      kind: 'restored',
      id: request.id,
      app: request.app,
      releaseId: randomUUID(),
      postgresVersion: '17.7',
      integrity: 'database-restored-services-healthy',
    });
    if (loseRestoreReply) {
      loseRestoreReply = false;
      throw new Error('Lost guest reply');
    }
    return restored;
  },
  inspectRestore: () => Promise.resolve(restored ?? null),
};
const withGuest: WithBackupGuest = (_scope, work) => work(guest);
const failure = (code: string) => ({ failure: { code } });
const request = () =>
  backupCaptureRequestSchema.parse({
    id: randomUUID(),
    recipe: {
      kind: 'compose-postgres',
      app: 'sample',
      releaseId: randomUUID(),
      service: 'database',
      database: 'app',
      user: 'app',
      files: [],
    },
  });

beforeAll(async () => {
  fixture = await testDatabase();
  owner = await seedAccount(fixture.connection.db);
  foreign = await seedAccount(fixture.connection.db);
  directory = await mkdtemp(join(tmpdir(), 'backup-control-'));
  machineId = newId.machine();
  const allocationId = newId.allocation();
  const offer = simulatedCatalog('EUR').items[0];
  if (!offer) throw new Error('Missing fixture offer.');
  await fixture.connection.db.insert(machines).values({
    id: machineId,
    accountId: owner.principal.accountId,
    projectId: owner.projectId,
    name: 'source',
    provider: 'simulated',
    spec: { name: 'source', size: 'small', region: 'fsn1' },
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
  await fixture.connection.db.insert(allocations).values({
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
    directory,
    store: {
      endpoint: 'http://127.0.0.1:9000',
      region: 'local',
      bucket: 'backups',
      keyPrefix: 'backups',
      maxBytes: 1_048_576,
    },
    writerCredentialsFile: '/operator/writer',
    readerCredentialsFile: '/operator/reader',
    keyringFile: '/operator/keys',
    limits: { maxBytes: 1_048_576, timeoutSeconds: 30 },
    maxGlobalBytes: 10_485_760,
  });
  const keyring = { current: 'v1', keys: { v1: randomBytes(32).toString('base64') } };
  worker = createBackupWorker({
    connection: fixture.connection,
    config,
    withGuest,
    availableScratchBytes: () => Promise.resolve(availableScratchBytes),
    keyring: () => Promise.resolve(keyring),
    writer: {
      checkProtection: () =>
        Promise.resolve({
          storeId: 'a'.repeat(64),
          bucket: 'backups',
          versioning: true,
          objectLock: true,
        }),
      prepareUpload: async ({ attemptId, file, retention }) => {
        const bytes = await readFile(file);
        return backupUploadIntentSchema.parse({
          storeId: 'a'.repeat(64),
          bucket: 'backups',
          key: `backups/${attemptId}.enc`,
          attemptId,
          ciphertextSha256: sha256(bytes),
          contentMd5: createHash('md5').update(bytes).digest('base64'),
          size: bytes.length,
          retention,
        });
      },
      upload: async ({ intent, file }) => {
        effects.uploads++;
        const bytes = await readFile(file);
        expect(bytes).not.toEqual(plaintext);
        const receipt = backupObjectReceiptSchema.parse({ ...intent, versionId: randomUUID() });
        objects.set(intent.attemptId, { bytes, receipt });
        if (loseUploadReply) {
          loseUploadReply = false;
          throw new Error('Lost S3 reply');
        }
        return receipt;
      },
      recover: (intent) => {
        const object = objects.get(intent.attemptId);
        return Promise.resolve(
          object ? { kind: 'found', receipt: object.receipt } : { kind: 'unresolved' },
        );
      },
      close: () => {},
    },
    reader: {
      checkProtection: () =>
        Promise.resolve({
          storeId: 'a'.repeat(64),
          bucket: 'backups',
          versioning: true,
          objectLock: true,
        }),
      inspect: (receipt) => Promise.resolve(receipt),
      download: async ({ receipt, destination }) => {
        downloadEffects++;
        const object = objects.get(receipt.attemptId);
        if (!object) throw new Error('Object missing');
        await writeFile(destination, object.bytes, { flag: 'wx', mode: 0o600 });
        return receipt;
      },
      close: () => {},
    },
  });
  service = createBackups({ db: fixture.connection.db, config, advance: worker.advance });
  app = createApp({
    db: fixture.connection.db,
    provider: 'simulated',
    catalog: () => simulatedCatalog('EUR'),
    limits: { currency: 'EUR', maxMachines: 20, maxHourlyMicros: 1_000_000 },
    backups: service,
  });
});
afterAll(async () => {
  await fixture.close();
  await rm(directory, { recursive: true, force: true });
});
async function api(path: string, body?: unknown) {
  return app.request(path, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' },
  });
}

it('captures through the authenticated API, resolves a lost upload without repeating it, and restores after source destruction into a quarantined new machine', async () => {
  const capture = request();
  const responses = await Promise.all([
    api(`/v1/machines/${machineId}/backups`, capture),
    api(`/v1/machines/${machineId}/backups`, capture),
  ]);
  expect(responses.map((response) => response.status)).toEqual([202, 202]);
  const admitted = backupResponseSchema.parse(await responses[0].json()).backup;
  expect(admitted.state.kind).toBe('pending');
  await expect(
    service.capture(owner.principal, machineId, {
      ...capture,
      recipe: { ...capture.recipe, database: 'different' },
    }),
  ).rejects.toMatchObject(failure('idempotency_conflict'));
  await expect(service.inspect(foreign.principal, capture.id)).rejects.toMatchObject(
    failure('not_found'),
  );
  await expect(worker.advance('backup', capture.id)).rejects.toThrow('Lost S3 reply');
  await worker.advance('backup', capture.id);
  expect(effects).toEqual({ captures: 1, uploads: 1, restores: 0, cleanup: 1 });
  expect((await service.inspect(owner.principal, capture.id)).state.kind).toBe('captured');
  // The source's lifecycle cleanup is independently verified elsewhere. Retiring it here proves restore never contacts it.
  await fixture.connection.db
    .update(machines)
    .set({ state: { kind: 'destroyed', destroyedAt: new Date().toISOString() } })
    .where(eq(machines.id, machineId));
  await fixture.connection.db
    .update(allocations)
    .set({ retiredAt: new Date() })
    .where(eq(allocations.machineId, machineId));
  const restore = restoreRequestSchema.parse({
    id: randomUUID(),
    backupId: capture.id,
    app: 'recovered',
    machine: { name: 'isolated-restore', size: 'small', region: 'fsn1' },
  });
  const response = await api('/v1/restores', restore);
  expect(response.status).toBe(202);
  const target = restoreResponseSchema.parse(await response.json()).restore;
  expect(target.machineId).not.toBe(machineId);
  await expect(
    assertRestoreAccessible(fixture.connection.db, target.machineId),
  ).rejects.toMatchObject(failure('resource_busy'));
  const [allocation] = await fixture.connection.db
    .select()
    .from(allocations)
    .where(eq(allocations.machineId, target.machineId));
  if (!allocation) throw new Error('Restore did not reserve its new VM.');
  await fixture.connection.db
    .update(machines)
    .set({
      state: {
        kind: 'allocated',
        allocationId: allocation.id,
        serverId: '2',
        power: 'running',
        guest: {
          kind: 'ssh',
          verifiedAt: new Date().toISOString(),
          imageVersion: 'fixture',
          manifestDigest: 'a'.repeat(64),
          bootId: randomUUID(),
        },
      },
    })
    .where(eq(machines.id, target.machineId));
  await fixture.connection.db
    .update(operations)
    .set({ progress: { kind: 'succeeded', completedAt: new Date().toISOString() } })
    .where(eq(operations.id, target.operationId));
  await expect(worker.advance('restore', restore.id)).rejects.toThrow(
    'Credential preparation failed before submission',
  );
  const [retryable] = await fixture.connection.db
    .select()
    .from(backupRestores)
    .where(eq(backupRestores.id, restore.id));
  expect(retryable?.work).toMatchObject({ kind: 'prepare' });
  expect(effects.restores).toBe(0);
  await expect(worker.advance('restore', restore.id)).rejects.toThrow('Lost guest reply');
  const restoreDirectory = join(directory, `restore-${restore.id}`);
  // Model files left by a worker killed after authenticated decryption and remote submission.
  await writeFile(join(restoreDirectory, `archive.tar.${'a'.repeat(32)}.partial`), plaintext, {
    mode: 0o600,
  });
  await writeFile(join(restoreDirectory, 'archive.tar'), plaintext, { mode: 0o600 });
  await worker.advance('restore', restore.id);
  expect(await readdir(restoreDirectory)).toEqual([]);
  expect(effects.restores).toBe(1);
  expect((await service.inspectRestore(owner.principal, restore.id)).state.kind).toBe('restored');
  await assertRestoreAccessible(fixture.connection.db, target.machineId);
  expect((await service.inspect(owner.principal, capture.id)).state).toMatchObject({
    kind: 'captured',
    validation: 'restore_verified',
  });
  expect((await api('/v1/restores', restore)).status).toBe(202);
  expect(
    await fixture.connection.db
      .select()
      .from(backupRestores)
      .where(eq(backupRestores.id, restore.id)),
  ).toHaveLength(1);
  expect(
    await fixture.connection.db
      .select()
      .from(machines)
      .where(
        and(
          eq(machines.accountId, owner.principal.accountId),
          eq(machines.name, 'isolated-restore'),
        ),
      ),
  ).toHaveLength(1);
});

it('rechecks revoked authority before capture and prevents concurrent workers from doubling scratch use', async () => {
  const [restoredTarget] = await fixture.connection.db.select().from(backupRestores).limit(1);
  if (!restoredTarget) throw new Error('Expected isolated target.');
  // Reuse a verified target through its branded public record, without minting another VM for this admission check.
  const target = restoreResponseSchema.parse(
    await (await api(`/v1/restores/${restoredTarget.id}`)).json(),
  ).restore.machineId;
  const revoked = request();
  await service.capture(owner.principal, target, revoked);
  await fixture.connection.db
    .update(grants)
    .set({ revokedAt: new Date() })
    .where(eq(grants.id, owner.principal.grantId));
  await worker.advance('backup', revoked.id);
  expect(effects.captures).toBe(1);
  const [row] = await fixture.connection.db
    .select()
    .from(backups)
    .where(eq(backups.id, revoked.id));
  expect(row?.record).toMatchObject({ state: { kind: 'blocked' } });
  await fixture.connection.db
    .update(grants)
    .set({ revokedAt: null })
    .where(eq(grants.id, owner.principal.grantId));
  const concurrent = request();
  await service.capture(owner.principal, target, concurrent);
  let release = () => {};
  blockCapture = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = worker.advance('backup', concurrent.id);
  // Wait for the first effect, then contend for the same global scratch lease.
  for (let i = 0; effects.captures < 2 && i < 100; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  try {
    await expect(worker.advance('backup', concurrent.id)).rejects.toMatchObject(
      failure('resource_busy'),
    );
  } finally {
    release();
    blockCapture = undefined;
    await first;
  }
  expect(effects.captures).toBe(2);
});

it('reconciles an exhausted upload without another PUT, keeps failures reserved, and survives grant revocation', async () => {
  const [restoredTarget] = await fixture.connection.db.select().from(backupRestores).limit(1);
  if (!restoredTarget) throw new Error('Expected verified target.');
  const target = restoreResponseSchema.parse(
    await (await api(`/v1/restores/${restoredTarget.id}`)).json(),
  ).restore.machineId;
  const capture = request();
  await service.capture(owner.principal, target, capture);
  const beforeUploads = effects.uploads;
  loseUploadReply = true;
  await expect(worker.advance('backup', capture.id)).rejects.toThrow('Lost S3 reply');
  const [pending] = await fixture.connection.db
    .select()
    .from(backups)
    .where(eq(backups.id, capture.id));
  if (!pending) throw new Error('Missing upload intent.');
  const work = backupWorkSchema.parse(pending.work);
  if (work.kind !== 'upload_submitted') throw new Error('Expected unresolved upload.');
  await fixture.connection.db
    .update(backups)
    .set({ work: { ...work, attempts: 5 } })
    .where(eq(backups.id, capture.id));
  await worker.advance('backup', capture.id);
  let failRead = true;
  let calls = 0;
  const recovery = createBackupRecovery({
    connection: fixture.connection,
    recover: (intent) => {
      calls++;
      if (failRead) return Promise.reject(new Error('Storage unavailable'));
      const object = objects.get(intent.attemptId);
      return Promise.resolve(
        object ? { kind: 'found', receipt: object.receipt } : { kind: 'unresolved' },
      );
    },
  });
  const inspection = await recovery.inspect(capture.id);
  expect(inspection.canResolveUpload).toBe(true);
  expect(inspection.backup.state.kind).toBe('blocked');
  if (!inspection.receiptDigest) throw new Error('Missing immutable receipt digest.');
  const input = { backupId: capture.id, expectedReceiptDigest: inspection.receiptDigest };
  await expect(
    recovery.apply({ ...input, expectedReceiptDigest: 'f'.repeat(64) }),
  ).rejects.toMatchObject(failure('version_conflict'));
  expect(calls).toBe(0);
  await expect(recovery.apply(input)).rejects.toThrow('Storage unavailable');
  expect((await recovery.inspect(capture.id)).reservedBytes).toBe(1_048_576);
  expect((await recovery.inspect(capture.id)).backup.state.kind).toBe('blocked');
  failRead = false;
  await fixture.connection.db
    .update(grants)
    .set({ revokedAt: new Date() })
    .where(eq(grants.id, owner.principal.grantId));
  const result = await recovery.apply(input);
  expect(result.state.kind).toBe('captured');
  expect((await recovery.inspect(capture.id)).reservedBytes).toBe(plaintext.length);
  expect(await recovery.apply(input)).toEqual(result);
  expect(calls).toBe(2);
  expect(effects.uploads).toBe(beforeUploads + 1);
  await worker.advance('backup', capture.id);
  const [finished] = await fixture.connection.db
    .select()
    .from(backups)
    .where(eq(backups.id, capture.id));
  if (!finished) throw new Error('Missing recovered backup.');
  expect(backupRecord(finished).state.kind).toBe('captured');
  expect(backupWorkSchema.parse(finished.work)).toMatchObject({
    kind: 'stored',
    guestCleanup: 'done',
  });
});

it('waits for scratch capacity before transfer without consuming capture or restore attempts, then resumes', async () => {
  await fixture.connection.db
    .update(grants)
    .set({ revokedAt: null })
    .where(eq(grants.id, owner.principal.grantId));
  const [previous] = await fixture.connection.db.select().from(backupRestores).limit(1);
  if (!previous) throw new Error('Missing verified source.');
  const source = (await service.inspectRestore(owner.principal, previous.id)).machineId;
  const capture = request();
  await service.capture(owner.principal, source, capture);
  const reads = readEffects;
  availableScratchBytes = 0n;
  for (let i = 0; i < 6; i++)
    await expect(worker.advance('backup', capture.id)).rejects.toMatchObject(
      failure('resource_busy'),
    );
  const [waiting] = await fixture.connection.db
    .select()
    .from(backups)
    .where(eq(backups.id, capture.id));
  expect(waiting?.work).toMatchObject({ kind: 'encrypt', attempts: 0 });
  expect(readEffects).toBe(reads);
  availableScratchBytes = 8_589_934_592n;
  await worker.advance('backup', capture.id);
  expect(readEffects).toBe(reads + 1);
  expect((await service.inspect(owner.principal, capture.id)).state.kind).toBe('captured');
  const restoreRequest = restoreRequestSchema.parse({
    id: randomUUID(),
    backupId: capture.id,
    app: 'capacity-check',
    machine: { name: 'capacity-restore', size: 'small', region: 'fsn1' },
  });
  const restore = await service.restore(owner.principal, restoreRequest, {
    provider: 'simulated',
    catalog: () => simulatedCatalog('EUR'),
    limits: { currency: 'EUR', maxMachines: 20, maxHourlyMicros: 1_000_000 },
  });
  const [allocation] = await fixture.connection.db
    .select()
    .from(allocations)
    .where(eq(allocations.machineId, restore.machineId));
  if (!allocation) throw new Error('Missing owned restore allocation.');
  await fixture.connection.db
    .update(machines)
    .set({
      state: {
        kind: 'allocated',
        allocationId: allocation.id,
        serverId: '3',
        power: 'running',
        guest: {
          kind: 'ssh',
          verifiedAt: new Date().toISOString(),
          imageVersion: 'fixture',
          manifestDigest: 'a'.repeat(64),
          bootId: randomUUID(),
        },
      },
    })
    .where(eq(machines.id, restore.machineId));
  await fixture.connection.db
    .update(operations)
    .set({ progress: { kind: 'succeeded', completedAt: new Date().toISOString() } })
    .where(eq(operations.id, restore.operationId));
  const downloads = downloadEffects;
  const restores = effects.restores;
  availableScratchBytes = 0n;
  for (let i = 0; i < 6; i++)
    await expect(worker.advance('restore', restore.id)).rejects.toMatchObject(
      failure('resource_busy'),
    );
  const [blocked] = await fixture.connection.db
    .select()
    .from(backupRestores)
    .where(eq(backupRestores.id, restore.id));
  expect(blocked?.work).toMatchObject({ kind: 'prepare', attempts: 0 });
  expect(downloadEffects).toBe(downloads);
  expect(effects.restores).toBe(restores);
  availableScratchBytes = 8_589_934_592n;
  await worker.advance('restore', restore.id);
  expect(downloadEffects).toBe(downloads + 1);
  expect(effects.restores).toBe(restores + 1);
  expect((await service.inspectRestore(owner.principal, restore.id)).state.kind).toBe('restored');
});

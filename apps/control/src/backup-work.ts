import { constants, createReadStream } from 'node:fs';
import { lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import {
  CloudError,
  restoreRequestSchema,
  grantIdSchema,
  type backupGuestStateSchema,
  type restoreGuestStateSchema,
  backupGuestCaptureSchema,
  type RestoreGuestRequest,
  type BackupSummary,
  type AccountId,
  type MachineId,
  type AllocationId,
} from '@agent-cloud/contracts';
import {
  backups,
  backupRestores,
  machines,
  operations,
  machineRecord,
  operationRecord,
  withBackupWorkerLock,
  type Connection,
  type Database,
  type Executor,
  type Transaction,
} from '@agent-cloud/db';
import type { createBackupWriter, createBackupReader } from '@agent-cloud/backup-store';
import { authorize, loadAuthority } from './auth.js';
import { lockAccount } from './lifecycle.js';
import { type backupKeyringSchema, encryptBackup, decryptBackup } from './backup-crypto.js';
import {
  backupDigest,
  backupRecord,
  backupWorkSchema,
  capturedGuestSchema,
  restoreRecord,
  restoreWorkSchema,
  type BackupWork,
  type BackupControlConfig,
} from './backup-records.js';

export type BackupGuestScope = {
  accountId: AccountId;
  machineId: MachineId;
  allocationId: AllocationId;
};
export type BackupGuest = {
  capture: (
    request: z.infer<typeof backupGuestCaptureSchema>,
  ) => Promise<z.infer<typeof backupGuestStateSchema>>;
  read: <T>(id: string, maxBytes: number, work: (stream: Readable) => Promise<T>) => Promise<T>;
  remove: (id: string) => Promise<void>;
  restore: (
    request: RestoreGuestRequest,
    stream: Readable,
    beforeSubmit: () => Promise<void>,
  ) => Promise<z.infer<typeof restoreGuestStateSchema>>;
  inspectRestore: (id: string) => Promise<z.infer<typeof restoreGuestStateSchema> | null>;
};
export type WithBackupGuest = <T>(
  scope: BackupGuestScope,
  work: (guest: BackupGuest) => Promise<T>,
) => Promise<T>;

/** Scratch is operator-owned and serialized globally. Never traverse a customer-supplied directory. */
async function scratch(root: string, kind: 'backup' | 'restore', id: string) {
  const created = await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = join(root, `${kind}-${id}`);
  await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  });
  for (const path of [root, directory]) {
    const info = await lstat(path);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077
    )
      throw new Error('Backup scratch must be a private directory owned by this operator.');
  }
  const parent = dirname(created ?? root);
  for (let path = directory; ; path = dirname(path)) {
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (path === parent) break;
  }
  return directory;
}
async function removeScratchFile(path: string) {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077)
        throw new Error('Backup scratch file is not privately owned.');
    } finally {
      await file.close();
    }
    await rm(path);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}
async function cleanupRestoreScratch(root: string, id: string) {
  const directory = join(root, `restore-${id}`);
  try {
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077
    )
      throw new Error('Restore scratch ownership is invalid.');
    for (const entry of await readdir(directory)) {
      if (
        !['archive.enc', 'archive.tar'].includes(entry) &&
        !/^archive\.tar\.[a-f0-9]{32}\.partial$/.test(entry)
      )
        throw new Error('Restore scratch has an unrecognized file; refusing cleanup.');
      await removeScratchFile(join(directory, entry));
    }
    const handle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}
const binding = (
  record: BackupSummary,
  work: { capture: z.infer<typeof capturedGuestSchema> },
) => ({
  accountId: record.accountId,
  backupId: record.id,
  manifestSha256: backupDigest(work.capture.manifest),
});

class BackupAuthorityError extends Error {}

export function createBackupWorker(input: {
  connection: Connection;
  config: BackupControlConfig;
  writer: ReturnType<typeof createBackupWriter>;
  reader: ReturnType<typeof createBackupReader>;
  keyring: () => Promise<z.infer<typeof backupKeyringSchema>>;
  withGuest: WithBackupGuest;
}) {
  async function save(db: Executor, id: string, work: BackupWork) {
    await db.update(backups).set({ work }).where(eq(backups.id, id));
  }
  async function authorizeEffect(
    db: Database,
    row: typeof backups.$inferSelect | typeof backupRestores.$inferSelect,
    capability: 'backup:create' | 'backup:restore',
    work: (tx: Transaction) => Promise<void>,
  ) {
    await db.transaction(async (tx) => {
      const record = 'allocationId' in row ? backupRecord(row) : restoreRecord(row);
      await lockAccount(tx, record);
      try {
        const authority = await loadAuthority(tx, grantIdSchema.parse(row.grantId));
        if (authority.principal.accountId !== record.accountId)
          throw new CloudError('permission_denied', 'Backup authority belongs to another account.');
        authorize(authority.principal, capability, record.projectId);
      } catch (error) {
        if (
          error instanceof CloudError &&
          ['unauthenticated', 'permission_denied'].includes(error.failure.code)
        )
          throw new BackupAuthorityError(
            'The admitting backup credential is no longer authorized.',
          );
        throw error;
      }
      await work(tx);
    });
  }
  async function advanceCapture(db: Database, id: string) {
    const [row] = await db.select().from(backups).where(eq(backups.id, id));
    if (!row) return;
    const record = backupRecord(row);
    if (record.state.kind === 'blocked') return;
    let work = backupWorkSchema.parse(row.work);
    const scope = {
      accountId: record.accountId,
      machineId: record.machineId,
      allocationId: record.allocationId,
    };
    if (work.kind === 'capture') {
      if (work.attempts >= 5)
        return block(
          'Capture could not be resolved. Inspect the guest and create a new backup ID; this capture is not replayed after a guest interruption.',
        );
      const attempt = { ...work, attempts: work.attempts + 1 };
      await authorizeEffect(db, row, 'backup:create', (tx) => save(tx, id, attempt));
      const request = backupGuestCaptureSchema.parse(row.request);
      const capture = capturedGuestSchema.parse(
        await input.withGuest(scope, (guest) => guest.capture(request)),
      );
      if (
        capture.id !== record.id ||
        backupDigest(capture.manifest.recipe) !== backupDigest(request.recipe) ||
        capture.bytes > request.limits.maxBytes
      )
        throw new Error('Guest capture does not match its admitted recipe or byte limit.');
      work = { kind: 'encrypt', capture, attempts: 0 };
      await save(db, id, work);
    }
    if (work.kind === 'encrypt') {
      if (work.attempts >= 5)
        return block(
          'Captured bytes could not be encrypted and verified. No object upload was submitted.',
        );
      const attempt = { ...work, attempts: work.attempts + 1 };
      await authorizeEffect(db, row, 'backup:create', (tx) => save(tx, id, attempt));
      const directory = await scratch(input.config.directory, 'backup', id);
      const ciphertext = join(directory, 'archive.enc');
      // This phase proves no PUT was submitted. An orphan from a crash before its envelope receipt is safe to replace.
      await removeScratchFile(ciphertext);
      const keyring = await input.keyring();
      const limits = backupGuestCaptureSchema.parse(row.request).limits;
      const encryption = await input.withGuest(scope, (guest) =>
        guest.read(id, limits.maxBytes, (source) =>
          encryptBackup({
            source,
            destination: ciphertext,
            binding: binding(record, attempt),
            keyring,
            maxBytes: limits.maxBytes,
            signal: AbortSignal.timeout(limits.timeoutSeconds * 1000),
          }),
        ),
      );
      if (
        encryption.plaintextBytes !== work.capture.bytes ||
        encryption.plaintextSha256 !== work.capture.sha256
      )
        throw new Error('Guest archive bytes differ from the captured manifest receipt.');
      const intent = await input.writer.prepareUpload({
        attemptId: id,
        file: ciphertext,
        retention: { mode: input.config.retentionMode, retainUntil: record.retainUntil },
      });
      work = { kind: 'upload_ready', capture: work.capture, encryption, intent };
      await save(db, id, work);
    }
    if (work.kind === 'upload_ready') {
      const submitted = { ...work, kind: 'upload_submitted', attempts: 0 } satisfies BackupWork;
      await save(db, id, submitted);
      // A timeout or lost database receipt may only lead to read-only recovery of this exact intent.
      const receipt = await input.writer.upload({
        intent: work.intent,
        file: join(input.config.directory, `backup-${id}`, 'archive.enc'),
      });
      work = { ...work, kind: 'stored', receipt, guestCleanup: 'pending', attempts: 0 };
      await saveStored(work);
    } else if (work.kind === 'upload_submitted') {
      if (work.attempts >= 5)
        return block(
          'Upload outcome remains unresolved. Its object intent and storage reservation are retained; the same PUT will not be repeated.',
        );
      work = { ...work, attempts: work.attempts + 1 };
      await save(db, id, work);
      const recovered = await input.writer.recover(work.intent);
      if (recovered.kind === 'unresolved')
        throw new CloudError(
          'provider_unavailable',
          'Backup upload is awaiting exact object-version recovery.',
          true,
        );
      work = {
        ...work,
        kind: 'stored',
        receipt: recovered.receipt,
        guestCleanup: 'pending',
        attempts: 0,
      };
      await saveStored(work);
    }
    {
      await removeScratchFile(join(input.config.directory, `backup-${id}`, 'archive.enc'));
      if (work.guestCleanup === 'pending' && work.attempts < 5) {
        work = { ...work, attempts: work.attempts + 1 };
        await save(db, id, work);
        const [machine] = await db.select().from(machines).where(eq(machines.id, record.machineId));
        if (machine && machineRecord(machine).state.kind !== 'destroyed')
          await input.withGuest(scope, (guest) => guest.remove(id));
        await save(db, id, { ...work, guestCleanup: 'done' });
      }
    }
    async function saveStored(stored: Extract<BackupWork, { kind: 'stored' }>) {
      await db
        .update(backups)
        .set({
          work: stored,
          reservedBytes: stored.receipt.size,
          record: {
            ...record,
            state: {
              kind: 'captured',
              bytes: stored.receipt.size,
              capturedAt: stored.capture.manifest.capturedAt,
              validation: 'captured',
              manifest: stored.capture.manifest,
            },
          },
        })
        .where(eq(backups.id, id));
    }
    async function block(reason: string) {
      await db
        .update(backups)
        .set({ record: { ...record, state: { kind: 'blocked', reason } } })
        .where(eq(backups.id, id));
    }
  }
  async function advanceRestore(db: Database, id: string) {
    const [row] = await db.select().from(backupRestores).where(eq(backupRestores.id, id));
    if (!row) return;
    const record = restoreRecord(row);
    if (record.state.kind !== 'pending') return;
    const request = restoreRequestSchema.parse(row.request);
    let work = restoreWorkSchema.parse(row.work);
    const [targetRow] = await db
      .select()
      .from(machines)
      .where(and(eq(machines.id, record.machineId), eq(machines.accountId, record.accountId)));
    if (!targetRow) throw new Error('Restore target ownership is missing.');
    const target = machineRecord(targetRow);
    if (target.state.kind === 'destroyed')
      return block('Restore target was destroyed. The source backup is unchanged.');
    if (work.kind === 'waiting') {
      const [operation] = await db
        .select()
        .from(operations)
        .where(eq(operations.id, record.operationId));
      if (!operation) throw new Error('Restore provisioning operation is missing.');
      const progress = operationRecord(operation).progress;
      if (['failed', 'cancelled', 'blocked'].includes(progress.kind))
        return block(
          'Restore target provisioning did not succeed. Inspect its operation and cleanup obligations; the source backup is unchanged.',
        );
      if (progress.kind !== 'succeeded') return;
      work = { kind: 'prepare', attempts: 0 };
      await saveWork(work);
    }
    if (target.state.kind !== 'allocated' || target.state.guest.kind !== 'ssh')
      throw new CloudError(
        'resource_busy',
        'Restore is waiting for its verified target guest.',
        true,
      );
    const scope = {
      accountId: record.accountId,
      machineId: record.machineId,
      allocationId: target.state.allocationId,
    };
    if (work.kind === 'submitted') {
      await cleanupRestoreScratch(input.config.directory, id);
      if (work.attempts >= 5)
        return block(
          'Restore response remains unresolved. This target stays isolated and SQL is not replayed. Inspect the target or destroy it and start a new restore.',
        );
      work = { ...work, attempts: work.attempts + 1 };
      await saveWork(work);
      const result = await input.withGuest(scope, (guest) => guest.inspectRestore(id));
      if (result?.kind === 'restored') return finish(result);
      if (result?.kind === 'failed')
        return block(
          'The isolated guest reported restore failure. Its target is retained for cleanup; the source backup is unchanged.',
        );
      throw new CloudError(
        'guest_unreachable',
        'Restore completion is awaiting guest evidence.',
        true,
      );
    }
    if (work.kind !== 'prepare') return;
    if (work.attempts >= 5)
      return block(
        'Restore preparation could not verify its encrypted backup. No database restore was submitted.',
      );
    const attempts = work.attempts + 1;
    await authorizeEffect(db, row, 'backup:restore', (tx) =>
      saveWork({ kind: 'prepare', attempts }, tx),
    );
    const [sourceRow] = await db
      .select()
      .from(backups)
      .where(and(eq(backups.id, record.backupId), eq(backups.accountId, record.accountId)));
    if (!sourceRow) throw new Error('Restore source ownership is missing.');
    const sourceRecord = backupRecord(sourceRow);
    const source = backupWorkSchema.parse(sourceRow.work);
    if (source.kind !== 'stored')
      throw new Error('Restore source has no protected object version.');
    const directory = await scratch(input.config.directory, 'restore', id);
    const ciphertext = join(directory, 'archive.enc');
    const plaintext = join(directory, 'archive.tar');
    await cleanupRestoreScratch(input.config.directory, id);
    try {
      await input.reader.download({ receipt: source.receipt, destination: ciphertext });
      await decryptBackup({
        source: ciphertext,
        destination: plaintext,
        encryption: source.encryption,
        binding: binding(sourceRecord, source),
        keyring: await input.keyring(),
        maxBytes: input.config.limits.maxBytes,
        signal: AbortSignal.timeout(input.config.limits.timeoutSeconds * 1000),
      });
      const stream = createReadStream(plaintext);
      try {
        const result = await input.withGuest(scope, (guest) =>
          guest.restore(
            {
              id: record.id,
              backupId: record.backupId,
              app: request.app,
              limits: input.config.limits,
              bytes: source.encryption.plaintextBytes,
              sha256: source.encryption.plaintextSha256,
            },
            stream,
            () =>
              authorizeEffect(db, row, 'backup:restore', (tx) =>
                saveWork({ kind: 'submitted', attempts: 0 }, tx),
              ),
          ),
        );
        if (result.kind === 'restored') {
          await finish(result);
          return;
        }
        if (result.kind === 'failed') {
          await block(
            'The isolated guest reported restore failure. Inspect or destroy its target; the source backup is unchanged.',
          );
          return;
        }
      } finally {
        stream.destroy();
      }
    } finally {
      await removeScratchFile(plaintext);
      await removeScratchFile(ciphertext);
    }
    async function saveWork(next: z.infer<typeof restoreWorkSchema>, executor: Executor = db) {
      await executor.update(backupRestores).set({ work: next }).where(eq(backupRestores.id, id));
    }
    async function block(reason: string) {
      await cleanupRestoreScratch(input.config.directory, id);
      await db
        .update(backupRestores)
        .set({ record: { ...record, state: { kind: 'blocked', reason } } })
        .where(eq(backupRestores.id, id));
    }
    async function finish(
      result: Extract<z.infer<typeof restoreGuestStateSchema>, { kind: 'restored' }>,
    ) {
      if (result.id !== record.id || result.app !== request.app)
        throw new Error('Guest restored another request.');
      // Erase authenticated plaintext before publishing a terminal result that stops reconciliation.
      await cleanupRestoreScratch(input.config.directory, id);
      await db.transaction(async (tx) => {
        await tx
          .update(backupRestores)
          .set({
            work: { kind: 'done' },
            record: { ...record, state: { kind: 'restored', result } },
          })
          .where(eq(backupRestores.id, id));
        const [source] = await tx
          .select()
          .from(backups)
          .where(eq(backups.id, record.backupId))
          .for('update');
        if (!source) throw new Error('Verified restore source is missing.');
        const backup = backupRecord(source);
        if (backup.state.kind !== 'captured')
          throw new Error('Verified restore source is not captured.');
        await tx
          .update(backups)
          .set({
            record: { ...backup, state: { ...backup.state, validation: 'restore_verified' } },
          })
          .where(eq(backups.id, record.backupId));
      });
    }
  }
  async function advance(kind: 'backup' | 'restore', id: string) {
    const result = await withBackupWorkerLock({
      pool: input.connection.pool,
      work: async (db) => {
        try {
          await (kind === 'backup' ? advanceCapture(db, id) : advanceRestore(db, id));
        } catch (error) {
          if (!(error instanceof BackupAuthorityError)) throw error;
          const reason =
            'The admitting credential is no longer authorized. Existing protected data and infrastructure cleanup obligations remain owned by the account.';
          if (kind === 'backup') {
            const [row] = await db.select().from(backups).where(eq(backups.id, id));
            if (row)
              await db
                .update(backups)
                .set({ record: { ...backupRecord(row), state: { kind: 'blocked', reason } } })
                .where(eq(backups.id, id));
          } else {
            const [row] = await db.select().from(backupRestores).where(eq(backupRestores.id, id));
            if (row) {
              await cleanupRestoreScratch(input.config.directory, restoreRecord(row).id);
              await db
                .update(backupRestores)
                .set({ record: { ...restoreRecord(row), state: { kind: 'blocked', reason } } })
                .where(eq(backupRestores.id, id));
            }
          }
        } finally {
          if (kind === 'backup') {
            const [row] = await db.select().from(backups).where(eq(backups.id, id));
            if (row && backupWorkSchema.parse(row.work).kind !== 'upload_ready')
              await removeScratchFile(
                join(input.config.directory, `backup-${backupRecord(row).id}`, 'archive.enc'),
              );
          }
        }
      },
    });
    if (result.kind === 'busy')
      throw new CloudError(
        'resource_busy',
        'Another backup or restore owns the bounded worker scratch capacity.',
        true,
      );
  }
  return { advance };
}

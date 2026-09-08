import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { CloudError, backupIdSchema, type BackupSummary } from '@agent-cloud/contracts';
import { auditEvents, backups, withBackupWorkerLock, type Connection } from '@agent-cloud/db';
import type { createBackupWriter } from '@agent-cloud/backup-store';
import { backupDigest, backupRecord, backupWorkSchema, type BackupWork } from './backup-records.js';
import { enqueueBackup } from './backups.js';
import { lockAccount } from './lifecycle.js';

export const backupRecoveryRequestSchema = z.strictObject({
  backupId: backupIdSchema,
  expectedReceiptDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
// This digest identifies the immutable capture/encryption/upload intent without exposing its private envelope.
function receiptDigest(backup: BackupSummary, work: BackupWork) {
  if (work.kind !== 'upload_submitted' && work.kind !== 'stored') return null;
  return backupDigest({
    accountId: backup.accountId,
    backupId: backup.id,
    allocationId: backup.allocationId,
    capture: work.capture,
    encryption: work.encryption,
    intent: work.intent,
  });
}

/** Operator-only reconciliation. It has no upload, guest execution, deletion or customer access path. */
export function createBackupRecovery(input: {
  connection: Connection;
  recover: ReturnType<typeof createBackupWriter>['recover'];
}) {
  async function inspect(id: string) {
    const [row] = await input.connection.db.select().from(backups).where(eq(backups.id, id));
    if (!row) throw new CloudError('not_found', 'Backup not found.');
    const backup = backupRecord(row);
    const work = backupWorkSchema.parse(row.work);
    return {
      backup,
      phase: work.kind,
      receiptDigest: receiptDigest(backup, work),
      reservedBytes: row.reservedBytes,
      canResolveUpload:
        work.kind === 'upload_submitted' &&
        (backup.state.kind === 'pending' || backup.state.kind === 'blocked'),
    };
  }
  async function apply(request: z.infer<typeof backupRecoveryRequestSchema>) {
    const result = await withBackupWorkerLock({
      pool: input.connection.pool,
      work: async (db) => {
        const [row] = await db.select().from(backups).where(eq(backups.id, request.backupId));
        if (!row) throw new CloudError('not_found', 'Backup not found.');
        const backup = backupRecord(row);
        const work = backupWorkSchema.parse(row.work);
        if (receiptDigest(backup, work) !== request.expectedReceiptDigest)
          throw new CloudError(
            'version_conflict',
            'Backup receipt changed. Inspect the current record before recovery.',
          );
        if (work.kind === 'stored' && backup.state.kind === 'captured') return backup;
        if (
          work.kind !== 'upload_submitted' ||
          (backup.state.kind !== 'pending' && backup.state.kind !== 'blocked')
        )
          throw new CloudError(
            'resource_busy',
            'Only a recorded unresolved upload can be reconciled. No capture, PUT or restore will be repeated.',
          );
        const resolution = await input.recover(work.intent);
        if (resolution.kind === 'unresolved')
          throw new CloudError(
            'provider_outcome_unknown',
            'The recorded upload remains unresolved. Its intent and full reservation are unchanged.',
          );
        // This is read-only storage reconciliation, so it remains safe after the admitting grant expires.
        const next = {
          ...work,
          kind: 'stored',
          receipt: resolution.receipt,
          guestCleanup: 'pending',
          attempts: 0,
        } satisfies BackupWork;
        const captured: BackupSummary = {
          ...backup,
          state: {
            kind: 'captured',
            bytes: next.receipt.size,
            capturedAt: next.capture.manifest.capturedAt,
            validation: 'captured',
            manifest: next.capture.manifest,
          },
        };
        await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(78131025)`);
          await lockAccount(tx, backup);
          const [current] = await tx
            .select()
            .from(backups)
            .where(and(eq(backups.id, backup.id), eq(backups.accountId, backup.accountId)));
          if (
            !current ||
            backupDigest({ record: current.record, work: current.work }) !==
              backupDigest({ record: row.record, work: row.work })
          )
            throw new CloudError(
              'version_conflict',
              'Backup changed during read-only recovery. Inspect it again.',
            );
          await tx
            .update(backups)
            .set({ work: next, record: captured, reservedBytes: next.receipt.size })
            .where(eq(backups.id, backup.id));
          await tx.insert(auditEvents).values({
            accountId: backup.accountId,
            subjectId: backup.id,
            event: 'backup.upload_recovered',
            details: {
              receiptDigest: request.expectedReceiptDigest,
              previousState: backup.state.kind,
              reservedBytes: next.receipt.size,
            },
          });
          await enqueueBackup(tx, 'backup', backup.id);
        });
        return captured;
      },
    });
    if (result.kind === 'busy')
      throw new CloudError(
        'resource_busy',
        'Another backup, restore or purge owns the worker lock. Retry this same inspected receipt.',
        true,
      );
    return result.value;
  }
  return { inspect, apply };
}

import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { accountIdSchema, type BackupPurgeSummary } from '@agent-cloud/contracts';
import {
  auditEvents,
  backupPurges,
  backups,
  databaseTime,
  withBackupWorkerLock,
  type Connection,
  type Database,
} from '@agent-cloud/db';
import type { createBackupDeleter } from '@agent-cloud/backup-store';
import { backupRecord, backupWorkSchema } from './backup-records.js';
import { admitExpiredBackup, retentionCandidates, purgeRecord } from './backup-purges.js';
import { lockAccount } from './lifecycle.js';

/** Only this operator process receives deletion credentials. Every mutation has a durable exact-version intent. */
export function createBackupRetention(input: {
  connection: Connection;
  deleter: Pick<ReturnType<typeof createBackupDeleter>, 'purge'>;
}) {
  async function advance(id: string) {
    return withBackupWorkerLock({
      pool: input.connection.pool,
      work: async (db) => {
        const [selected] = await db.select().from(backupPurges).where(eq(backupPurges.id, id));
        if (!selected || !selected.nextAttemptAt) return;
        const now = await databaseTime(db);
        if (selected.nextAttemptAt > now) return;
        const purge = purgeRecord(selected);
        if (purge.state.kind === 'purged') return;
        const [row] = await db.select().from(backups).where(eq(backups.id, purge.backupId));
        if (!row) throw new Error('Purge source receipt is missing.');
        const backup = backupRecord(row);
        const work = backupWorkSchema.parse(row.work);
        if (
          backup.accountId !== purge.accountId ||
          backup.projectId !== purge.projectId ||
          backup.state.kind !== 'purge_pending' ||
          backup.state.purgeId !== purge.id ||
          work.kind !== 'stored' ||
          work.receipt.attemptId !== backup.id
        )
          throw new Error('Purge no longer owns this stored backup.');
        const submitted: BackupPurgeSummary = {
          ...purge,
          state: { kind: 'submitted', attemptedAt: now.toISOString() },
        };
        // Account authorization was committed at admission. Cleanup survives later expiry/revocation.
        // Persist before any possible DELETE, including retries after a lost reply.
        await db.update(backupPurges).set({ record: submitted }).where(eq(backupPurges.id, id));
        let outcome;
        try {
          outcome = await input.deleter.purge(work.receipt);
        } catch {
          const retryAt = new Date((await databaseTime(db)).getTime() + 300_000);
          await db
            .update(backupPurges)
            .set({
              record: {
                ...purge,
                state: {
                  kind: 'blocked',
                  retryAt: retryAt.toISOString(),
                  reason:
                    'Exact object-version absence is unconfirmed. Storage remains reserved; the retention operator will retry.',
                },
              },
              nextAttemptAt: retryAt,
            })
            .where(eq(backupPurges.id, id));
          return;
        }
        if (outcome.kind === 'retained') {
          await db
            .update(backupPurges)
            .set({
              record: { ...purge, state: { kind: 'waiting', notBefore: outcome.retainUntil } },
              nextAttemptAt: new Date(Math.max(Date.parse(outcome.retainUntil), Date.now() + 1000)),
            })
            .where(eq(backupPurges.id, id));
          return;
        }
        await complete(db, purge);
      },
    });
  }
  async function complete(db: Database, purge: BackupPurgeSummary) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(78131025)`);
      await lockAccount(tx, { accountId: accountIdSchema.parse(purge.accountId) });
      const [row] = await tx.select().from(backups).where(eq(backups.id, purge.backupId));
      if (!row) throw new Error('Purge source disappeared before accounting.');
      const backup = backupRecord(row);
      if (backup.state.kind !== 'purge_pending' || backup.state.purgeId !== purge.id)
        throw new Error('Purge source ownership changed before accounting.');
      const purgedAt = (await databaseTime(tx)).toISOString();
      await tx
        .update(backups)
        .set({
          reservedBytes: 0,
          record: { ...backup, state: { kind: 'purged', purgeId: purge.id, purgedAt } },
        })
        .where(eq(backups.id, backup.id));
      await tx
        .update(backupPurges)
        .set({ nextAttemptAt: null, record: { ...purge, state: { kind: 'purged', purgedAt } } })
        .where(eq(backupPurges.id, purge.id));
      await tx.insert(auditEvents).values({
        accountId: purge.accountId,
        subjectId: purge.id,
        event: 'backup.purged',
        details: { backupId: purge.backupId, releasedBytes: row.reservedBytes },
      });
    });
  }
  async function run(inputRun: {
    maxObjects: number;
    maxRunSeconds: number;
    pruneScheduled: boolean;
  }) {
    const deadline = Date.now() + inputRun.maxRunSeconds * 1000;
    let admitted = 0;
    if (inputRun.pruneScheduled) {
      const candidates = await retentionCandidates(input.connection.db, inputRun.maxObjects);
      for (const candidate of candidates) {
        if (Date.now() >= deadline) break;
        if (await admitExpiredBackup(input.connection.db, candidate.id)) admitted++;
      }
    }
    const due = await input.connection.db
      .select({ id: backupPurges.id })
      .from(backupPurges)
      .where(
        and(
          isNotNull(backupPurges.nextAttemptAt),
          sql`${backupPurges.nextAttemptAt} <= clock_timestamp()`,
        ),
      )
      .orderBy(backupPurges.nextAttemptAt)
      .limit(inputRun.maxObjects);
    let advanced = 0;
    for (const candidate of due) {
      if (Date.now() >= deadline) break;
      const result = await advance(candidate.id);
      if (result.kind === 'busy') break;
      advanced++;
    }
    return { admitted, advanced };
  }
  return { advance, run };
}

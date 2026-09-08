import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  CloudError,
  accountIdSchema,
  backupPurgeIdSchema,
  backupPurgeSummarySchema,
  type BackupPurgeRequest,
  type Principal,
} from '@agent-cloud/contracts';
import {
  auditEvents,
  backupPurges,
  backupRestores,
  backups,
  databaseTime,
  machineRecord,
  machines,
  type Database,
  type Transaction,
} from '@agent-cloud/db';
import { authorize, loadAuthority } from './auth.js';
import { lockAccount } from './lifecycle.js';
import { backupRecord, backupWorkSchema, restoreWorkSchema } from './backup-records.js';

export function purgeRecord(row: typeof backupPurges.$inferSelect) {
  const record = backupPurgeSummarySchema.parse(row.record);
  if (
    record.id !== row.id ||
    record.backupId !== row.backupId ||
    record.accountId !== row.accountId
  )
    throw new Error('Backup purge ownership disagrees with its record.');
  return record;
}

async function assertPurgeable(tx: Transaction, row: typeof backups.$inferSelect) {
  const backup = backupRecord(row);
  const work = backupWorkSchema.parse(row.work);
  if (backup.state.kind !== 'captured' || work.kind !== 'stored')
    throw new CloudError(
      'resource_busy',
      'Purge needs a verified stored backup. Unresolved uploads require operator recovery.',
    );
  if (
    work.receipt.attemptId !== backup.id ||
    work.capture.id !== backup.id ||
    work.receipt.size !== row.reservedBytes
  )
    throw new Error('Stored backup receipt does not match its allocation.');
  if (work.guestCleanup !== 'done') {
    const [source] = await tx.select().from(machines).where(eq(machines.id, backup.machineId));
    if (!source || machineRecord(source).state.kind !== 'destroyed')
      throw new CloudError(
        'resource_busy',
        'The source guest still has backup staging to clean up.',
      );
  }
  // Failed and uncertain restores keep the object pinned until their owned target is destroyed.
  const restores = await tx
    .select({ restore: backupRestores, machine: machines })
    .from(backupRestores)
    .innerJoin(machines, eq(machines.id, backupRestores.machineId))
    .where(eq(backupRestores.backupId, backup.id));
  if (
    restores.some(
      ({ restore, machine }) =>
        restoreWorkSchema.parse(restore.work).kind !== 'done' &&
        machineRecord(machine).state.kind !== 'destroyed',
    )
  )
    throw new CloudError(
      'resource_busy',
      'An unfinished restore needs this backup. Finish the restore or destroy its owned target before purging.',
    );
  return backup;
}

async function admitPurge(
  tx: Transaction,
  row: typeof backups.$inferSelect,
  request: {
    id: BackupPurgeRequest['id'];
    authority: { kind: 'customer'; principal: Principal } | { kind: 'retention' };
  },
) {
  const backup = await assertPurgeable(tx, row);
  const now = await databaseTime(tx);
  const record = backupPurgeSummarySchema.parse({
    id: request.id,
    backupId: backup.id,
    accountId: backup.accountId,
    projectId: backup.projectId,
    reason: request.authority.kind,
    createdAt: now.toISOString(),
    state: { kind: 'waiting', notBefore: backup.retainUntil },
  });
  await tx.insert(backupPurges).values({
    id: record.id,
    accountId: record.accountId,
    backupId: record.backupId,
    record,
    grantId: request.authority.kind === 'customer' ? request.authority.principal.grantId : null,
    nextAttemptAt: new Date(Math.max(now.getTime(), Date.parse(backup.retainUntil))),
  });
  await tx
    .update(backups)
    .set({ record: { ...backup, state: { kind: 'purge_pending', purgeId: record.id } } })
    .where(eq(backups.id, backup.id));
  await tx.insert(auditEvents).values({
    accountId: backup.accountId,
    subjectId: record.id,
    event: 'backup.purge_admitted',
    details: {
      backupId: backup.id,
      reason: record.reason,
      grantId: request.authority.kind === 'customer' ? request.authority.principal.grantId : null,
    },
  });
  return record;
}

/** Admission commits the account's irreversible cleanup intent; it survives disconnection and grant expiry. */
export function createBackupPurges(db: Database) {
  async function request(principal: Principal, id: string, request: BackupPurgeRequest) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(78131025)`);
      await lockAccount(tx, principal);
      const authority = await loadAuthority(tx, principal.grantId);
      const [row] = await tx
        .select()
        .from(backups)
        .where(and(eq(backups.id, id), eq(backups.accountId, principal.accountId)));
      if (!row) throw new CloudError('not_found', 'Backup not found.');
      const backup = backupRecord(row);
      authorize(authority.principal, 'backup:purge', backup.projectId);
      const [existing] = await tx
        .select()
        .from(backupPurges)
        .where(eq(backupPurges.id, request.id));
      if (existing) {
        if (
          existing.accountId !== principal.accountId ||
          existing.backupId !== id ||
          purgeRecord(existing).reason !== 'customer'
        )
          throw new CloudError('idempotency_conflict', 'Purge ID belongs to a different request.');
        return purgeRecord(existing);
      }
      if (backup.state.kind === 'purge_pending' || backup.state.kind === 'purged')
        throw new CloudError(
          'resource_busy',
          `This backup already has purge ${backup.state.purgeId}. Inspect that operation.`,
        );
      return admitPurge(tx, row, {
        id: request.id,
        authority: { kind: 'customer', principal: authority.principal },
      });
    });
  }
  async function inspect(principal: Principal, id: string) {
    const [row] = await db
      .select()
      .from(backupPurges)
      .where(and(eq(backupPurges.id, id), eq(backupPurges.accountId, principal.accountId)));
    if (!row) throw new CloudError('not_found', 'Backup purge not found.');
    const record = purgeRecord(row);
    authorize(principal, 'backup:read', record.projectId);
    return record;
  }
  return { request, inspect };
}

/** One policy query is used for candidate selection and repeated under admission locks. */
const retentionEligible = sql`
  ${backups.record}->'state'->>'kind' = 'captured'
  AND (${backups.record}->>'retainUntil')::timestamptz <= clock_timestamp()
  AND ${backups.work}->>'kind' = 'stored'
  AND (${backups.work}->>'guestCleanup' = 'done' OR EXISTS (
    SELECT 1 FROM machines source WHERE source.id = ${backups.machineId} AND source.state->>'kind' = 'destroyed'
  ))
  AND EXISTS (SELECT 1 FROM backup_schedule_runs scheduled WHERE scheduled.backup_id = ${backups.id})
  AND NOT EXISTS (
    SELECT 1 FROM backup_restores restore JOIN machines target ON target.id = restore.machine_id
    WHERE restore.backup_id = ${backups.id} AND restore.work->>'kind' <> 'done' AND target.state->>'kind' <> 'destroyed'
  )
  AND 7 <= (
    SELECT count(DISTINCT (later.created_at AT TIME ZONE 'UTC')::date)
    FROM backups later JOIN backup_schedule_runs scheduled ON scheduled.backup_id = later.id
    WHERE later.machine_id = ${backups.machineId} AND later.account_id = ${backups.accountId}
      AND later.record->'state'->>'kind' = 'captured'
      AND (later.created_at AT TIME ZONE 'UTC')::date > (${backups.createdAt} AT TIME ZONE 'UTC')::date
      AND (later.request->'recipe') - 'releaseId' = (${backups.request}->'recipe') - 'releaseId'
  )`;

export function retentionCandidates(db: Database, limit: number) {
  return db
    .select({ id: backups.id })
    .from(backups)
    .where(retentionEligible)
    .orderBy(backups.createdAt)
    .limit(limit);
}

/** Only scheduled captures expire automatically. Keep seven newer successful UTC days of the same recipe. */
export async function admitExpiredBackup(db: Database, id: string) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(78131025)`);
    const [selected] = await tx.select().from(backups).where(eq(backups.id, id));
    if (!selected) return null;
    await lockAccount(tx, { accountId: accountIdSchema.parse(selected.accountId) });
    // Release and schedule IDs change on deployment. Data identity and declared files still match.
    const [row] = await tx
      .select()
      .from(backups)
      .where(and(eq(backups.id, id), retentionEligible));
    if (!row) return null;
    return admitPurge(tx, row, {
      id: backupPurgeIdSchema.parse(randomUUID()),
      authority: { kind: 'retention' },
    });
  });
}

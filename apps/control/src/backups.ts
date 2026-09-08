import { and, desc, eq, sql } from 'drizzle-orm';
import {
  CloudError,
  backupSummarySchema,
  restoreSummarySchema,
  type backupCaptureRequestSchema,
  type Principal,
  type MachineId,
  type RestoreRequest,
} from '@agent-cloud/contracts';
import {
  backups,
  backupRestores,
  machines,
  machineRecord,
  auditEvents,
  type Database,
  type Executor,
  type Transaction,
} from '@agent-cloud/db';
import type { z } from 'zod';
import { authorize, loadAuthority } from './auth.js';
import { createBackupPurges } from './backup-purges.js';
import { createBackupSchedules } from './backup-schedules.js';
import { admit, lockAccount } from './lifecycle.js';
import {
  backupDigest,
  backupRecord,
  backupWorkSchema,
  restoreRecord,
  type BackupControlConfig,
} from './backup-records.js';

export async function enqueueBackup(db: Executor, kind: 'backup' | 'restore', id: string) {
  await db.execute(
    sql`SELECT graphile_worker.add_job('advance_backup', ${JSON.stringify({ kind, id })}::json, job_key := ${`${kind}:${id}`}, max_attempts := 10)`,
  );
}

/** Admission owns identity, quotas and the newly allocated restore target. No guest effects run in a transaction. */
export function createBackups(input: {
  db: Database;
  config: BackupControlConfig;
  advance: (kind: 'backup' | 'restore', id: string) => Promise<void>;
}) {
  async function inspect(principal: Principal, id: string) {
    const [row] = await input.db
      .select()
      .from(backups)
      .where(and(eq(backups.id, id), eq(backups.accountId, principal.accountId)));
    if (!row) throw new CloudError('not_found', 'Backup not found.');
    const backup = backupRecord(row);
    authorize(principal, 'backup:read', backup.projectId);
    return backup;
  }
  async function list(principal: Principal, machineId: MachineId) {
    const [machine] = await input.db
      .select()
      .from(machines)
      .where(and(eq(machines.id, machineId), eq(machines.accountId, principal.accountId)));
    if (!machine) throw new CloudError('not_found', 'Machine not found.');
    authorize(principal, 'backup:read', machineRecord(machine).projectId);
    return (
      await input.db
        .select()
        .from(backups)
        .where(and(eq(backups.machineId, machineId), eq(backups.accountId, principal.accountId)))
        .orderBy(desc(backups.createdAt))
        .limit(100)
    ).map(backupRecord);
  }
  function capture(
    principal: Principal,
    machineId: MachineId,
    request: z.infer<typeof backupCaptureRequestSchema>,
  ) {
    return input.db.transaction((tx) => captureInTransaction(tx, principal, machineId, request));
  }
  async function captureInTransaction(
    tx: Transaction,
    principal: Principal,
    machineId: MachineId,
    request: z.infer<typeof backupCaptureRequestSchema>,
  ) {
    const digest = backupDigest({ machineId, request });
    // Global capacity precedes account locks, as in VM admission.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(78131025)`);
    await lockAccount(tx, principal);
    const authority = await loadAuthority(tx, principal.grantId);
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`backup:${request.id}`}, 0))`,
    );
    const [existing] = await tx.select().from(backups).where(eq(backups.id, request.id));
    if (existing) {
      if (existing.accountId !== principal.accountId || existing.digest !== digest)
        throw new CloudError(
          'idempotency_conflict',
          'Backup ID belongs to a different capture request.',
        );
      const record = backupRecord(existing);
      authorize(authority.principal, 'backup:create', record.projectId);
      return record;
    }
    const [row] = await tx
      .select()
      .from(machines)
      .where(and(eq(machines.id, machineId), eq(machines.accountId, principal.accountId)));
    if (!row) throw new CloudError('not_found', 'Machine not found.');
    const machine = machineRecord(row);
    authorize(authority.principal, 'backup:create', machine.projectId);
    if (machine.state.kind !== 'allocated' || machine.state.guest.kind !== 'ssh')
      throw new CloudError('resource_busy', 'Backup capture needs a verified allocated guest.');
    const totals = await tx.execute<{ owned: number; total: number; recent: number }>(sql`SELECT
        coalesce(sum(reserved_bytes) FILTER (WHERE account_id = ${principal.accountId}), 0)::float8 AS owned,
        coalesce(sum(reserved_bytes), 0)::float8 AS total,
        count(*) FILTER (WHERE account_id = ${principal.accountId} AND created_at > clock_timestamp() - interval '1 hour')::float8 AS recent FROM backups`);
    const used = totals.rows[0];
    if (
      !used ||
      used.owned + input.config.limits.maxBytes > input.config.maxAccountBytes ||
      used.total + input.config.limits.maxBytes > input.config.maxGlobalBytes
    )
      throw new CloudError(
        'quota_exceeded',
        'Protected backup storage reservations exceed the configured allowance. Retained and unresolved uploads remain reserved.',
      );
    if (used.recent >= 10)
      throw new CloudError(
        'quota_exceeded',
        'Capture is limited to ten admissions per account per hour.',
      );
    const retainUntil = new Date(
      Math.ceil((authority.checkedAt.getTime() + input.config.retentionDays * 86_400_000) / 1000) *
        1000,
    ).toISOString();
    const record = backupSummarySchema.parse({
      id: request.id,
      accountId: principal.accountId,
      projectId: machine.projectId,
      machineId,
      allocationId: machine.state.allocationId,
      createdAt: authority.checkedAt.toISOString(),
      retainUntil,
      state: { kind: 'pending' },
    });
    await tx.insert(backups).values({
      id: request.id,
      accountId: principal.accountId,
      projectId: machine.projectId,
      machineId,
      allocationId: machine.state.allocationId,
      grantId: principal.grantId,
      digest,
      request: { kind: 'capture', ...request, limits: input.config.limits },
      record,
      work: { kind: 'capture', attempts: 0 },
      reservedBytes: input.config.limits.maxBytes,
    });
    await tx.insert(auditEvents).values({
      accountId: principal.accountId,
      subjectId: request.id,
      event: 'backup.admitted',
      details: {
        machineId,
        grantId: principal.grantId,
        retainUntil,
        reservedBytes: input.config.limits.maxBytes,
      },
    });
    await enqueueBackup(tx, 'backup', request.id);
    return record;
  }
  async function restore(
    principal: Principal,
    request: RestoreRequest,
    provisioning: Omit<Parameters<typeof admit>[0], 'db' | 'principal' | 'request' | 'key'>,
  ) {
    const digest = backupDigest(request);
    return input.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(78131025)`);
      await lockAccount(tx, principal);
      const authority = await loadAuthority(tx, principal.grantId);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`restore:${request.id}`}, 0))`,
      );
      const [existing] = await tx
        .select()
        .from(backupRestores)
        .where(eq(backupRestores.id, request.id));
      if (existing) {
        if (existing.accountId !== principal.accountId || existing.digest !== digest)
          throw new CloudError(
            'idempotency_conflict',
            'Restore ID belongs to a different request.',
          );
        const record = restoreRecord(existing);
        authorize(authority.principal, 'backup:restore', record.projectId);
        return record;
      }
      const [row] = await tx
        .select()
        .from(backups)
        .where(and(eq(backups.id, request.backupId), eq(backups.accountId, principal.accountId)));
      if (!row) throw new CloudError('not_found', 'Backup not found.');
      const backup = backupRecord(row);
      authorize(authority.principal, 'backup:restore', backup.projectId);
      if (backup.state.kind !== 'captured' || backupWorkSchema.parse(row.work).kind !== 'stored')
        throw new CloudError(
          'resource_busy',
          'Restore needs a verified off-machine backup object.',
        );
      const operation = await admit({
        ...provisioning,
        db: tx,
        principal: authority.principal,
        key: `backup-restore:${request.id}`,
        request: { kind: 'create', projectId: backup.projectId, spec: request.machine },
      });
      const record = restoreSummarySchema.parse({
        id: request.id,
        backupId: backup.id,
        accountId: principal.accountId,
        projectId: backup.projectId,
        machineId: operation.machineId,
        operationId: operation.id,
        createdAt: authority.checkedAt.toISOString(),
        state: { kind: 'pending' },
      });
      await tx.insert(backupRestores).values({
        id: request.id,
        backupId: backup.id,
        accountId: principal.accountId,
        machineId: operation.machineId,
        grantId: principal.grantId,
        digest,
        request,
        record,
        work: { kind: 'waiting' },
      });
      await tx.insert(auditEvents).values({
        accountId: principal.accountId,
        subjectId: request.id,
        event: 'backup.restore_admitted',
        details: {
          backupId: backup.id,
          machineId: operation.machineId,
          grantId: principal.grantId,
        },
      });
      await enqueueBackup(tx, 'restore', request.id);
      return record;
    });
  }
  async function inspectRestore(principal: Principal, id: string) {
    const [row] = await input.db
      .select()
      .from(backupRestores)
      .where(and(eq(backupRestores.id, id), eq(backupRestores.accountId, principal.accountId)));
    if (!row) throw new CloudError('not_found', 'Restore not found.');
    const record = restoreRecord(row);
    authorize(principal, 'backup:read', record.projectId);
    return record;
  }
  const schedules = createBackupSchedules({ db: input.db, capture: captureInTransaction });
  return {
    limits: {
      maxAccountBytes: input.config.maxAccountBytes,
      maxCaptureBytes: input.config.limits.maxBytes,
    },
    capture,
    list,
    inspect,
    restore,
    inspectRestore,
    schedules,
    purges: createBackupPurges(input.db),
    advance: input.advance,
  };
}
export type BackupService = ReturnType<typeof createBackups>;

/** Restores are quarantined until the recorded database/services verification succeeds. */
export async function assertRestoreAccessible(db: Executor, machineId: MachineId) {
  const [row] = await db
    .select()
    .from(backupRestores)
    .where(eq(backupRestores.machineId, machineId));
  if (row && restoreRecord(row).state.kind !== 'restored')
    throw new CloudError(
      'resource_busy',
      'This isolated restore target is not verified. Inspect the restore or destroy this target; it cannot accept customer access or routes yet.',
    );
}

import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  CloudError,
  backupIdSchema,
  backupRecipeSchema,
  backupScheduleSchema,
  failureSchema,
  grantIdSchema,
  accountIdSchema,
  projectIdSchema,
  type BackupScheduleRequest,
  type BackupSummary,
  type MachineId,
  type Principal,
  type backupCaptureRequestSchema,
} from '@agent-cloud/contracts';
import {
  backupSchedules,
  backupScheduleRuns,
  backups,
  machines,
  machineRecord,
  auditEvents,
  databaseTime,
  type Database,
  type Transaction,
} from '@agent-cloud/db';
import { authorize, loadAuthority } from './auth.js';
import { lockAccount } from './lifecycle.js';
import { backupDigest, backupRecord } from './backup-records.js';

const attemptSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('admitted'), at: z.iso.datetime(), backupId: backupIdSchema }),
  z.strictObject({ kind: z.literal('refused'), at: z.iso.datetime(), failure: failureSchema }),
]);
const dayMs = 86_400_000;

/** Daily admission shares capture's transaction and budgets; no remote work or backlog replay. */
export function createBackupSchedules(input: {
  db: Database;
  capture: (
    tx: Transaction,
    principal: Principal,
    machine: MachineId,
    request: z.infer<typeof backupCaptureRequestSchema>,
  ) => Promise<BackupSummary>;
}) {
  async function summary(row: typeof backupSchedules.$inferSelect) {
    const attempt = attemptSchema.parse(row.lastAttempt);
    const [successful] = await input.db
      .select({ backup: backups })
      .from(backupScheduleRuns)
      .innerJoin(backups, eq(backups.id, backupScheduleRuns.backupId))
      .where(
        and(
          eq(backupScheduleRuns.scheduleId, row.id),
          sql`${backups.record}->'state'->>'kind' = 'captured'`,
        ),
      )
      .orderBy(desc(backupScheduleRuns.dueAt))
      .limit(1);
    let lastAttempt;
    if (attempt.kind === 'admitted') {
      const [captured] = await input.db
        .select()
        .from(backups)
        .where(and(eq(backups.id, attempt.backupId), eq(backups.accountId, row.accountId)));
      if (!captured) throw new Error('Scheduled backup receipt is missing.');
      lastAttempt = { kind: 'admitted', at: attempt.at, backup: backupRecord(captured) };
    } else lastAttempt = attempt;
    return backupScheduleSchema.parse({
      id: row.id,
      accountId: row.accountId,
      projectId: row.projectId,
      machineId: row.machineId,
      allocationId: row.allocationId,
      recipe: row.recipe,
      createdAt: row.createdAt.toISOString(),
      state: row.disabledAt
        ? { kind: 'disabled', disabledAt: row.disabledAt.toISOString() }
        : { kind: 'enabled', nextRunAt: row.nextRunAt.toISOString() },
      lastAttempt,
      lastSuccessfulBackup: successful ? backupRecord(successful.backup) : null,
    });
  }
  async function owned(tx: Database | Transaction, principal: Principal, id: string) {
    const [row] = await tx
      .select()
      .from(backupSchedules)
      .where(and(eq(backupSchedules.id, id), eq(backupSchedules.accountId, principal.accountId)));
    if (!row) throw new CloudError('not_found', 'Backup schedule not found.');
    return row;
  }
  async function inspect(principal: Principal, id: string) {
    const row = await owned(input.db, principal, id);
    authorize(principal, 'backup:read', projectIdSchema.parse(row.projectId));
    return summary(row);
  }
  async function list(principal: Principal, machineId: MachineId) {
    const [machine] = await input.db
      .select()
      .from(machines)
      .where(and(eq(machines.id, machineId), eq(machines.accountId, principal.accountId)));
    if (!machine) throw new CloudError('not_found', 'Machine not found.');
    authorize(principal, 'backup:read', machineRecord(machine).projectId);
    const rows = await input.db
      .select()
      .from(backupSchedules)
      .where(eq(backupSchedules.machineId, machineId))
      .orderBy(desc(backupSchedules.createdAt))
      .limit(100);
    return Promise.all(rows.map(summary));
  }
  async function create(
    principal: Principal,
    machineId: MachineId,
    request: BackupScheduleRequest,
  ) {
    const digest = backupDigest({ machineId, request });
    const row = await input.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`backup-schedule:${request.id}`}, 0))`,
      );
      await lockAccount(tx, principal);
      const authority = await loadAuthority(tx, principal.grantId);
      const [existing] = await tx
        .select()
        .from(backupSchedules)
        .where(eq(backupSchedules.id, request.id));
      if (existing) {
        if (existing.accountId !== principal.accountId || existing.digest !== digest)
          throw new CloudError('idempotency_conflict', 'Schedule ID belongs to different inputs.');
        authorize(authority.principal, 'backup:create', projectIdSchema.parse(existing.projectId));
        return existing;
      }
      const [row] = await tx
        .select()
        .from(machines)
        .where(and(eq(machines.id, machineId), eq(machines.accountId, principal.accountId)));
      if (!row) throw new CloudError('not_found', 'Machine not found.');
      const machine = machineRecord(row);
      authorize(authority.principal, 'backup:create', machine.projectId);
      if (machine.state.kind !== 'allocated' || machine.state.guest.kind !== 'ssh')
        throw new CloudError('resource_busy', 'Daily backups need a verified allocated guest.');
      const active = await tx
        .select()
        .from(backupSchedules)
        .where(
          and(
            eq(backupSchedules.accountId, principal.accountId),
            isNull(backupSchedules.disabledAt),
          ),
        );
      if (
        active.some(
          (schedule) =>
            schedule.machineId === machineId &&
            backupRecipeSchema.parse(schedule.recipe).app === request.recipe.app,
        )
      )
        throw new CloudError(
          'resource_busy',
          'This app already has a daily schedule. Disable it before creating a schedule for new recipe inputs.',
        );
      if (active.length >= 10)
        throw new CloudError(
          'quota_exceeded',
          'An account can have ten active daily backup schedules.',
        );
      const recent = await tx
        .select({ id: backupSchedules.id })
        .from(backupSchedules)
        .where(
          and(
            eq(backupSchedules.accountId, principal.accountId),
            sql`${backupSchedules.createdAt} > clock_timestamp() - interval '1 hour'`,
          ),
        )
        .limit(30);
      if (recent.length >= 30)
        throw new CloudError(
          'quota_exceeded',
          'Schedule creation is limited to thirty per account per hour.',
        );
      const [created] = await tx
        .insert(backupSchedules)
        .values({
          id: request.id,
          accountId: principal.accountId,
          projectId: machine.projectId,
          machineId,
          allocationId: machine.state.allocationId,
          grantId: principal.grantId,
          digest,
          recipe: request.recipe,
          nextRunAt: authority.checkedAt,
        })
        .returning();
      if (!created) throw new Error('Schedule admission was not recorded.');
      await tx.insert(auditEvents).values({
        accountId: principal.accountId,
        subjectId: request.id,
        event: 'backup.schedule_created',
        details: { machineId, grantId: principal.grantId },
      });
      return created;
    });
    return summary(row);
  }
  async function disable(principal: Principal, id: string) {
    const row = await input.db.transaction(async (tx) => {
      await lockAccount(tx, principal);
      const authority = await loadAuthority(tx, principal.grantId);
      const row = await owned(tx, principal, id);
      authorize(authority.principal, 'backup:create', projectIdSchema.parse(row.projectId));
      if (row.disabledAt) return row;
      const [updated] = await tx
        .update(backupSchedules)
        .set({ disabledAt: authority.checkedAt })
        .where(eq(backupSchedules.id, id))
        .returning();
      if (!updated) throw new Error('Schedule disable was not recorded.');
      await tx.insert(auditEvents).values({
        accountId: principal.accountId,
        subjectId: id,
        event: 'backup.schedule_disabled',
        details: { grantId: principal.grantId },
      });
      return updated;
    });
    return summary(row);
  }
  async function advance(id: string) {
    await input.db.transaction(async (tx) => {
      // Same lock order as capture, restore and VM admission. Disable shares the account lock.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(78131025)`);
      const [selected] = await tx.select().from(backupSchedules).where(eq(backupSchedules.id, id));
      if (!selected) return;
      await lockAccount(tx, { accountId: accountIdSchema.parse(selected.accountId) });
      const [row] = await tx.select().from(backupSchedules).where(eq(backupSchedules.id, id));
      const now = await databaseTime(tx);
      if (!row || row.disabledAt || row.nextRunAt > now) return;
      let lastAttempt: z.infer<typeof attemptSchema>;
      let disabledAt: Date | null = null;
      try {
        const authority = await loadAuthority(tx, grantIdSchema.parse(row.grantId));
        authorize(authority.principal, 'backup:create', projectIdSchema.parse(row.projectId));
        const [machine] = await tx.select().from(machines).where(eq(machines.id, row.machineId));
        if (!machine) throw new Error('Scheduled source machine is missing.');
        const source = machineRecord(machine);
        if (source.state.kind !== 'allocated' || source.state.allocationId !== row.allocationId)
          throw new CloudError(
            'resource_busy',
            'The scheduled source allocation is no longer available. Disable this schedule and configure the intended replacement.',
          );
        const capture = await input.capture(tx, authority.principal, source.id, {
          id: backupIdSchema.parse(randomUUID()),
          recipe: backupRecipeSchema.parse(row.recipe),
        });
        await tx.insert(backupScheduleRuns).values({
          accountId: row.accountId,
          scheduleId: row.id,
          backupId: capture.id,
          dueAt: row.nextRunAt,
        });
        lastAttempt = { kind: 'admitted', at: now.toISOString(), backupId: capture.id };
      } catch (error) {
        if (!(error instanceof CloudError)) throw error;
        lastAttempt = { kind: 'refused', at: now.toISOString(), failure: error.failure };
        if (['unauthenticated', 'permission_denied'].includes(error.failure.code)) disabledAt = now;
      }
      // A restart after several missed days admits one capture, never a catch-up burst.
      await tx
        .update(backupSchedules)
        .set({ lastAttempt, disabledAt, nextRunAt: new Date(now.getTime() + dayMs) })
        .where(eq(backupSchedules.id, id));
    });
  }
  async function reconcile() {
    const due = await input.db
      .select({ id: backupSchedules.id })
      .from(backupSchedules)
      .where(
        and(
          isNull(backupSchedules.disabledAt),
          sql`${backupSchedules.nextRunAt} <= clock_timestamp()`,
        ),
      )
      .orderBy(backupSchedules.nextRunAt)
      .limit(100);
    for (const row of due) await advance(row.id);
  }
  return { create, list, inspect, disable, advance, reconcile };
}

import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import {
  CloudError,
  usageResponseSchema,
  reservationHistoryResponseSchema,
  type Principal,
} from '@agent-cloud/contracts';
import {
  accounts,
  allocations,
  allocationReservations,
  backups,
  machines,
  type Database,
} from '@agent-cloud/db';
import { authorize } from './auth.js';

export async function readUsage(input: {
  db: Database;
  principal: Principal;
  backupLimits?: { maxAccountBytes: number; maxCaptureBytes: number };
}) {
  const { principal } = input;
  authorize(principal, 'usage:read');
  // Both resource aggregates and limits describe one database snapshot.
  return input.db.transaction(
    async (tx) => {
      const [account] = await tx
        .select()
        .from(accounts)
        .where(eq(accounts.id, principal.accountId));
      const [vm] = await tx
        .select({
          count: sql<number>`count(*)::float8`,
          price: sql<number>`coalesce(sum(${allocations.hourlyMicros}), 0)::float8`,
        })
        .from(allocations)
        .where(and(eq(allocations.accountId, principal.accountId), isNull(allocations.retiredAt)));
      const [storage] = await tx
        .select({
          reservedBytes: sql<number>`coalesce(sum(${backups.reservedBytes}), 0)::float8`,
          retainedCount: sql<number>`count(*) FILTER (WHERE ${backups.record}->'state'->>'kind' = 'captured')::float8`,
          unresolvedCount: sql<number>`count(*) FILTER (WHERE ${backups.reservedBytes} > 0 AND ${backups.record}->'state'->>'kind' IN ('pending', 'blocked'))::float8`,
          purgePendingCount: sql<number>`count(*) FILTER (WHERE ${backups.record}->'state'->>'kind' = 'purge_pending')::float8`,
        })
        .from(backups)
        .where(eq(backups.accountId, principal.accountId));
      if (!account || !vm || !storage || account.currency !== principal.policy.currency)
        throw new CloudError('internal_error', 'Usage does not match the credential account.');
      const effective = {
        maxMachines: Math.min(account.maxMachines, principal.policy.maxMachines),
        maxHourlyMicros: Math.min(account.maxHourlyMicros, principal.policy.maxHourlyMicros),
      };
      return usageResponseSchema.parse({
        usage: {
          scope: 'account',
          activeReservations: vm.count,
          hourlyMicros: vm.price,
          currency: account.currency,
          pricing: 'reservation',
          poweredOffMachinesRemainBillable: true,
          limits: {
            account: { maxMachines: account.maxMachines, maxHourlyMicros: account.maxHourlyMicros },
            grant: {
              maxMachines: principal.policy.maxMachines,
              maxHourlyMicros: principal.policy.maxHourlyMicros,
            },
            effective,
            remainingMachines: Math.max(0, effective.maxMachines - vm.count),
            remainingHourlyMicros: Math.max(0, effective.maxHourlyMicros - vm.price),
            deploymentCapacityAlsoApplies: true,
          },
          backups: {
            ...storage,
            limits: input.backupLimits
              ? {
                  ...input.backupLimits,
                  remainingBytes: Math.max(
                    0,
                    input.backupLimits.maxAccountBytes - storage.reservedBytes,
                  ),
                }
              : null,
            machineDestructionReleasesBackups: false,
          },
        },
      });
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

export async function readReservationHistory(input: {
  db: Database;
  principal: Principal;
  before?: string;
}) {
  const { principal } = input;
  authorize(principal, 'usage:read');
  const rows = await input.db
    .select({
      reservation: allocationReservations,
      projectId: machines.projectId,
    })
    .from(allocationReservations)
    .innerJoin(
      machines,
      and(
        eq(machines.id, allocationReservations.machineId),
        eq(machines.accountId, allocationReservations.accountId),
      ),
    )
    .where(
      and(
        eq(allocationReservations.accountId, principal.accountId),
        principal.policy.projects.kind === 'selected'
          ? inArray(machines.projectId, principal.policy.projects.ids)
          : undefined,
        input.before ? lt(allocationReservations.id, BigInt(input.before)) : undefined,
      ),
    )
    .orderBy(desc(allocationReservations.id))
    .limit(101);
  const page = rows.slice(0, 100);
  return reservationHistoryResponseSchema.parse({
    history: page.map(({ reservation, projectId }) => ({
      ...reservation,
      id: reservation.id.toString(),
      occurredAt: reservation.occurredAt.toISOString(),
      projectId,
    })),
    nextCursor: rows.length > 100 ? page.at(-1)?.reservation.id.toString() : null,
    pricing: 'reservation',
  });
}

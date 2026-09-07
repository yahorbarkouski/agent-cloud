import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  CloudError,
  providerCommandSchema,
  attemptOutcomeSchema,
  effectResolutionSchema,
  isServerCreateCommand,
  type MachineProvider,
  type Operation,
  type ProviderCommand,
} from '@agent-cloud/contracts';
import {
  allocations,
  operations,
  machines,
  operationCleanups,
  attempts,
  providerResources,
  auditEvents,
  databaseTime,
  type Database,
} from '@agent-cloud/db';
import { journalEffect, resolveEffect, setProgress, type Attempt } from './effect-journal.js';
import {
  cleanupDeleteLimit,
  ownedLabels,
  ownedRef,
  matchesLabels,
  recordAbsence,
  type Allocation,
} from './resource-journal.js';
import type { Config } from './config.js';

type CleanupWork = {
  db: Database;
  operation: Operation;
  allocation: Allocation;
  provider: MachineProvider;
  limits: Config['limits'];
};
const pending = (attempt: Attempt) =>
  effectResolutionSchema.parse(attempt.resolution).kind === 'pending';
function deletion(command: ProviderCommand) {
  return command.kind === 'destroy' || command.kind === 'delete_primary_ip';
}
function targets(attempt: Attempt, kind: string, id: string) {
  const command = providerCommandSchema.parse(attempt.command);
  return kind === 'server'
    ? command.kind === 'destroy' && command.serverId === id
    : command.kind === 'delete_primary_ip' && command.primaryIpId === id;
}

/** Called only under the existing machine lock; source results are never reopened. */
export async function advanceCleanup(work: CleanupWork): Promise<void> {
  try {
    await advance(work);
  } catch (error) {
    if (!(error instanceof CloudError)) throw error;
    if (error.failure.code === 'provider_unavailable' && error.failure.retryable) return;
    await setProgress(work.db, work.operation, {
      kind: 'blocked',
      reason: 'provider_resource_mismatch',
    });
  }
}

async function advance(work: CleanupWork) {
  const { db, operation, allocation, provider } = work;
  const [authority] = await db
    .select()
    .from(operationCleanups)
    .where(
      and(
        eq(operationCleanups.operationId, operation.id),
        eq(operationCleanups.accountId, operation.accountId),
        eq(operationCleanups.allocationId, allocation.id),
      ),
    );
  if (
    !authority ||
    operation.intent.kind !== 'cleanup' ||
    operation.intent.sourceOperationId !== authority.sourceOperationId
  )
    throw new CloudError('permission_denied', 'Cleanup authority does not match this operation.');
  const operationIds = [...new Set([operation.id, authority.sourceOperationId])];
  const readHistory = () =>
    db
      .select()
      .from(attempts)
      .where(inArray(attempts.operationId, operationIds))
      .orderBy(asc(attempts.createdAt), asc(attempts.sequence));
  const readResources = () =>
    db
      .select()
      .from(providerResources)
      .where(eq(providerResources.allocationId, allocation.id))
      .orderBy(asc(providerResources.createdAt), asc(providerResources.providerId));
  let history = await readHistory();
  let resources = await readResources();
  for (const attempt of history.filter(pending)) {
    const command = providerCommandSchema.parse(attempt.command);
    const target = resources.find((resource) =>
      targets(attempt, resource.kind, resource.providerId),
    );
    if (deletion(command) && !target)
      throw new CloudError('permission_denied', 'Deletion has no retained owned resource.');
    await resolveEffect({
      ...work,
      attempt,
      expectedLabels: target ? ownedLabels(target) : 'labels' in command ? command.labels : {},
    });
  }
  history = await readHistory();
  resources = await readResources();
  const live = resources.filter((resource) => !resource.absentAt);
  const pendingVm = history.some(
    (attempt) =>
      pending(attempt) && isServerCreateCommand(providerCommandSchema.parse(attempt.command)),
  );
  const resource =
    live.find((row) => row.kind === 'server') ??
    (!pendingVm ? live.find((row) => row.kind === 'primary_ip') : undefined);
  if (resource) {
    const ref = ownedRef(resource);
    const observed =
      ref.kind === 'server'
        ? await provider.getServer({ serverId: ref.id })
        : await provider.getPrimaryIp({ primaryIpId: ref.id });
    if (!observed) {
      await recordAbsence(db, allocation, ref);
      return;
    }
    if (
      observed.id !== ref.id ||
      !matchesLabels(observed.labels, ownedLabels(resource)) ||
      ('assignment' in observed && observed.assignment.kind !== 'unassigned')
    ) {
      await setProgress(db, operation, { kind: 'blocked', reason: 'provider_resource_mismatch' });
      return;
    }
    if ('primaryIpId' in observed && observed.primaryIpId) {
      const ipResource = resources.find(
        (row) =>
          row.kind === 'primary_ip' && row.providerId === observed.primaryIpId && !row.absentAt,
      );
      const ip = await provider.getPrimaryIp({ primaryIpId: observed.primaryIpId });
      if (
        !ipResource ||
        !ip ||
        ip.id !== ipResource.providerId ||
        !matchesLabels(ip.labels, ownedLabels(ipResource)) ||
        ip.assignment.kind !== 'server' ||
        ip.assignment.serverId !== observed.id
      ) {
        await setProgress(db, operation, { kind: 'blocked', reason: 'provider_resource_mismatch' });
        return;
      }
      // Server deletion must not implicitly delete an IP that an unsettled create can still use.
      if (pendingVm && ip.autoDelete) return;
    }
    const previous = history.filter((attempt) => targets(attempt, ref.kind, ref.id));
    const latest = previous.at(-1);
    if (latest) {
      const outcome = attemptOutcomeSchema.parse(latest.outcome);
      if (pending(latest) && outcome.kind === 'accepted') {
        const action = await provider.getAction({ actionId: outcome.actionId });
        if (action.kind !== 'succeeded') return;
      }
      const command: ProviderCommand =
        ref.kind === 'server'
          ? { kind: 'destroy', serverId: ref.id }
          : { kind: 'delete_primary_ip', primaryIpId: ref.id };
      if (previous.length >= (await cleanupDeleteLimit(db, operation.id, command))) {
        await setProgress(db, operation, { kind: 'blocked', reason: 'cleanup_retry_exhausted' });
        return;
      }
      const delayMs = previous.length === 1 ? 5_000 : 30_000;
      if ((await databaseTime(db)).getTime() < latest.createdAt.getTime() + delayMs) return;
    }
    await journalEffect({
      ...work,
      authorization: 'admitted_cleanup',
      command:
        ref.kind === 'server'
          ? { kind: 'destroy', serverId: ref.id }
          : { kind: 'delete_primary_ip', primaryIpId: ref.id },
    });
    return;
  }
  if (history.some(pending) || live.length) return;
  await db.transaction(async (tx) => {
    const now = await databaseTime(tx);
    // SQL repeats the absence/pending checks and rejects retirement if the journal changes.
    await tx
      .update(allocations)
      .set({ retiredAt: now })
      .where(and(eq(allocations.id, allocation.id), isNull(allocations.retiredAt)));
    await tx
      .update(machines)
      .set({
        state: { kind: 'destroyed', destroyedAt: now.toISOString() },
        version: sql`${machines.version} + 1`,
      })
      .where(eq(machines.id, operation.machineId));
    await tx
      .update(operations)
      .set({
        progress: {
          kind: operation.kind === 'machine.create' ? 'cancelled' : 'succeeded',
          completedAt: now.toISOString(),
        },
      })
      .where(eq(operations.id, operation.id));
    await tx.insert(auditEvents).values({
      accountId: operation.accountId,
      subjectId: operation.id,
      event: 'cleanup.completed',
      details: { allocationId: allocation.id, sourceOperationId: authority.sourceOperationId },
    });
  });
}

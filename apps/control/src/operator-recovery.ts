import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  CloudError,
  attemptIdSchema,
  attemptOutcomeSchema,
  effectResolutionSchema,
  isOperationTerminal,
  isServerCreateCommand,
  operatorRecoverySchema,
  providerCommandSchema,
  type MachineProvider,
  type OperationId,
  type OperatorRecovery,
} from '@agent-cloud/contracts';
import {
  allocations,
  attempts,
  auditEvents,
  enqueueOperation,
  operationCleanups,
  operationRecord,
  operations,
  operatorRecoveries,
  providerResources,
  withMachineLock,
  type Connection,
  type Database,
} from '@agent-cloud/db';
import {
  claimResource,
  cleanupDeleteLimit,
  matchesLabels,
  ownedLabels,
} from './resource-journal.js';

export type RecoveryProvider = Pick<
  MachineProvider,
  'kind' | 'getServer' | 'getPrimaryIp' | 'getAction' | 'findServers' | 'findPrimaryIps'
>;

async function state(db: Database, operationId: OperationId) {
  const [authority] = await db
    .select()
    .from(operationCleanups)
    .where(eq(operationCleanups.operationId, operationId));
  if (!authority)
    throw new CloudError('permission_denied', 'Admit machine destroy before operator recovery.');
  const [row] = await db.select().from(operations).where(eq(operations.id, operationId));
  const [allocation] = await db
    .select()
    .from(allocations)
    .where(eq(allocations.id, authority.allocationId));
  if (!row || !allocation) throw new CloudError('internal_error', 'Cleanup ownership is missing.');
  const history = await db
    .select()
    .from(attempts)
    .where(inArray(attempts.operationId, [...new Set([operationId, authority.sourceOperationId])]))
    .orderBy(asc(attempts.createdAt), asc(attempts.sequence));
  const resources = await db
    .select()
    .from(providerResources)
    .where(eq(providerResources.allocationId, allocation.id))
    .orderBy(asc(providerResources.kind), asc(providerResources.providerId));
  const recoveries = await db
    .select()
    .from(operatorRecoveries)
    .where(eq(operatorRecoveries.operationId, operationId))
    .orderBy(asc(operatorRecoveries.id));
  const snapshot = {
    authority,
    operation: operationRecord(row),
    allocation,
    attempts: history.map((attempt) => ({
      ...attempt,
      command: providerCommandSchema.parse(attempt.command),
      outcome: attemptOutcomeSchema.parse(attempt.outcome),
      resolution: effectResolutionSchema.parse(attempt.resolution),
    })),
    resources: resources.map((resource) => ({ ...resource, labels: ownedLabels(resource) })),
    recoveries: recoveries.map((recovery) => ({
      ...recovery,
      request: operatorRecoverySchema.parse(recovery.request),
    })),
  };
  return {
    ...snapshot,
    stateDigest: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
  };
}

async function locked<T>(
  connection: Connection,
  operationId: OperationId,
  work: (db: Database) => Promise<T>,
) {
  const [operation] = await connection.db
    .select()
    .from(operations)
    .where(eq(operations.id, operationId));
  if (!operation) throw new CloudError('not_found', 'Operation not found.');
  const result = await withMachineLock({
    pool: connection.pool,
    machineId: operation.machineId,
    work,
  });
  if (result.kind === 'busy')
    throw new CloudError('resource_busy', 'Machine is busy; retry inspection or recovery.', true);
  return result.value;
}

export function inspectOperatorRecovery(connection: Connection, operationId: OperationId) {
  return locked(connection, operationId, (db) => state(db, operationId));
}

/** Operator-only database boundary. No provider mutation or guest signing is available here. */
export async function applyOperatorRecovery(input: {
  connection: Connection;
  provider: RecoveryProvider;
  request: OperatorRecovery;
}) {
  const request = operatorRecoverySchema.parse(input.request);
  return locked(input.connection, request.operationId, async (db) => {
    const [saved] = await db
      .select()
      .from(operatorRecoveries)
      .where(eq(operatorRecoveries.id, request.id));
    if (saved) {
      if (!isDeepStrictEqual(operatorRecoverySchema.parse(saved.request), request))
        throw new CloudError(
          'idempotency_conflict',
          'This recovery ID already describes a different decision.',
        );
      return saved;
    }
    const current = await state(db, request.operationId);
    const { allocation, operation, authority } = current;
    if (
      request.accountId !== authority.accountId ||
      request.allocationId !== allocation.id ||
      input.provider.kind !== allocation.provider
    )
      throw new CloudError(
        'permission_denied',
        'Recovery scope or provider does not match its cleanup.',
      );
    if (allocation.retiredAt || isOperationTerminal(operation))
      throw new CloudError('permission_denied', 'Recovery cannot reopen completed cleanup.');
    if (request.expectedState !== current.stateDigest)
      throw new CloudError('version_conflict', 'Recovery state changed; inspect it again.');
    const target = current.attempts.find((attempt) => attempt.id === request.attemptId);
    if (!target)
      throw new CloudError('permission_denied', 'Target attempt is outside this cleanup.');
    const command = target.command;
    if (request.kind === 'close_create') {
      if (
        target.operationId !== authority.sourceOperationId ||
        target.resolution.kind !== 'pending' ||
        !['prepared', 'unknown'].includes(target.outcome.kind) ||
        (!isServerCreateCommand(command) && command.kind !== 'create_primary_ip')
      )
        throw new CloudError(
          'permission_denied',
          'Only an uncertain source create can receive provider closure.',
        );
      const kind = command.kind === 'create_primary_ip' ? 'primary_ip' : 'server';
      const matches =
        command.kind === 'create_primary_ip'
          ? await input.provider.findPrimaryIps({ labels: command.labels })
          : await input.provider.findServers({ labels: command.labels });
      let mismatch = false;
      for (const match of matches) {
        if (!matchesLabels(match.labels, command.labels)) {
          mismatch = true;
          continue;
        }
        const known = current.resources.find(
          (resource) => resource.kind === kind && resource.providerId === match.id,
        );
        if (known) {
          if (known.absentAt || !matchesLabels(known.labels, command.labels)) mismatch = true;
          continue;
        }
        try {
          await claimResource(db, {
            allocation,
            resource: { kind, id: match.id },
            labels: command.labels,
          });
        } catch (error) {
          if (!(error instanceof CloudError)) throw error;
          mismatch = true;
        }
      }
      // Discoveries survive rejection. The operator must acknowledge the new ledger, not erase it.
      const discovered = await state(db, request.operationId);
      if (discovered.stateDigest !== request.expectedState)
        throw new CloudError(
          'version_conflict',
          'Provider inventory added evidence; inspect recovery again.',
        );
      if (mismatch)
        throw new CloudError(
          'provider_outcome_unknown',
          'Provider inventory conflicts with retained ownership.',
        );
      const sourceResources = current.resources.filter(
        (resource) => resource.kind === kind && resource.labels.operation_id === target.operationId,
      );
      if (
        !isDeepStrictEqual(
          sourceResources.map((resource) => resource.providerId).sort(),
          [...request.resourceIds].sort(),
        )
      )
        throw new CloudError(
          'invalid_input',
          'Closure must acknowledge every retained source resource ID.',
        );
      for (const resource of sourceResources) {
        const observed =
          kind === 'server'
            ? await input.provider.getServer({ serverId: resource.providerId })
            : await input.provider.getPrimaryIp({ primaryIpId: resource.providerId });
        if (
          observed &&
          (resource.absentAt ||
            observed.id !== resource.providerId ||
            !matchesLabels(observed.labels, resource.labels))
        )
          throw new CloudError(
            'provider_outcome_unknown',
            'Exact provider identity conflicts with the recovery evidence.',
          );
      }
    } else {
      const kind =
        command.kind === 'destroy'
          ? 'server'
          : command.kind === 'delete_primary_ip'
            ? 'primary_ip'
            : undefined;
      const id =
        command.kind === 'destroy'
          ? command.serverId
          : command.kind === 'delete_primary_ip'
            ? command.primaryIpId
            : undefined;
      if (!kind || !id)
        throw new CloudError('permission_denied', 'Retry authority requires a deletion attempt.');
      const history = current.attempts.filter((attempt) =>
        isDeepStrictEqual(attempt.command, command),
      );
      if (
        history.at(-1)?.id !== target.id ||
        history.length !== (await cleanupDeleteLimit(db, operation.id, command))
      )
        throw new CloudError(
          'permission_denied',
          'Retry requires the latest exhausted exact-target deletion.',
        );
      const resource = current.resources.find(
        (row) => row.kind === kind && row.providerId === id && !row.absentAt,
      );
      const observed =
        kind === 'server'
          ? await input.provider.getServer({ serverId: id })
          : await input.provider.getPrimaryIp({ primaryIpId: id });
      if (
        !resource ||
        !observed ||
        observed.id !== id ||
        !matchesLabels(observed.labels, resource.labels) ||
        ('assignment' in observed && observed.assignment.kind !== 'unassigned')
      )
        throw new CloudError(
          'provider_outcome_unknown',
          'Deletion target is absent or ownership changed; reconcile cleanup.',
        );
      if (
        target.resolution.kind === 'pending' &&
        target.outcome.kind === 'accepted' &&
        (await input.provider.getAction({ actionId: target.outcome.actionId })).kind === 'running'
      )
        throw new CloudError('resource_busy', 'The latest deletion action is still running.', true);
    }
    return db.transaction(async (tx) => {
      if ((await state(tx, operation.id)).stateDigest !== request.expectedState)
        throw new CloudError('version_conflict', 'Recovery state changed before admission.');
      const [record] = await tx
        .insert(operatorRecoveries)
        .values({
          id: request.id,
          operationId: operation.id,
          attemptId: request.attemptId,
          request,
        })
        .returning();
      if (!record) throw new CloudError('internal_error', 'Recovery was not recorded.');
      if (request.kind === 'close_create')
        await tx
          .update(attempts)
          .set({ resolution: { kind: 'operator_closed', recoveryId: request.id } })
          .where(
            and(eq(attempts.id, target.id), eq(attempts.operationId, authority.sourceOperationId)),
          );
      await tx.insert(auditEvents).values({
        accountId: operation.accountId,
        subjectId: operation.id,
        event: 'cleanup.operator_recovery',
        details: {
          recoveryId: request.id,
          attemptId: attemptIdSchema.parse(target.id),
          kind: request.kind,
        },
      });
      await enqueueOperation(tx, operation.id);
      return record;
    });
  });
}

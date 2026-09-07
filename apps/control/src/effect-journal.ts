import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  CloudError,
  newId,
  catalogItemSchema,
  selectOffer,
  lifecycleCommandSchema,
  providerCommandSchema,
  isServerCreateCommand,
  operationIntentSchema,
  attemptOutcomeSchema,
  effectResolutionSchema,
  attemptIdSchema,
  type Operation,
  type ProviderCommand,
  type MachineProvider,
  type OperationProgress,
  type Submission,
  type ResourceRef,
  type EffectResolution,
  type ResourceObservation,
} from '@agent-cloud/contracts';
import {
  operations,
  operationCleanups,
  providerResources,
  attempts,
  accounts,
  allocations,
  auditEvents,
  type Database,
} from '@agent-cloud/db';
import type { Config } from './config.js';
import { loadPrincipal } from './auth.js';
import { authorizeCommand } from './lifecycle.js';
import {
  claimResource,
  recordAbsence,
  matchesLabels,
  type Allocation,
} from './resource-journal.js';

export type Attempt = typeof attempts.$inferSelect;
export async function setProgress(db: Database, operation: Operation, progress: OperationProgress) {
  await db.transaction(async (tx) => {
    const changed = await tx
      .update(operations)
      .set({ progress })
      .where(
        and(
          eq(operations.id, operation.id),
          sql`${operations.progress} IS DISTINCT FROM ${JSON.stringify(progress)}::jsonb`,
        ),
      )
      .returning({ id: operations.id });
    if (changed.length)
      await tx.insert(auditEvents).values({
        accountId: operation.accountId,
        subjectId: operation.id,
        event: `operation.${progress.kind}`,
        details: progress,
      });
  });
}
function resourceKind(command: ProviderCommand) {
  return command.kind === 'create_primary_ip' || command.kind === 'delete_primary_ip'
    ? 'primary_ip'
    : 'server';
}
export async function journalEffect(input: {
  db: Database;
  operation: Operation;
  allocation: Allocation;
  command: ProviderCommand;
  provider: MachineProvider;
  limits: Config['limits'];
  authorization: 'fresh' | 'cleanup' | 'admitted_cleanup';
}) {
  const { db, operation, allocation, command, provider, limits } = input;
  const monetary =
    command.kind === 'create_primary_ip' ||
    isServerCreateCommand(command) ||
    command.kind === 'resize';
  if (monetary) {
    const [stored] = await db.select().from(operations).where(eq(operations.id, operation.id));
    const offer = catalogItemSchema.parse(stored?.offer);
    const catalog = await provider.getCatalog();
    const current = selectOffer({ catalog, size: offer.size, region: offer.region });
    if (
      catalog.provider !== allocation.provider ||
      current.serverType !== offer.serverType ||
      current.architecture !== offer.architecture ||
      current.diskGb !== offer.diskGb
    )
      throw new CloudError(
        'capacity_unavailable',
        'The admitted provider offer changed; submit a new operation.',
      );
    if (current.currency !== offer.currency || current.hourlyMicros > offer.hourlyMicros)
      throw new CloudError(
        'budget_exceeded',
        'Current provider price exceeds the admitted reservation.',
      );
  }
  const attemptId = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(78131025)`);
    const [account] = await tx
      .select()
      .from(accounts)
      .where(eq(accounts.id, operation.accountId))
      .for('update');
    if (!account) throw new CloudError('internal_error', 'Operation account is missing.');
    const [stored] = await tx.select().from(operations).where(eq(operations.id, operation.id));
    if (!stored) throw new CloudError('internal_error', 'Operation disappeared before submission.');
    if (input.authorization === 'fresh') {
      if (operationIntentSchema.parse(stored.intent).kind === 'cleanup')
        throw new CloudError('resource_busy', 'Cleanup has replaced fresh machine work.');
      const [cleanup] = await tx
        .select()
        .from(operationCleanups)
        .where(eq(operationCleanups.operationId, operation.id));
      if (cleanup)
        throw new CloudError('resource_busy', 'Cleanup has replaced fresh machine work.');
      if (
        provider.kind === 'hetzner' &&
        ['machine.create', 'machine.reboot', 'machine.power_on'].includes(operation.kind)
      ) {
        const [deadline] = await tx
          .select({
            expired: sql<boolean>`${operations.createdAt} + interval '30 minutes' <= now()`,
          })
          .from(operations)
          .where(eq(operations.id, operation.id));
        if (!deadline || deadline.expired)
          throw new CloudError(
            'provider_rejected',
            'The boot operation deadline expired before submission; submit a new operation.',
          );
      }
      const principal = await loadPrincipal(tx, operation.grantId);
      authorizeCommand(
        principal,
        operation.projectId,
        lifecycleCommandSchema.parse(stored.command),
      );
      if (monetary) {
        const offer = catalogItemSchema.parse(stored.offer);
        const global = await tx.select().from(allocations).where(isNull(allocations.retiredAt));
        const owned = global.filter((row) => row.accountId === account.id);
        if (
          limits.currency !== offer.currency ||
          account.currency !== offer.currency ||
          principal.policy.currency !== offer.currency ||
          global.some((row) => row.currency !== offer.currency) ||
          global.length > limits.maxMachines ||
          global.reduce((sum, row) => sum + row.hourlyMicros, 0) > limits.maxHourlyMicros ||
          owned.length > Math.min(account.maxMachines, principal.policy.maxMachines) ||
          owned.reduce((sum, row) => sum + row.hourlyMicros, 0) >
            Math.min(account.maxHourlyMicros, principal.policy.maxHourlyMicros)
        )
          throw new CloudError(
            'budget_exceeded',
            'The current deployment, account, or credential limits no longer cover this reservation.',
          );
      }
    } else if (input.authorization === 'admitted_cleanup') {
      const [cleanup] = await tx
        .select()
        .from(operationCleanups)
        .where(
          and(
            eq(operationCleanups.operationId, operation.id),
            eq(operationCleanups.accountId, allocation.accountId),
            eq(operationCleanups.allocationId, allocation.id),
          ),
        );
      if (!cleanup || (command.kind !== 'destroy' && command.kind !== 'delete_primary_ip'))
        throw new CloudError('permission_denied', 'No admitted cleanup authorizes this effect.');
      const [owned] = await tx
        .select()
        .from(providerResources)
        .where(
          and(
            eq(providerResources.allocationId, allocation.id),
            eq(providerResources.accountId, allocation.accountId),
            eq(providerResources.provider, allocation.provider),
            eq(providerResources.kind, resourceKind(command)),
            eq(
              providerResources.providerId,
              command.kind === 'destroy' ? command.serverId : command.primaryIpId,
            ),
            isNull(providerResources.absentAt),
          ),
        );
      if (!owned)
        throw new CloudError('permission_denied', 'Cleanup requires an exact live owned resource.');
    } else if (command.kind !== 'delete_primary_ip') {
      throw new CloudError(
        'internal_error',
        'Only IP cleanup may continue without a fresh credential check.',
      );
    }
    const prior = await tx
      .select({ id: attempts.id })
      .from(attempts)
      .where(eq(attempts.operationId, operation.id));
    const id = newId.attempt();
    await tx.insert(attempts).values({
      id,
      accountId: operation.accountId,
      operationId: operation.id,
      sequence: prior.length + 1,
      command,
      outcome: { kind: 'prepared' },
    });
    await tx
      .update(operations)
      .set({ progress: { kind: 'submitting', attemptId: id } })
      .where(eq(operations.id, operation.id));
    return id;
  });
  let outcome: Submission;
  try {
    outcome = await provider.submit({ attemptId, command });
  } catch {
    outcome = {
      kind: 'unknown',
      reason: 'Provider submission failed without a definitive response.',
    };
  }
  // Keep the provider receipt even if a conflicting ownership claim blocks reconciliation.
  await db.update(attempts).set({ outcome }).where(eq(attempts.id, attemptId));
  await db.transaction(async (tx) => {
    if (
      (outcome.kind === 'accepted' || outcome.kind === 'completed') &&
      outcome.resource.kind === resourceKind(command) &&
      (isServerCreateCommand(command) || command.kind === 'create_primary_ip')
    )
      await claimResource(tx, { allocation, resource: outcome.resource, labels: command.labels });
  });
}

type Evaluation =
  | Exclude<EffectResolution, { kind: 'pending' }>
  | { kind: 'pending'; progress: OperationProgress };
const blocked = (
  reason: Extract<OperationProgress, { kind: 'blocked' }>['reason'],
): Evaluation => ({ kind: 'pending', progress: { kind: 'blocked', reason } });
const verified = (observation: ResourceObservation): Evaluation => ({
  kind: 'confirmed',
  observation,
});

async function evaluate(input: {
  db: Database;
  allocation: Allocation;
  recovering: boolean;
  attempt: Attempt;
  provider: MachineProvider;
  expectedLabels: Record<string, string>;
}): Promise<Evaluation> {
  const { attempt, provider, expectedLabels } = input;
  const command = providerCommandSchema.parse(attempt.command);
  const outcome = attemptOutcomeSchema.parse(attempt.outcome);
  // Deletion cannot recreate a resource. Exact absence settles even a lost action response.
  if (
    input.recovering &&
    command.kind === 'destroy' &&
    !(await provider.getServer({ serverId: command.serverId }))
  )
    return verified({ kind: 'absent', resource: { kind: 'server', id: command.serverId } });
  if (
    input.recovering &&
    command.kind === 'delete_primary_ip' &&
    !(await provider.getPrimaryIp({ primaryIpId: command.primaryIpId }))
  )
    return verified({ kind: 'absent', resource: { kind: 'primary_ip', id: command.primaryIpId } });
  if (outcome.kind === 'rejected') return { kind: 'failed', error: outcome.error };
  const uncertain = outcome.kind === 'prepared' || outcome.kind === 'unknown';
  let resource: ResourceRef;
  if (uncertain) {
    if (isServerCreateCommand(command) || command.kind === 'create_primary_ip') {
      const matches = isServerCreateCommand(command)
        ? await provider.findServers({ labels: command.labels })
        : await provider.findPrimaryIps({ labels: command.labels });
      // Preserve every observed owned ID, even when duplicates prevent create completion.
      let ownershipMismatch = false;
      for (const match of matches) {
        if (!matchesLabels(match.labels, command.labels)) {
          ownershipMismatch = true;
          continue;
        }
        try {
          await claimResource(input.db, {
            allocation: input.allocation,
            resource: { kind: resourceKind(command), id: match.id },
            labels: command.labels,
          });
        } catch (error) {
          if (!(error instanceof CloudError)) throw error;
          ownershipMismatch = true;
        }
      }
      if (ownershipMismatch) return blocked('provider_resource_mismatch');
      const discovered = await input.db
        .select()
        .from(providerResources)
        .where(
          and(
            eq(providerResources.allocationId, input.allocation.id),
            eq(providerResources.kind, resourceKind(command)),
            sql`${providerResources.labels}->>'operation_id' = ${attempt.operationId}`,
          ),
        );
      if (matches.length > 1 || discovered.length > 1)
        return blocked('duplicate_provider_resources');
      const match = matches[0];
      if (!match) return blocked('provider_outcome_unknown');
      resource = { kind: resourceKind(command), id: match.id };
    } else
      resource =
        command.kind === 'delete_primary_ip'
          ? { kind: 'primary_ip', id: command.primaryIpId }
          : { kind: 'server', id: command.serverId };
  } else {
    resource = outcome.resource;
    if (
      resource.kind !== resourceKind(command) ||
      ('serverId' in command && resource.id !== command.serverId) ||
      (command.kind === 'delete_primary_ip' && resource.id !== command.primaryIpId)
    )
      return blocked('provider_resource_mismatch');
    if (outcome.kind === 'accepted') {
      const action = await provider.getAction({ actionId: outcome.actionId });
      if (action.kind === 'running')
        return {
          kind: 'pending',
          progress: {
            kind: 'waiting_provider',
            attemptId: attemptIdSchema.parse(attempt.id),
            actionId: outcome.actionId,
            resource,
          },
        };
      if (action.kind === 'failed') return { kind: 'failed', error: action.error };
    }
  }
  const pending = (): Evaluation =>
    uncertain
      ? blocked('provider_outcome_unknown')
      : { kind: 'pending', progress: { kind: 'verifying', resource } };
  if (resource.kind === 'primary_ip') {
    const ip = await provider.getPrimaryIp({ primaryIpId: resource.id });
    if (ip && ip.id !== resource.id) return blocked('provider_resource_mismatch');
    if (command.kind === 'delete_primary_ip') {
      if (!ip) return verified({ kind: 'absent', resource });
      if (!matchesLabels(ip.labels, expectedLabels) || ip.assignment.kind !== 'unassigned')
        return blocked('provider_resource_mismatch');
      return pending();
    }
    if (command.kind !== 'create_primary_ip') return blocked('provider_resource_mismatch');
    if (!ip)
      return input.recovering && !uncertain ? verified({ kind: 'absent', resource }) : pending();
    if (
      !matchesLabels(ip.labels, command.labels) ||
      ip.region !== command.region ||
      !ip.autoDelete ||
      ip.assignment.kind !== 'unassigned'
    )
      return blocked('provider_resource_mismatch');
    return verified({ kind: 'primary_ip', primaryIp: ip });
  }
  const server = await provider.getServer({ serverId: resource.id });
  if (server && server.id !== resource.id) return blocked('provider_resource_mismatch');
  if (command.kind === 'destroy' && !server) return verified({ kind: 'absent', resource });
  if (!server)
    return input.recovering && !uncertain && isServerCreateCommand(command)
      ? verified({ kind: 'absent', resource })
      : pending();
  if (
    !matchesLabels(server.labels, isServerCreateCommand(command) ? command.labels : expectedLabels)
  )
    return blocked('provider_resource_mismatch');
  switch (command.kind) {
    case 'create':
    case 'create_guest':
      if (
        server.serverType !== command.serverType ||
        server.region !== command.region ||
        server.primaryIpId !== (command.network.kind === 'primary_ip' ? command.network.id : null)
      )
        return blocked('provider_resource_mismatch');
      if (server.power !== 'running') return pending();
      break;
    case 'resize':
      if (server.serverType !== command.serverType) return pending();
      break;
    case 'power_off':
      if (server.power !== 'off') return pending();
      break;
    case 'power_on':
      if (server.power !== 'running') return pending();
      break;
    case 'reboot':
      if (uncertain || server.power !== 'running') return pending();
      break;
    case 'destroy':
      return pending();
    case 'create_primary_ip':
    case 'delete_primary_ip':
      return blocked('provider_resource_mismatch');
  }
  return verified({ kind: 'server', server });
}

export async function resolveEffect(input: {
  db: Database;
  operation: Operation;
  allocation: Allocation;
  attempt: Attempt;
  provider: MachineProvider;
  expectedLabels: Record<string, string>;
}) {
  const { db, operation, allocation, attempt } = input;
  if (effectResolutionSchema.parse(attempt.resolution).kind !== 'pending') return;
  if (attempt.accountId !== operation.accountId)
    throw new CloudError('permission_denied', 'Effect belongs to another account.');
  if (attempt.operationId !== operation.id) {
    const [cleanup] = await db
      .select()
      .from(operationCleanups)
      .where(
        and(
          eq(operationCleanups.operationId, operation.id),
          eq(operationCleanups.sourceOperationId, attempt.operationId),
          eq(operationCleanups.allocationId, allocation.id),
          eq(operationCleanups.accountId, operation.accountId),
        ),
      );
    if (!cleanup)
      throw new CloudError('permission_denied', 'Effect is outside this cleanup scope.');
  }
  let result: Evaluation;
  try {
    result = await evaluate({ ...input, recovering: operation.intent.kind === 'cleanup' });
  } catch (error) {
    if (!(error instanceof CloudError) || error.failure.code === 'provider_unavailable')
      throw error;
    await setProgress(db, operation, { kind: 'blocked', reason: 'provider_resource_mismatch' });
    return;
  }
  const command = providerCommandSchema.parse(attempt.command);
  if (result.kind === 'pending') {
    await setProgress(db, operation, result.progress);
    return;
  }
  try {
    await db.transaction(async (tx) => {
      if (result.kind === 'confirmed') {
        const observed = result.observation;
        if (observed.kind === 'absent') await recordAbsence(tx, allocation, observed.resource);
        else
          await claimResource(tx, {
            allocation,
            resource:
              observed.kind === 'server'
                ? { kind: 'server', id: observed.server.id }
                : { kind: 'primary_ip', id: observed.primaryIp.id },
            labels:
              isServerCreateCommand(command) || command.kind === 'create_primary_ip'
                ? command.labels
                : input.expectedLabels,
          });
      }
      await tx.update(attempts).set({ resolution: result }).where(eq(attempts.id, attempt.id));
      await tx.insert(auditEvents).values({
        accountId: operation.accountId,
        subjectId: operation.id,
        event: 'effect.resolved',
        details: { attemptId: attempt.id, result },
      });
    });
  } catch (error) {
    if (!(error instanceof CloudError)) throw error;
    await setProgress(db, operation, { kind: 'blocked', reason: 'provider_resource_mismatch' });
  }
}

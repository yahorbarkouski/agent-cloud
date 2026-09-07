import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  CloudError,
  allocationIdSchema,
  catalogItemSchema,
  lifecycleCommandSchema,
  providerCommandSchema,
  isServerCreateCommand,
  effectResolutionSchema,
  attemptOutcomeSchema,
  operationIntentSchema,
  networkProfileSchema,
  guestIdentitySchema,
  operationProgressSchema,
  isOperationTerminal,
  type Operation,
  type OperationId,
  type Machine,
  type MachineProvider,
  type ProviderServer,
  type Failure,
  type GuestImage,
  type BootstrapReference,
  type ProviderCommand,
  type GuestVerification,
} from '@agent-cloud/contracts';
import {
  operations,
  machines,
  allocations,
  attempts,
  providerResources,
  auditEvents,
  guestIdentities,
  operationRecord,
  machineRecord,
  withMachineLock,
  type Database,
  type Connection,
  type Transaction,
} from '@agent-cloud/db';
import type { Config } from './config.js';
import { advanceCleanup } from './machine-cleanup.js';
import type { GuestReadiness } from './guest-readiness.js';
import { journalEffect, resolveEffect, setProgress, type Attempt } from './effect-journal.js';
import {
  effectLabels,
  ownedLabels,
  ownedRef,
  matchesLabels,
  recordAbsence,
  type Allocation,
  type OwnedResource,
} from './resource-journal.js';

async function fail(input: {
  db: Database;
  operation: Operation;
  machine: Machine;
  error: Failure;
  allocationAbsent: boolean;
}) {
  await input.db.transaction(async (tx) => {
    await tx
      .update(operations)
      .set({
        progress: {
          kind: 'failed',
          completedAt: new Date().toISOString(),
          error: input.error,
        },
      })
      .where(eq(operations.id, input.operation.id));
    if (input.operation.kind === 'machine.create') {
      await tx
        .update(machines)
        .set({
          state: { kind: 'failed', error: input.error },
          version: sql`${machines.version} + 1`,
        })
        .where(eq(machines.id, input.machine.id));
      if (input.allocationAbsent) {
        await tx
          .update(allocations)
          .set({ retiredAt: new Date() })
          .where(and(eq(allocations.machineId, input.machine.id), isNull(allocations.retiredAt)));
      }
    }
    // A failed resize keeps its larger reservation until the actual size is observed.
    await tx.insert(auditEvents).values({
      accountId: input.operation.accountId,
      subjectId: input.operation.id,
      event: 'operation.failed',
      details: { error: input.error, allocationAbsent: input.allocationAbsent },
    });
  });
}

async function complete(input: {
  db: Database;
  operation: Operation;
  machine: Machine;
  server: ProviderServer | null;
  verification?: Extract<GuestVerification, { kind: 'ssh' }>;
}) {
  const { db, operation, machine, server } = input;
  await db.transaction(async (tx) => {
    if (input.verification) {
      const [current] = await tx
        .select({
          progress: operations.progress,
          expired: sql<boolean>`${operations.createdAt} + interval '30 minutes' <= now()`,
        })
        .from(operations)
        .where(eq(operations.id, operation.id))
        .for('update');
      if (!current) throw new CloudError('internal_error', 'Runtime operation disappeared.');
      const progress = operationProgressSchema.parse(current.progress);
      if (
        progress.kind !== 'waiting_guest' ||
        progress.stage !== 'runtime' ||
        progress.serverId !== server?.id
      )
        return;
      if (current.expired) {
        await setProgress(tx, operation, { kind: 'blocked', reason: 'guest_deadline_exceeded' });
        return;
      }
    }
    const [allocation] = await tx
      .select()
      .from(allocations)
      .where(and(eq(allocations.machineId, machine.id), isNull(allocations.retiredAt)));
    if (!allocation)
      throw new CloudError('internal_error', 'Live allocation reservation is missing.');
    if (operation.kind === 'machine.destroy') {
      if (server)
        throw new CloudError('provider_outcome_unknown', 'Server still exists after deletion.');
      const liveResources = await tx
        .select()
        .from(providerResources)
        .where(
          and(
            eq(providerResources.allocationId, allocation.id),
            isNull(providerResources.absentAt),
          ),
        );
      if (liveResources.length)
        throw new CloudError(
          'provider_outcome_unknown',
          'Owned resources remain after server deletion.',
        );
      await tx
        .update(allocations)
        .set({ retiredAt: new Date() })
        .where(eq(allocations.id, allocation.id));
      await tx
        .update(machines)
        .set({
          state: { kind: 'destroyed', destroyedAt: new Date().toISOString() },
          version: sql`${machines.version} + 1`,
        })
        .where(eq(machines.id, machine.id));
    } else {
      if (!server) throw new CloudError('provider_outcome_unknown', 'Server is not visible yet.');
      const [stored] = await tx.select().from(operations).where(eq(operations.id, operation.id));
      if (!stored) throw new CloudError('internal_error', 'Operation disappeared while verifying.');
      const command = lifecycleCommandSchema.parse(stored.command);
      const size = command.kind === 'resize' ? command.size : machine.spec.size;
      const guestVerification: GuestVerification =
        machine.provider === 'simulated'
          ? { kind: 'simulated', verifiedAt: new Date().toISOString() }
          : (input.verification ??
            (machine.state.kind === 'allocated' ? machine.state.guest : { kind: 'pending' }));
      await tx
        .update(allocations)
        .set({
          serverId: server.id,
          ...(command.kind === 'create' || command.kind === 'resize'
            ? {
                offer: catalogItemSchema.parse(stored.offer),
                hourlyMicros: catalogItemSchema.parse(stored.offer).hourlyMicros,
              }
            : {}),
        })
        .where(eq(allocations.id, allocation.id));
      await tx
        .update(machines)
        .set({
          spec: { ...machine.spec, size },
          version: sql`${machines.version} + 1`,
          state: {
            kind: 'allocated',
            allocationId: allocationIdSchema.parse(allocation.id),
            serverId: server.id,
            power: server.power,
            guest: guestVerification,
          },
        })
        .where(eq(machines.id, machine.id));
    }
    await tx
      .update(operations)
      .set({
        progress: { kind: 'succeeded', completedAt: new Date().toISOString() },
      })
      .where(eq(operations.id, operation.id));
    await tx.insert(auditEvents).values({
      accountId: operation.accountId,
      subjectId: operation.id,
      event: 'operation.succeeded',
      details: {
        machineId: machine.id,
        verification:
          machine.provider === 'simulated' ? 'simulated' : input.verification ? 'ssh' : 'provider',
      },
    });
  });
}

export type GuestProvisioning =
  | { kind: 'disabled' }
  | {
      kind: 'enabled';
      resolveImage: (allocation: Allocation) => Promise<GuestImage>;
      prepareBootstrap: (
        tx: Transaction,
        input: { allocation: Allocation; operation: Operation; image: GuestImage },
      ) => Promise<BootstrapReference>;
      runtime: GuestReadiness;
    };

type Work = {
  db: Database;
  operation: Operation;
  machine: Machine;
  allocation: Allocation;
  provider: MachineProvider;
  limits: Config['limits'];
  history: Attempt[];
  resources: OwnedResource[];
  guest: GuestProvisioning;
};

async function verifyRuntime(work: Work) {
  if (work.guest.kind !== 'enabled') {
    await setProgress(work.db, work.operation, { kind: 'blocked', reason: 'guest_unreachable' });
    return;
  }
  const decision = await work.guest.runtime.check(work);
  switch (decision.kind) {
    case 'waiting':
      return;
    case 'blocked':
      await setProgress(work.db, work.operation, { kind: 'blocked', reason: decision.reason });
      return;
    case 'ready':
      await complete({ ...work, server: decision.server, verification: decision.verification });
      return;
  }
}
function effectOf(history: Attempt[], kind: string) {
  return history.find((row) => {
    const command = providerCommandSchema.parse(row.command);
    return kind === 'create' ? isServerCreateCommand(command) : command.kind === kind;
  });
}
async function beginFailure(work: Work, error: Failure) {
  if (work.operation.kind === 'machine.create') {
    const create = effectOf(work.history, 'create');
    const possibleVm = create && attemptOutcomeSchema.parse(create.outcome).kind !== 'rejected';
    const live = work.resources.filter((row) => !row.absentAt);
    if (!possibleVm && live.length) {
      await work.db
        .update(operations)
        .set({ intent: { kind: 'compensate', error } })
        .where(eq(operations.id, work.operation.id));
      await setProgress(work.db, work.operation, { kind: 'cleaning_up' });
      return;
    }
    await fail({ ...work, error, allocationAbsent: !possibleVm && live.length === 0 });
  } else await fail({ ...work, error, allocationAbsent: false });
}

async function cleanupIp(work: Work): Promise<boolean> {
  const resource = work.resources.find((row) => row.kind === 'primary_ip' && !row.absentAt);
  if (!resource) return true;
  const ip = await work.provider.getPrimaryIp({ primaryIpId: resource.providerId });
  if (!ip) {
    await recordAbsence(work.db, work.allocation, ownedRef(resource));
    return false;
  }
  if (
    ip.id !== resource.providerId ||
    !matchesLabels(ip.labels, ownedLabels(resource)) ||
    ip.assignment.kind !== 'unassigned'
  ) {
    await setProgress(work.db, work.operation, {
      kind: 'blocked',
      reason: 'provider_resource_mismatch',
    });
    return false;
  }
  const previous = work.history.find((row) => {
    const command = providerCommandSchema.parse(row.command);
    return command.kind === 'delete_primary_ip' && command.primaryIpId === ip.id;
  });
  if (previous) {
    await setProgress(work.db, work.operation, {
      kind: 'blocked',
      reason: 'provider_outcome_unknown',
    });
    return false;
  }
  await journalEffect({
    ...work,
    command: { kind: 'delete_primary_ip', primaryIpId: ip.id },
    authorization: 'cleanup',
  });
  return false;
}

async function advanceLocked(
  db: Database,
  operationId: OperationId,
  provider: MachineProvider,
  limits: Config['limits'],
  guest: GuestProvisioning,
) {
  const [row] = await db.select().from(operations).where(eq(operations.id, operationId));
  if (!row) return;
  const operation = operationRecord(row);
  if (isOperationTerminal(operation)) return;
  const [machineRow] = await db.select().from(machines).where(eq(machines.id, operation.machineId));
  if (!machineRow) throw new CloudError('internal_error', 'Operation machine is missing.');
  const machine = machineRecord(machineRow);
  if (machine.provider !== provider.kind)
    throw new CloudError('internal_error', 'Wrong provider for this machine.');
  const [allocation] = await db
    .select()
    .from(allocations)
    .where(and(eq(allocations.machineId, machine.id), isNull(allocations.retiredAt)));
  if (!allocation) throw new CloudError('internal_error', 'Operation allocation is missing.');
  if (operation.intent.kind === 'cleanup') {
    await advanceCleanup({ db, operation, allocation, provider, limits });
    return;
  }
  const history = await db
    .select()
    .from(attempts)
    .where(eq(attempts.operationId, operation.id))
    .orderBy(asc(attempts.sequence));
  const resources = await db
    .select()
    .from(providerResources)
    .where(eq(providerResources.allocationId, allocation.id));
  const work: Work = {
    db,
    operation,
    machine,
    allocation,
    provider,
    limits,
    history,
    resources,
    guest,
  };
  const pending = history.find(
    (attempt) => effectResolutionSchema.parse(attempt.resolution).kind === 'pending',
  );
  if (pending) {
    const command = providerCommandSchema.parse(pending.command);
    const resource = resources.find((candidate) =>
      command.kind === 'delete_primary_ip'
        ? candidate.kind === 'primary_ip' && candidate.providerId === command.primaryIpId
        : 'serverId' in command &&
          candidate.kind === 'server' &&
          candidate.providerId === command.serverId,
    );
    await resolveEffect({
      ...work,
      attempt: pending,
      expectedLabels: resource ? ownedLabels(resource) : effectLabels(operation, allocation),
    });
    return;
  }
  const intent = operationIntentSchema.parse(row.intent);
  if (intent.kind === 'compensate') {
    if (await cleanupIp(work)) await fail({ ...work, error: intent.error, allocationAbsent: true });
    return;
  }
  for (const attempt of history) {
    const resolution = effectResolutionSchema.parse(attempt.resolution);
    if (resolution.kind === 'failed') {
      if (providerCommandSchema.parse(attempt.command).kind === 'delete_primary_ip') {
        // A later external cleanup can still establish absence without replaying this effect.
        if (await cleanupIp(work)) await complete({ ...work, server: null });
      } else await beginFailure(work, resolution.error);
      return;
    }
  }
  const lifecycle = lifecycleCommandSchema.parse(row.command);
  try {
    if (lifecycle.kind === 'create') {
      const profile = networkProfileSchema.parse(allocation.networkProfile);
      const offer = catalogItemSchema.parse(row.offer);
      const labels = effectLabels(operation, allocation);
      const create = effectOf(history, 'create');
      if (!create && provider.kind === 'hetzner' && guest.kind !== 'enabled')
        throw new CloudError('provider_rejected', 'Live guest provisioning is not configured.');
      const image =
        !create && provider.kind === 'hetzner' && guest.kind === 'enabled'
          ? await guest.resolveImage(allocation)
          : null;
      const ipEffect = effectOf(history, 'create_primary_ip');
      if (profile === 'managed_ipv4' && !ipEffect) {
        await journalEffect({
          ...work,
          command: {
            kind: 'create_primary_ip',
            name: `${machine.id.replaceAll('_', '-')}-ipv4`,
            region: offer.region,
            labels,
          },
          authorization: 'fresh',
        });
        return;
      }
      if (!create) {
        const ip = resources.find(
          (candidate) => candidate.kind === 'primary_ip' && !candidate.absentAt,
        );
        if (profile === 'managed_ipv4') {
          if (!ip) throw new CloudError('internal_error', 'Confirmed Primary IP is missing.');
          const observed = await provider.getPrimaryIp({ primaryIpId: ip.providerId });
          if (!observed) {
            await recordAbsence(db, allocation, ownedRef(ip));
            throw new CloudError('provider_rejected', 'Primary IP disappeared before VM creation.');
          }
          if (
            observed.id !== ip.providerId ||
            !matchesLabels(observed.labels, ownedLabels(ip)) ||
            observed.assignment.kind !== 'unassigned' ||
            !observed.autoDelete
          ) {
            await setProgress(db, operation, {
              kind: 'blocked',
              reason: 'provider_resource_mismatch',
            });
            return;
          }
        }
        const details = {
          name: machine.id.replaceAll('_', '-'),
          serverType: offer.serverType,
          region: offer.region,
          labels,
        };
        let command: ProviderCommand;
        if (provider.kind === 'hetzner' && guest.kind === 'enabled' && image) {
          if (!ip || profile !== 'managed_ipv4')
            throw new CloudError(
              'provider_rejected',
              'Guest creation requires an owned Primary IP.',
            );
          const bootstrap = await db.transaction((tx) =>
            guest.prepareBootstrap(tx, { allocation, operation, image }),
          );
          command = {
            ...details,
            kind: 'create_guest',
            network: { kind: 'primary_ip', id: ip.providerId },
            bootstrap,
          };
        } else
          command = {
            ...details,
            kind: 'create',
            network: ip ? { kind: 'primary_ip', id: ip.providerId } : { kind: 'legacy' },
          };
        await journalEffect({ ...work, command, authorization: 'fresh' });
        return;
      }
      const resolution = effectResolutionSchema.parse(create.resolution);
      if (resolution.kind !== 'confirmed' || resolution.observation.kind !== 'server')
        throw new CloudError('internal_error', 'Create has no verified server.');
      if (provider.kind === 'hetzner') {
        const [identity] = await db
          .select()
          .from(guestIdentities)
          .where(eq(guestIdentities.allocationId, allocation.id));
        const stage =
          identity && guestIdentitySchema.parse(identity.identity).kind === 'issued'
            ? 'runtime'
            : 'enrollment';
        await setProgress(db, operation, {
          kind: 'waiting_guest',
          serverId: resolution.observation.server.id,
          stage,
        });
        await verifyRuntime(work);
        return;
      }
      await complete({ ...work, server: resolution.observation.server });
      return;
    }
    const serverResource = resources.find(
      (candidate) => candidate.kind === 'server' && !candidate.absentAt,
    );
    if (lifecycle.kind === 'destroy' && !serverResource) {
      if (await cleanupIp(work)) await complete({ ...work, server: null });
      return;
    }
    const effect = effectOf(history, lifecycle.kind);
    if (effect) {
      const resolution = effectResolutionSchema.parse(effect.resolution);
      if (resolution.kind !== 'confirmed')
        throw new CloudError('internal_error', 'Effect was not resolved.');
      if (lifecycle.kind === 'destroy') {
        if (await cleanupIp(work)) await complete({ ...work, server: null });
      } else if (resolution.observation.kind === 'server') {
        if (
          provider.kind === 'hetzner' &&
          (lifecycle.kind === 'reboot' || lifecycle.kind === 'power_on')
        ) {
          await setProgress(db, operation, {
            kind: 'waiting_guest',
            serverId: resolution.observation.server.id,
            stage: 'runtime',
          });
          await verifyRuntime(work);
        } else await complete({ ...work, server: resolution.observation.server });
      } else throw new CloudError('internal_error', 'Machine operation has no verified server.');
      return;
    }
    if (!serverResource || !allocation.serverId)
      throw new CloudError('provider_rejected', 'Machine has no live provider server.');
    const server = await provider.getServer({ serverId: allocation.serverId });
    if (!server) {
      if (lifecycle.kind === 'destroy') {
        await recordAbsence(db, allocation, ownedRef(serverResource));
        return;
      }
      throw new CloudError('provider_rejected', 'Provider server is absent.');
    }
    if (
      server.id !== serverResource.providerId ||
      !matchesLabels(server.labels, ownedLabels(serverResource))
    ) {
      await setProgress(db, operation, { kind: 'blocked', reason: 'provider_resource_mismatch' });
      return;
    }
    if (
      allocation.networkProfile === 'managed_ipv4' &&
      !resources.some(
        (resource) =>
          resource.kind === 'primary_ip' &&
          resource.providerId === server.primaryIpId &&
          !resource.absentAt,
      )
    ) {
      await setProgress(db, operation, { kind: 'blocked', reason: 'provider_resource_mismatch' });
      return;
    }
    await journalEffect({
      ...work,
      command:
        lifecycle.kind === 'resize'
          ? {
              kind: 'resize',
              serverId: server.id,
              serverType: catalogItemSchema.parse(row.offer).serverType,
            }
          : { kind: lifecycle.kind, serverId: server.id },
      authorization: 'fresh',
    });
  } catch (error) {
    if (!(error instanceof CloudError)) throw error;
    // A busy image publication or temporary provider read failure needs another tick, not compensation.
    if (error.failure.code === 'provider_unavailable' && error.failure.retryable) return;
    // A failure after submission must not turn an uncertain effect into cleanup.
    const currentHistory = await db
      .select()
      .from(attempts)
      .where(eq(attempts.operationId, operation.id));
    if (
      currentHistory.some(
        (attempt) => effectResolutionSchema.parse(attempt.resolution).kind === 'pending',
      )
    ) {
      await setProgress(db, operation, { kind: 'blocked', reason: 'provider_resource_mismatch' });
      return;
    }
    const current = await db
      .select()
      .from(providerResources)
      .where(eq(providerResources.allocationId, allocation.id));
    await beginFailure({ ...work, resources: current, history: currentHistory }, error.failure);
  }
}

export async function advanceOperation(input: {
  connection: Connection;
  operationId: OperationId;
  provider: MachineProvider;
  limits: Config['limits'];
  guest?: GuestProvisioning;
}): Promise<void> {
  const [row] = await input.connection.db
    .select()
    .from(operations)
    .where(eq(operations.id, input.operationId));
  if (!row) return;
  await withMachineLock({
    pool: input.connection.pool,
    machineId: row.machineId,
    work: (db) =>
      advanceLocked(
        db,
        input.operationId,
        input.provider,
        input.limits,
        input.guest ?? { kind: 'disabled' },
      ),
  });
}

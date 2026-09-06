import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  CloudError,
  newId,
  catalogItemSchema,
  selectOffer,
  attemptIdSchema,
  allocationIdSchema,
  lifecycleCommandSchema,
  providerCommandSchema,
  attemptOutcomeSchema,
  isOperationTerminal,
  type Operation,
  type OperationId,
  type ProviderCommand,
  type MachineProvider,
  type Failure,
  type OperationProgress,
  type ProviderServer,
  type Machine,
  type Submission,
} from '@agent-cloud/contracts';
import {
  operations,
  machines,
  allocations,
  attempts,
  accounts,
  auditEvents,
  operationRecord,
  machineRecord,
  withMachineLock,
  type Connection,
  type Database,
} from '@agent-cloud/db';
import type { Config } from './config.js';
import { loadPrincipal } from './auth.js';
import { authorizeCommand } from './lifecycle.js';

function ownership(operation: Operation) {
  return {
    managed_by: 'agent-cloud',
    account_id: operation.accountId,
    machine_id: operation.machineId,
    operation_id: operation.id,
  };
}

async function setProgress(db: Database, operation: Operation, progress: OperationProgress) {
  await db.transaction(async (tx) => {
    await tx.update(operations).set({ progress }).where(eq(operations.id, operation.id));
    await tx.insert(auditEvents).values({
      accountId: operation.accountId,
      subjectId: operation.id,
      event: `operation.${progress.kind}`,
      details: progress,
    });
  });
}

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

async function prepare(
  db: Database,
  operation: Operation,
  machine: Machine,
  command: ProviderCommand,
  limits: Config['limits'],
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(78131025)`);
    await tx.select().from(accounts).where(eq(accounts.id, operation.accountId)).for('update');
    const principal = await loadPrincipal(tx, operation.grantId);
    const [stored] = await tx.select().from(operations).where(eq(operations.id, operation.id));
    if (!stored) throw new CloudError('internal_error', 'Operation disappeared before submission.');
    authorizeCommand(principal, machine.projectId, lifecycleCommandSchema.parse(stored.command));
    if (command.kind === 'create' || command.kind === 'resize') {
      const offer = catalogItemSchema.parse(stored.offer);
      const [account] = await tx
        .select()
        .from(accounts)
        .where(eq(accounts.id, operation.accountId));
      const global = await tx.select().from(allocations).where(isNull(allocations.retiredAt));
      const active = global.filter((allocation) => allocation.accountId === operation.accountId);
      if (
        !account ||
        limits.currency !== offer.currency ||
        global.some((allocation) => allocation.currency !== offer.currency) ||
        global.reduce((sum, allocation) => sum + allocation.hourlyMicros, 0) >
          limits.maxHourlyMicros ||
        global.length > limits.maxMachines ||
        account.currency !== offer.currency ||
        principal.policy.currency !== offer.currency ||
        active.some((allocation) => allocation.currency !== offer.currency) ||
        active.reduce((sum, allocation) => sum + allocation.hourlyMicros, 0) >
          Math.min(account.maxHourlyMicros, principal.policy.maxHourlyMicros) ||
        active.length > Math.min(account.maxMachines, principal.policy.maxMachines)
      )
        throw new CloudError(
          'budget_exceeded',
          'The current deployment, account, or credential limits no longer cover this reservation.',
        );
    }
    const attemptId = newId.attempt();
    await tx.insert(attempts).values({
      id: attemptId,
      accountId: operation.accountId,
      operationId: operation.id,
      sequence: 1,
      command,
      outcome: { kind: 'prepared' },
    });
    await tx
      .update(operations)
      .set({ progress: { kind: 'submitting', attemptId } })
      .where(eq(operations.id, operation.id));
    return attemptId;
  });
}

async function complete(input: {
  db: Database;
  operation: Operation;
  machine: Machine;
  server: ProviderServer | null;
}) {
  const { db, operation, machine, server } = input;
  await db.transaction(async (tx) => {
    const [allocation] = await tx
      .select()
      .from(allocations)
      .where(and(eq(allocations.machineId, machine.id), isNull(allocations.retiredAt)));
    if (!allocation)
      throw new CloudError('internal_error', 'Live allocation reservation is missing.');
    if (operation.kind === 'machine.destroy') {
      if (server)
        throw new CloudError('provider_outcome_unknown', 'Server still exists after deletion.');
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
            guest:
              machine.provider === 'simulated'
                ? { kind: 'simulated', verifiedAt: new Date().toISOString() }
                : { kind: 'pending' },
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
        verification: machine.provider === 'simulated' ? 'simulated' : 'provider',
      },
    });
  });
}

async function reconcile(input: {
  db: Database;
  operation: Operation;
  machine: Machine;
  command: ProviderCommand;
  provider: MachineProvider;
}) {
  const { db, operation, machine, command, provider } = input;
  if (command.kind === 'create') {
    const matches = await provider.findServers({ labels: ownership(operation) });
    if (matches.length > 1) {
      await setProgress(db, operation, { kind: 'blocked', reason: 'duplicate_provider_resources' });
      return;
    }
    const server = matches[0];
    if (
      server &&
      server.serverType === command.serverType &&
      server.region === command.region &&
      server.power === 'running'
    ) {
      await complete({ db, operation, machine, server });
      return;
    }
  } else {
    const server = await provider.getServer({ serverId: command.serverId });
    if (
      (command.kind === 'destroy' && server === null) ||
      (command.kind === 'resize' && server?.serverType === command.serverType) ||
      (command.kind === 'power_off' && server?.power === 'off') ||
      (command.kind === 'power_on' && server?.power === 'running')
    ) {
      await complete({ db, operation, machine, server });
      return;
    }
    // Running does not prove that an uncertain reboot actually happened.
  }
  await setProgress(db, operation, { kind: 'blocked', reason: 'provider_outcome_unknown' });
}

async function advanceLocked(
  db: Database,
  operationId: OperationId,
  provider: MachineProvider,
  limits: Config['limits'],
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
  const lifecycle = lifecycleCommandSchema.parse(row.command);
  const [previous] = await db
    .select()
    .from(attempts)
    .where(eq(attempts.operationId, operation.id))
    .orderBy(desc(attempts.sequence));

  if (!previous) {
    const [allocation] = await db
      .select()
      .from(allocations)
      .where(and(eq(allocations.machineId, machine.id), isNull(allocations.retiredAt)));
    const offer =
      lifecycle.kind === 'create' || lifecycle.kind === 'resize'
        ? catalogItemSchema.parse(row.offer)
        : null;
    let command: ProviderCommand;
    if (lifecycle.kind === 'create') {
      if (!offer) throw new CloudError('internal_error', 'Create offer is missing.');
      command = {
        kind: 'create',
        name: machine.id.replaceAll('_', '-'),
        serverType: offer.serverType,
        region: lifecycle.spec.region,
        labels: ownership(operation),
      };
    } else {
      if (!allocation?.serverId)
        throw new CloudError('internal_error', 'Provider allocation is missing.');
      command =
        lifecycle.kind === 'resize'
          ? {
              kind: 'resize',
              serverId: allocation.serverId,
              serverType: catalogItemSchema.parse(row.offer).serverType,
            }
          : { kind: lifecycle.kind, serverId: allocation.serverId };
    }
    let attemptId;
    try {
      if (offer) {
        const catalog = await provider.getCatalog();
        const current = selectOffer({ catalog, size: offer.size, region: offer.region });
        if (
          catalog.provider !== machine.provider ||
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
      attemptId = await prepare(db, operation, machine, command, limits);
    } catch (error) {
      if (!(error instanceof CloudError)) throw error;
      await fail({
        db,
        operation,
        machine,
        error: error.failure,
        allocationAbsent: lifecycle.kind === 'create',
      });
      return;
    }
    let outcome;
    try {
      outcome = await provider.submit({ attemptId, command });
    } catch {
      // Transport exceptions never establish whether an external mutation took place.
      outcome = {
        kind: 'unknown',
        reason: 'Provider submission failed without a definitive response.',
      } satisfies Submission;
    }
    await db.transaction(async (tx) => {
      await tx.update(attempts).set({ outcome }).where(eq(attempts.id, attemptId));
      if (outcome.kind === 'accepted' || outcome.kind === 'completed') {
        await tx
          .update(allocations)
          .set({ serverId: outcome.serverId })
          .where(and(eq(allocations.machineId, machine.id), isNull(allocations.retiredAt)));
      }
    });
    return;
  }

  const outcome = attemptOutcomeSchema.parse(previous.outcome);
  const command = providerCommandSchema.parse(previous.command);
  switch (outcome.kind) {
    case 'prepared':
    case 'unknown':
      await reconcile({ db, operation, machine, command, provider });
      return;
    case 'rejected':
      await fail({
        db,
        operation,
        machine,
        error: outcome.error,
        allocationAbsent: lifecycle.kind === 'create',
      });
      return;
    case 'accepted': {
      const action = await provider.getAction({ actionId: outcome.actionId });
      if (action.kind === 'running') {
        await setProgress(db, operation, {
          kind: 'waiting_provider',
          attemptId: attemptIdSchema.parse(previous.id),
          actionId: outcome.actionId,
          serverId: outcome.serverId,
        });
        return;
      }
      if (action.kind === 'failed') {
        await fail({ db, operation, machine, error: action.error, allocationAbsent: false });
        return;
      }
      break;
    }
    case 'completed':
      break;
  }
  const server = await provider.getServer({ serverId: outcome.serverId });
  if (
    server &&
    command.kind === 'create' &&
    (server.serverType !== command.serverType ||
      server.region !== command.region ||
      Object.entries(ownership(operation)).some(([key, value]) => server.labels[key] !== value))
  ) {
    await setProgress(db, operation, { kind: 'blocked', reason: 'provider_resource_mismatch' });
    return;
  }
  if (command.kind === 'destroy') {
    if (server) {
      await setProgress(db, operation, { kind: 'verifying', serverId: server.id });
      return;
    }
  } else if (
    !server ||
    (command.kind === 'resize' && server.serverType !== command.serverType) ||
    ((command.kind === 'power_on' || command.kind === 'reboot' || command.kind === 'create') &&
      server.power !== 'running') ||
    (command.kind === 'power_off' && server.power !== 'off')
  ) {
    await setProgress(db, operation, { kind: 'verifying', serverId: outcome.serverId });
    return;
  }
  await complete({ db, operation, machine, server });
}

export async function advanceOperation(input: {
  connection: Connection;
  operationId: OperationId;
  provider: MachineProvider;
  limits: Config['limits'];
}): Promise<void> {
  const [row] = await input.connection.db
    .select()
    .from(operations)
    .where(eq(operations.id, input.operationId));
  if (!row) return;
  await withMachineLock({
    pool: input.connection.pool,
    machineId: row.machineId,
    work: (db) => advanceLocked(db, input.operationId, input.provider, input.limits),
  });
}

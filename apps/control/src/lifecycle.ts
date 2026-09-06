import { createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  CloudError,
  catalog,
  newId,
  machineSchema,
  operationSchema,
  type Principal,
  type ProjectId,
  type MachineId,
  type MachineSpec,
  type MachineAction,
  type LifecycleCommand,
  type Operation,
  type MachineProvider,
} from '@agent-cloud/contracts';
import {
  accounts,
  projects,
  machines,
  operations,
  allocations,
  idempotency,
  auditEvents,
  machineRecord,
  operationRecord,
  enqueueOperation,
  type Database,
  type Transaction,
} from '@agent-cloud/db';
import { authorize, loadPrincipal } from './auth.js';
import type { Config } from './config.js';

export type Admission =
  | { kind: 'create'; projectId: ProjectId; spec: MachineSpec }
  | { kind: 'action'; machineId: MachineId; command: MachineAction };

// Inputs have already been parsed into schemas with fixed property ordering.
function requestHash(command: LifecycleCommand) {
  return createHash('sha256').update(JSON.stringify(command)).digest('hex');
}

export function authorizeCommand(
  principal: Principal,
  projectId: ProjectId,
  command: LifecycleCommand,
): void {
  switch (command.kind) {
    case 'create':
      authorize(principal, 'machine:create', projectId);
      if (
        !principal.policy.sizes.includes(command.spec.size) ||
        !principal.policy.regions.includes(command.spec.region)
      ) {
        throw new CloudError(
          'permission_denied',
          'Requested size or region is outside this credential policy.',
        );
      }
      break;
    case 'destroy':
      authorize(principal, 'machine:destroy', projectId);
      if (!command.allowDataLoss) {
        throw new CloudError(
          'data_loss_not_authorized',
          'Destroy requires explicit allowDataLoss: true.',
        );
      }
      authorize(principal, 'machine:destroy:data_loss', projectId);
      break;
    case 'resize':
      authorize(principal, 'machine:operate', projectId);
      if (!principal.policy.sizes.includes(command.size)) {
        throw new CloudError(
          'permission_denied',
          'Requested size is outside this credential policy.',
        );
      }
      break;
    case 'reboot':
    case 'power_on':
    case 'power_off':
      authorize(principal, 'machine:operate', projectId);
      break;
  }
}

export async function lockAccount(tx: Transaction, principal: Principal) {
  const [account] = await tx
    .select()
    .from(accounts)
    .where(eq(accounts.id, principal.accountId))
    .for('update');
  if (!account) throw new CloudError('unauthenticated', 'Account not found.');
  return account;
}

async function assertReservation(input: {
  tx: Transaction;
  principal: Principal;
  additionalMachines: number;
  additionalPrice: number;
  account: typeof accounts.$inferSelect;
  limits: Config['limits'];
}) {
  const active = await input.tx.select().from(allocations).where(isNull(allocations.retiredAt));
  const owned = active.filter((row) => row.accountId === input.principal.accountId);
  const accountCount = owned.length + input.additionalMachines;
  const accountPrice =
    owned.reduce((sum, row) => sum + row.hourlyMicroEur, 0) + input.additionalPrice;
  const globalCount = active.length + input.additionalMachines;
  const globalPrice =
    active.reduce((sum, row) => sum + row.hourlyMicroEur, 0) + input.additionalPrice;
  if (
    accountCount > Math.min(input.account.maxMachines, input.principal.policy.maxMachines) ||
    globalCount > input.limits.maxMachines
  ) {
    throw new CloudError(
      'quota_exceeded',
      'Active machines and pending reservations exceed the machine limit.',
    );
  }
  if (
    accountPrice >
      Math.min(input.account.maxHourlyMicroEur, input.principal.policy.maxHourlyMicroEur) ||
    globalPrice > input.limits.maxHourlyMicroEur
  ) {
    throw new CloudError(
      'budget_exceeded',
      'This operation exceeds the configured hourly provider budget.',
    );
  }
}

export async function admit(input: {
  db: Database;
  principal: Principal;
  request: Admission;
  key: string;
  provider: MachineProvider['kind'];
  limits: Config['limits'];
}): Promise<Operation> {
  return input.db.transaction(async (tx) => {
    // Shared admission ceiling spans accounts, so its lock precedes the account lock.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(78131025)`);
    const account = await lockAccount(tx, input.principal);
    const principal = await loadPrincipal(tx, input.principal.grantId);
    const command: LifecycleCommand =
      input.request.kind === 'create'
        ? { kind: 'create', spec: input.request.spec }
        : input.request.command;
    const scope =
      input.request.kind === 'create'
        ? `project:${input.request.projectId}:machines`
        : `machine:${input.request.machineId}:actions`;
    const fingerprint = requestHash(command);
    const [previous] = await tx
      .select()
      .from(idempotency)
      .where(
        and(
          eq(idempotency.accountId, principal.accountId),
          eq(idempotency.scope, scope),
          eq(idempotency.key, input.key),
        ),
      );
    if (previous) {
      if (previous.requestHash !== fingerprint) {
        throw new CloudError(
          'idempotency_conflict',
          'This idempotency key was used with a different request.',
        );
      }
      const [row] = await tx
        .select()
        .from(operations)
        .where(
          and(
            eq(operations.id, previous.operationId),
            eq(operations.accountId, principal.accountId),
          ),
        );
      if (!row) throw new CloudError('internal_error', 'Idempotency record has no operation.');
      const operation = operationRecord(row);
      authorizeCommand(principal, operation.projectId, command);
      return operation;
    }

    const operationId = newId.operation();
    let machine;
    if (input.request.kind === 'create') {
      const { projectId, spec } = input.request;
      authorizeCommand(principal, projectId, command);
      const [project] = await tx
        .select()
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.accountId, principal.accountId)));
      if (!project) throw new CloudError('not_found', 'Project not found.');
      const [sameName] = await tx
        .select({ id: machines.id })
        .from(machines)
        .where(
          and(
            eq(machines.projectId, projectId),
            eq(machines.name, spec.name),
            sql`${machines.state}->>'kind' <> 'destroyed'`,
          ),
        );
      if (sameName) throw new CloudError('resource_busy', 'A live machine already has this name.');
      const price = catalog[spec.size].estimatedProviderHourlyMicroEur;
      await assertReservation({
        tx,
        principal,
        account,
        limits: input.limits,
        additionalMachines: 1,
        additionalPrice: price,
      });
      const allocationId = newId.allocation();
      machine = machineSchema.parse({
        id: newId.machine(),
        accountId: principal.accountId,
        projectId,
        spec,
        provider: input.provider,
        state: { kind: 'provisioning', allocationId },
        version: 1,
        createdAt: new Date().toISOString(),
      });
      await tx
        .insert(machines)
        .values({ ...machine, name: spec.name, createdAt: new Date(machine.createdAt) });
      await tx.insert(allocations).values({
        id: allocationId,
        accountId: principal.accountId,
        machineId: machine.id,
        provider: input.provider,
        hourlyMicroEur: price,
      });
    } else {
      const [row] = await tx
        .select()
        .from(machines)
        .where(
          and(
            eq(machines.id, input.request.machineId),
            eq(machines.accountId, principal.accountId),
          ),
        )
        .for('update');
      if (!row) throw new CloudError('not_found', 'Machine not found.');
      machine = machineRecord(row);
      const action = input.request.command;
      authorizeCommand(principal, machine.projectId, action);
      if (machine.version !== action.expectedVersion) {
        throw new CloudError(
          'version_conflict',
          'Machine changed; inspect its current version before retrying.',
        );
      }
      const [active] = await tx
        .select()
        .from(operations)
        .where(
          and(
            eq(operations.machineId, machine.id),
            sql`${operations.progress}->>'kind' NOT IN ('succeeded','failed')`,
          ),
        );
      if (active)
        throw new CloudError('resource_busy', 'Another operation is still active on this machine.');
      const [allocation] = await tx
        .select()
        .from(allocations)
        .where(and(eq(allocations.machineId, machine.id), isNull(allocations.retiredAt)));
      if (!allocation?.serverId || machine.state.kind === 'destroyed') {
        throw new CloudError('resource_busy', 'Machine has no confirmed live provider allocation.');
      }
      if (action.kind === 'resize') {
        if (machine.state.kind !== 'allocated' || machine.state.power !== 'off') {
          throw new CloudError('resource_busy', 'Power off the machine before resizing.');
        }
        if (catalog[action.size].diskGb < catalog[machine.spec.size].diskGb) {
          throw new CloudError('invalid_input', 'Disk shrinking is not supported.');
        }
        const reserved = Math.max(
          allocation.hourlyMicroEur,
          catalog[action.size].estimatedProviderHourlyMicroEur,
        );
        await assertReservation({
          tx,
          principal,
          account,
          limits: input.limits,
          additionalMachines: 0,
          additionalPrice: reserved - allocation.hourlyMicroEur,
        });
        await tx
          .update(allocations)
          .set({ hourlyMicroEur: reserved })
          .where(eq(allocations.id, allocation.id));
      }
      await tx
        .update(machines)
        .set({ version: machine.version + 1 })
        .where(eq(machines.id, machine.id));
    }

    const operation = operationSchema.parse({
      id: operationId,
      accountId: principal.accountId,
      projectId: machine.projectId,
      machineId: machine.id,
      grantId: principal.grantId,
      kind: `machine.${command.kind}`,
      progress: { kind: 'queued' },
      createdAt: new Date().toISOString(),
    });
    await tx
      .insert(operations)
      .values({ ...operation, command, createdAt: new Date(operation.createdAt) });
    await tx.insert(idempotency).values({
      accountId: principal.accountId,
      scope,
      key: input.key,
      requestHash: fingerprint,
      operationId,
    });
    await tx.insert(auditEvents).values({
      accountId: principal.accountId,
      subjectId: operationId,
      event: 'operation.admitted',
      details: { machineId: machine.id, grantId: principal.grantId, kind: operation.kind },
    });
    await enqueueOperation(tx, operationId);
    return operation;
  });
}

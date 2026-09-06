import { createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  CloudError,
  selectOffer,
  catalogItemSchema,
  type CatalogSource,
  type CatalogItem,
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
  currency: string;
  account: typeof accounts.$inferSelect;
  limits: Config['limits'];
}) {
  const active = await input.tx.select().from(allocations).where(isNull(allocations.retiredAt));
  if (
    [
      input.account.currency,
      input.principal.policy.currency,
      input.limits.currency,
      ...active.map((row) => row.currency),
    ].some((currency) => currency !== input.currency)
  )
    throw new CloudError(
      'budget_exceeded',
      'Provider, account, credential, and active reservations must use the configured currency.',
    );
  const owned = active.filter((row) => row.accountId === input.principal.accountId);
  const accountCount = owned.length + input.additionalMachines;
  const accountPrice =
    owned.reduce((sum, row) => sum + row.hourlyMicros, 0) + input.additionalPrice;
  const globalCount = active.length + input.additionalMachines;
  const globalPrice =
    active.reduce((sum, row) => sum + row.hourlyMicros, 0) + input.additionalPrice;
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
      Math.min(input.account.maxHourlyMicros, input.principal.policy.maxHourlyMicros) ||
    globalPrice > input.limits.maxHourlyMicros
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
  catalog: CatalogSource;
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
    let offer: CatalogItem | null = null;
    function quote(size: MachineSpec['size'], region: MachineSpec['region']) {
      const catalog = input.catalog();
      if (catalog.provider !== input.provider)
        throw new CloudError('provider_unavailable', 'Catalog belongs to another provider.');
      return selectOffer({ catalog, size, region });
    }
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
      offer = quote(spec.size, spec.region);
      const price = offer.hourlyMicros;
      await assertReservation({
        tx,
        principal,
        account,
        limits: input.limits,
        additionalMachines: 1,
        additionalPrice: price,
        currency: offer.currency,
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
        hourlyMicros: price,
        currency: offer.currency,
        offer,
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
        offer = quote(action.size, machine.spec.region);
        const currentOffer = catalogItemSchema.parse(allocation.offer);
        if (offer.architecture !== currentOffer.architecture)
          throw new CloudError('invalid_input', 'Resizing cannot change CPU architecture.');
        if (offer.diskGb < currentOffer.diskGb) {
          throw new CloudError('invalid_input', 'Disk shrinking is not supported.');
        }
        const reserved = Math.max(allocation.hourlyMicros, offer.hourlyMicros);
        await assertReservation({
          tx,
          principal,
          account,
          limits: input.limits,
          additionalMachines: 0,
          additionalPrice: reserved - allocation.hourlyMicros,
          currency: offer.currency,
        });
        await tx
          .update(allocations)
          .set({ hourlyMicros: reserved })
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
      .values({ ...operation, command, offer, createdAt: new Date(operation.createdAt) });
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

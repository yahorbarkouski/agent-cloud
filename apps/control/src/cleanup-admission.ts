import { createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  CloudError,
  newId,
  isOperationTerminal,
  operationSchema,
  type MachineAction,
  type MachineId,
  type Principal,
  type Operation,
} from '@agent-cloud/contracts';
import {
  accounts,
  allocations,
  machines,
  operations,
  operationCleanups,
  idempotency,
  auditEvents,
  machineRecord,
  operationRecord,
  databaseTime,
  enqueueOperation,
  type Database,
} from '@agent-cloud/db';
import { authorize, loadPrincipal } from './auth.js';
import { closeMachineAccess } from './access-closure.js';

/** A destroy intent owns cleanup even after its admitting credential expires. */
export async function admitCleanup(input: {
  db: Database;
  principal: Principal;
  machineId: MachineId;
  command: Extract<MachineAction, { kind: 'destroy' }>;
  key: string;
}): Promise<Operation> {
  return input.db.transaction(async (tx) => {
    // Avoid exposing another account's lock state before the ownership check.
    const [owned] = await tx
      .select({ id: machines.id })
      .from(machines)
      .where(
        and(eq(machines.id, input.machineId), eq(machines.accountId, input.principal.accountId)),
      );
    if (!owned) throw new CloudError('not_found', 'Machine not found.');
    const locked = await tx.execute<{ acquired: boolean }>(sql`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${`machine:${input.machineId}`}, 0)) AS acquired
    `);
    if (!locked.rows[0]?.acquired)
      throw new CloudError(
        'resource_busy',
        'Machine is being advanced; retry this request key.',
        true,
      );
    await tx.execute(sql`SELECT pg_advisory_xact_lock(78131025)`);
    await tx
      .select()
      .from(accounts)
      .where(eq(accounts.id, input.principal.accountId))
      .for('update');
    const principal = await loadPrincipal(tx, input.principal.grantId);
    const [machineRow] = await tx
      .select()
      .from(machines)
      .where(and(eq(machines.id, input.machineId), eq(machines.accountId, principal.accountId)))
      .for('update');
    if (!machineRow) throw new CloudError('not_found', 'Machine not found.');
    const machine = machineRecord(machineRow);
    authorize(principal, 'machine:destroy', machine.projectId);
    if (!input.command.allowDataLoss)
      throw new CloudError(
        'data_loss_not_authorized',
        'Destroy requires explicit allowDataLoss: true.',
      );
    authorize(principal, 'machine:destroy:data_loss', machine.projectId);
    const scope = `machine:${machine.id}:actions`;
    const fingerprint = createHash('sha256').update(JSON.stringify(input.command)).digest('hex');
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
      if (previous.requestHash !== fingerprint)
        throw new CloudError(
          'idempotency_conflict',
          'This idempotency key was used with a different request.',
        );
      const [stored] = await tx
        .select()
        .from(operations)
        .where(
          and(
            eq(operations.id, previous.operationId),
            eq(operations.accountId, principal.accountId),
          ),
        );
      if (!stored) throw new CloudError('internal_error', 'Idempotency record has no operation.');
      return operationRecord(stored);
    }
    if (machine.version !== input.command.expectedVersion)
      throw new CloudError(
        'version_conflict',
        'Machine changed; inspect its current version before retrying.',
      );
    const [allocation] = await tx
      .select()
      .from(allocations)
      .where(and(eq(allocations.machineId, machine.id), isNull(allocations.retiredAt)))
      .for('update');
    if (!allocation || machine.state.kind === 'destroyed')
      throw new CloudError('resource_busy', 'Machine has no live allocation to clean.');
    const history = await tx.select().from(operations).where(eq(operations.machineId, machine.id));
    const active = history.map(operationRecord).find((op) => !isOperationTerminal(op));
    if (active && active.kind !== 'machine.create' && active.intent.kind !== 'cleanup')
      throw new CloudError('resource_busy', 'Another operation is still active on this machine.');
    const source = history.find((op) => op.kind === 'machine.create');
    if (!source)
      throw new CloudError('internal_error', 'Allocation has no source create operation.');
    const now = await databaseTime(tx);
    const operation =
      active?.intent.kind === 'cleanup'
        ? active
        : operationSchema.parse({
            ...(active ?? {
              id: newId.operation(),
              accountId: principal.accountId,
              projectId: machine.projectId,
              machineId: machine.id,
              grantId: principal.grantId,
              kind: 'machine.destroy',
              createdAt: now.toISOString(),
            }),
            intent: { kind: 'cleanup', sourceOperationId: source.id },
            progress: { kind: 'cleaning_up' },
          });
    if (active?.intent.kind !== 'cleanup') {
      if (active)
        await tx
          .update(operations)
          .set({ intent: operation.intent, progress: operation.progress })
          .where(eq(operations.id, active.id));
      else
        await tx
          .insert(operations)
          .values({ ...operation, command: input.command, createdAt: now });
      await tx.insert(operationCleanups).values({
        operationId: operation.id,
        sourceOperationId: source.id,
        accountId: principal.accountId,
        allocationId: allocation.id,
        grantId: principal.grantId,
        expectedVersion: input.command.expectedVersion,
        createdAt: now,
      });
      await tx
        .update(machines)
        .set({ version: machine.version + 1 })
        .where(eq(machines.id, machine.id));
      await tx.insert(auditEvents).values({
        accountId: principal.accountId,
        subjectId: operation.id,
        event: 'cleanup.admitted',
        details: {
          allocationId: allocation.id,
          sourceOperationId: source.id,
          grantId: principal.grantId,
          expectedVersion: input.command.expectedVersion,
          allowDataLoss: true,
        },
      });
    }
    await tx.insert(idempotency).values({
      accountId: principal.accountId,
      scope,
      key: input.key,
      requestHash: fingerprint,
      operationId: operation.id,
    });
    await closeMachineAccess(tx, principal.accountId, machine.id);
    await enqueueOperation(tx, operation.id);
    return operation;
  });
}

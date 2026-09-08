import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  CloudError,
  operationIdSchema,
  resourceRefSchema,
  providerCommandSchema,
  attemptOutcomeSchema,
} from '@agent-cloud/contracts';
import {
  controlState,
  controlRecoveries,
  grants,
  backupSchedules,
  operations,
  allocations,
  providerResources,
  attempts,
  machines,
  databaseTime,
  operationRecord,
  withControlRecoveryLock,
  type Connection,
  type Database,
} from '@agent-cloud/db';
import { readPrivateFile } from './private-file.js';
import { controlGenerationSchema, controlStateSchema } from './control-fence.js';
import { inspectControlRecovery } from './control-recovery-inspection.js';
import type { RecoveryProvider } from './operator-recovery.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const evidence = z.strictObject({ sha256: digest, reference: z.string().min(1).max(256) });
const common = {
  id: z.uuidv4(),
  generation: z.uuidv4(),
  operator: z.string().regex(/^[a-zA-Z0-9@._+-]{1,100}$/),
};
export const controlRecoveryRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('initialize') }),
  z.strictObject({
    ...common,
    kind: z.literal('begin'),
    checkpointSha256: digest,
    evidence,
    oldProcessesStopped: z.literal(true),
    oldProviderCredentialsRevoked: z.literal(true),
    oldSigningCredentialsRevoked: z.literal(true),
    oldStorageMutatorsFenced: z.literal(true),
  }),
  z.strictObject({
    ...common,
    kind: z.literal('close_operation'),
    recoveryId: z.uuidv4(),
    operationId: operationIdSchema,
    expectedState: digest,
    resourceIds: z.array(resourceRefSchema).max(100),
    providerRequestFinished: z.literal(true),
    allowDataLoss: z.literal(true),
    evidence,
  }),
  z.strictObject({
    ...common,
    kind: z.literal('resume'),
    recoveryId: z.uuidv4(),
    expectedState: digest,
    expectedInventory: digest,
    evidence,
    postCheckpointEffectsClosed: z.literal(true),
  }),
]);
export type ControlRecoveryRequest = z.infer<typeof controlRecoveryRequestSchema>;

/** Exclusively create the target generation. Never copy it from a restored private-key archive. */
export async function prepareControlGeneration(path: string) {
  if (!isAbsolute(path)) throw new CloudError('invalid_input', 'Use an absolute generation path.');
  const value = controlGenerationSchema.parse({ version: 1, generation: randomUUID() });
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return value;
}

async function exclusive<T>(connection: Connection, work: (db: Database) => Promise<T>) {
  const result = await withControlRecoveryLock({ pool: connection.pool, work });
  if (result.kind === 'busy')
    throw new CloudError(
      'resource_busy',
      'Stop all control API, worker and operator mutators before recovery.',
    );
  return result.value;
}

async function generation(path: string) {
  return controlGenerationSchema.parse(JSON.parse(await readPrivateFile(path))).generation;
}
async function requireRecovery(
  db: Database,
  request: Extract<ControlRecoveryRequest, { recoveryId: string }>,
) {
  const [row] = await db.select().from(controlState).where(eq(controlState.id, 1));
  const current = controlStateSchema.parse(row?.state);
  if (
    current.kind !== 'recovering' ||
    current.generation !== request.generation ||
    current.recoveryId !== request.recoveryId
  )
    throw new CloudError('version_conflict', 'The request does not match the fenced recovery.');
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function inspectControlOperation(db: Database, operationId: string) {
  const [operation] = await db.select().from(operations).where(eq(operations.id, operationId));
  if (!operation) throw new CloudError('not_found', 'Operation not found.');
  const allocationRows = await db
    .select()
    .from(allocations)
    .where(eq(allocations.machineId, operation.machineId))
    .orderBy(allocations.id);
  const history = await db
    .select()
    .from(attempts)
    .where(eq(attempts.operationId, operation.id))
    .orderBy(attempts.sequence);
  const allocation = allocationRows.find((row) => !row.retiredAt);
  const resources = allocation
    ? await db
        .select()
        .from(providerResources)
        .where(eq(providerResources.allocationId, allocation.id))
        .orderBy(providerResources.kind, providerResources.providerId)
    : [];
  return {
    operationId,
    expectedState: hash({ operation, allocationRows, history, resources }),
    operation,
    allocation,
    history,
    resources,
  };
}

/** Offline recovery has inventory access only. It cannot submit provider, guest, signing or storage mutations. */
export async function applyControlRecovery(input: {
  connection: Connection;
  path: string;
  request: ControlRecoveryRequest;
  provider: RecoveryProvider;
  verifyImage?: Parameters<typeof inspectControlRecovery>[0]['verifyImage'];
  verifyBackup?: Parameters<typeof inspectControlRecovery>[0]['verifyBackup'];
  imageInventory?: Parameters<typeof inspectControlRecovery>[0]['imageInventory'];
}) {
  const request = controlRecoveryRequestSchema.parse(input.request);
  if ((await generation(input.path)) !== request.generation)
    throw new CloudError('version_conflict', 'Request and private target generation differ.');
  return exclusive(input.connection, async (db) => {
    const [saved] = await db
      .select()
      .from(controlRecoveries)
      .where(eq(controlRecoveries.id, request.id));
    if (saved) {
      if (!isDeepStrictEqual(saved.request, request))
        throw new CloudError(
          'idempotency_conflict',
          'Recovery ID already describes another decision.',
        );
      return { id: request.id, kind: request.kind, replayed: true };
    }
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(78131025)`);
      const now = await databaseTime(tx);
      if ((await generation(input.path)) !== request.generation)
        throw new CloudError('version_conflict', 'Private target generation changed.');
      const [row] = await tx.select().from(controlState).where(eq(controlState.id, 1));
      if (request.kind === 'initialize') {
        const occupied = await tx.execute<{ occupied: boolean }>(
          sql`SELECT EXISTS(SELECT 1 FROM accounts) OR EXISTS(SELECT 1 FROM image_builds) AS occupied`,
        );
        if (row || occupied.rows[0]?.occupied !== false)
          throw new CloudError(
            'permission_denied',
            'Initialize requires an empty new control database. Use begin for existing or restored state.',
          );
        await tx
          .insert(controlState)
          .values({ state: { kind: 'ready', generation: request.generation } });
      } else if (request.kind === 'begin') {
        if (row) {
          const previous = controlStateSchema.parse(row.state);
          if (previous.kind === 'recovering' || previous.generation === request.generation)
            throw new CloudError(
              'version_conflict',
              'Recovery requires a new external generation and no unfinished recovery.',
            );
        }
        await tx
          .insert(controlState)
          .values({
            state: { kind: 'recovering', generation: request.generation, recoveryId: request.id },
          })
          .onConflictDoUpdate({
            target: controlState.id,
            set: {
              state: { kind: 'recovering', generation: request.generation, recoveryId: request.id },
            },
          });
        await tx.update(grants).set({ revokedAt: now }).where(isNull(grants.revokedAt));
        await tx
          .update(backupSchedules)
          .set({ disabledAt: now })
          .where(isNull(backupSchedules.disabledAt));
        await tx.execute(
          sql`UPDATE access_sessions SET connection=jsonb_build_object('kind','closed','previous',connection,'reason','authorization_changed','closedAt',${now.toISOString()}::text) WHERE connection->>'kind'<>'closed'`,
        );
      } else {
        await requireRecovery(tx, request);
        if (request.kind === 'close_operation') {
          const current = await inspectControlOperation(tx, request.operationId);
          if (current.expectedState !== request.expectedState)
            throw new CloudError('version_conflict', 'Operation state changed. Inspect it again.');
          if (
            ['succeeded', 'failed', 'cancelled'].includes(
              operationRecord(current.operation).progress.kind,
            )
          )
            throw new CloudError(
              'permission_denied',
              'Only unfinished work can receive control recovery closure.',
            );
          const allocation = current.allocation;
          if (!allocation || allocation.provider !== input.provider.kind)
            throw new CloudError(
              'permission_denied',
              'Operation needs its exact live allocation and provider.',
            );
          if (current.resources.some((resource) => resource.provider !== allocation.provider))
            throw new CloudError(
              'permission_denied',
              'Retained resource providers disagree with the allocation.',
            );
          const required = new Map(
            current.resources.map((row) => [
              `${row.kind}:${row.providerId}`,
              resourceRefSchema.parse({ kind: row.kind, id: row.providerId }),
            ]),
          );
          if (allocation.serverId)
            required.set(`server:${allocation.serverId}`, {
              kind: 'server',
              id: allocation.serverId,
            });
          const otherPending = await tx.execute<{ id: string }>(
            sql`SELECT e.id FROM provider_attempts e JOIN operations o ON o.id=e.operation_id WHERE o.machine_id=${allocation.machineId} AND o.id<>${request.operationId} AND e.resolution->>'kind'='pending' LIMIT 1`,
          );
          if (otherPending.rows.length)
            throw new CloudError(
              'resource_busy',
              'Another operation has unresolved effects for this machine. Resolve its exact recovery first.',
            );
          for (const attempt of current.history) {
            const command = providerCommandSchema.parse(attempt.command);
            const outcome = attemptOutcomeSchema.parse(attempt.outcome);
            const ref =
              outcome.kind === 'accepted' || outcome.kind === 'completed'
                ? outcome.resource
                : 'serverId' in command
                  ? { kind: 'server', id: command.serverId }
                  : command.kind === 'delete_primary_ip'
                    ? { kind: 'primary_ip', id: command.primaryIpId }
                    : undefined;
            if (ref) required.set(`${ref.kind}:${ref.id}`, resourceRefSchema.parse(ref));
          }
          const acknowledged = new Set(request.resourceIds.map((ref) => `${ref.kind}:${ref.id}`));
          if (
            acknowledged.size !== request.resourceIds.length ||
            [...required.keys()].some((key) => !acknowledged.has(key))
          )
            throw new CloudError(
              'invalid_input',
              'Closure must acknowledge every exact retained resource without duplicates.',
            );
          const labels = {
            managed_by: 'agent-cloud',
            account_id: allocation.accountId,
            machine_id: allocation.machineId,
            allocation_id: allocation.id,
          };
          const [servers, ips] = await Promise.all([
            input.provider.findServers({ labels }),
            input.provider.findPrimaryIps({ labels }),
          ]);
          if (servers.length || ips.length)
            throw new CloudError(
              'resource_busy',
              'Owned provider resources remain. Preserve or clean them up before closure.',
            );
          for (const ref of request.resourceIds) {
            const found =
              ref.kind === 'server'
                ? await input.provider.getServer({ serverId: ref.id })
                : await input.provider.getPrimaryIp({ primaryIpId: ref.id });
            if (found)
              throw new CloudError('resource_busy', 'An acknowledged exact resource still exists.');
          }
          // The receipt is required by the immutable provider-attempt transition guard.
          await tx.insert(controlRecoveries).values({ id: request.id, request });
          await tx
            .update(attempts)
            .set({ resolution: { kind: 'control_closed', recoveryId: request.id } })
            .where(
              and(
                eq(attempts.operationId, request.operationId),
                sql`${attempts.resolution}->>'kind'='pending'`,
              ),
            );
          await tx
            .update(providerResources)
            .set({ absentAt: now })
            .where(
              and(
                eq(providerResources.allocationId, allocation.id),
                isNull(providerResources.absentAt),
              ),
            );
          await tx
            .update(allocations)
            .set({ retiredAt: now })
            .where(eq(allocations.id, allocation.id));
          await tx
            .update(machines)
            .set({
              state: { kind: 'destroyed', destroyedAt: now.toISOString() },
              version: sql`${machines.version}+1`,
            })
            .where(eq(machines.id, allocation.machineId));
          await tx
            .update(operations)
            .set({
              progress: {
                kind: current.operation.kind === 'machine.destroy' ? 'succeeded' : 'cancelled',
                completedAt: now.toISOString(),
              },
            })
            .where(eq(operations.id, request.operationId));
          if ((await generation(input.path)) !== request.generation)
            throw new CloudError(
              'version_conflict',
              'Private target generation changed before closure commit.',
            );
          return { id: request.id, kind: request.kind, replayed: false };
        }
        const inspection = await inspectControlRecovery({
          db: tx,
          provider: input.provider,
          ...(input.verifyImage ? { verifyImage: input.verifyImage } : {}),
          ...(input.verifyBackup ? { verifyBackup: input.verifyBackup } : {}),
          ...(input.imageInventory ? { imageInventory: input.imageInventory } : {}),
        });
        if (inspection.blockers.length)
          throw new CloudError(
            'resource_busy',
            'Unresolved recovery items remain. Inspect control recovery before resume.',
          );
        if (
          inspection.stateDigest !== request.expectedState ||
          inspection.inventoryDigest !== request.expectedInventory
        )
          throw new CloudError(
            'version_conflict',
            'Recovery state or current inventory changed. Inspect it again.',
          );
        await tx
          .update(controlState)
          .set({ state: { kind: 'ready', generation: request.generation } })
          .where(eq(controlState.id, 1));
      }
      if ((await generation(input.path)) !== request.generation)
        throw new CloudError(
          'version_conflict',
          'Private target generation changed before commit.',
        );
      await tx.insert(controlRecoveries).values({ id: request.id, request });
      return { id: request.id, kind: request.kind, replayed: false };
    });
  });
}

import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import {
  CloudError,
  resourceRefSchema,
  type ResourceRef,
  type Operation,
} from '@agent-cloud/contracts';
import { providerResources, allocations, auditEvents, type Executor } from '@agent-cloud/db';

export type Allocation = typeof allocations.$inferSelect;
export type OwnedResource = typeof providerResources.$inferSelect;
export function allocationLabels(operation: Operation, allocation: Allocation) {
  return {
    managed_by: 'agent-cloud',
    account_id: operation.accountId,
    machine_id: operation.machineId,
    allocation_id: allocation.id,
  };
}
export function effectLabels(operation: Operation, allocation: Allocation) {
  return { ...allocationLabels(operation, allocation), operation_id: operation.id };
}
export function matchesLabels(
  value: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
) {
  return Object.entries(expected).every(([key, label]) => value[key] === label);
}
export function ownedRef(resource: OwnedResource): ResourceRef {
  return resourceRefSchema.parse({ kind: resource.kind, id: resource.providerId });
}
export function ownedLabels(resource: OwnedResource) {
  return z.record(z.string(), z.string()).parse(resource.labels);
}
export async function claimResource(
  db: Executor,
  input: { allocation: Allocation; resource: ResourceRef; labels: Record<string, string> },
) {
  const { allocation, resource, labels } = input;
  await db
    .insert(providerResources)
    .values({
      provider: allocation.provider,
      kind: resource.kind,
      providerId: resource.id,
      accountId: allocation.accountId,
      allocationId: allocation.id,
      labels,
    })
    .onConflictDoNothing();
  const [stored] = await db
    .select()
    .from(providerResources)
    .where(
      and(
        eq(providerResources.provider, allocation.provider),
        eq(providerResources.kind, resource.kind),
        eq(providerResources.providerId, resource.id),
      ),
    );
  if (
    !stored ||
    stored.allocationId !== allocation.id ||
    stored.accountId !== allocation.accountId ||
    stored.absentAt
  )
    throw new CloudError(
      'provider_outcome_unknown',
      'Provider resource is bound elsewhere or was already confirmed absent.',
    );
  if (resource.kind === 'server')
    await db
      .update(allocations)
      .set({ serverId: resource.id })
      .where(eq(allocations.id, allocation.id));
}
export async function recordAbsence(db: Executor, allocation: Allocation, resource: ResourceRef) {
  const changed = await db
    .update(providerResources)
    .set({ absentAt: new Date() })
    .where(
      and(
        eq(providerResources.provider, allocation.provider),
        eq(providerResources.allocationId, allocation.id),
        eq(providerResources.accountId, allocation.accountId),
        eq(providerResources.kind, resource.kind),
        eq(providerResources.providerId, resource.id),
        isNull(providerResources.absentAt),
      ),
    )
    .returning({ id: providerResources.providerId });
  if (changed.length)
    await db.insert(auditEvents).values({
      accountId: allocation.accountId,
      subjectId: allocation.id,
      event: 'resource.absence_confirmed',
      details: resource,
    });
}

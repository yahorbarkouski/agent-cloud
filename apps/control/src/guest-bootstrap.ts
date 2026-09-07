import { and, eq, isNull } from 'drizzle-orm';
import {
  CloudError,
  bootstrapReferenceSchema,
  bootstrapSpecSchema,
  catalogItemSchema,
  type BootstrapReference,
  type BootstrapSpec,
  type GuestImage,
  type Operation,
} from '@agent-cloud/contracts';
import { allocations, guestBootstraps, type Database, type Transaction } from '@agent-cloud/db';
import type { BootstrapSeal } from './bootstrap-seal.js';
import type { Allocation } from './resource-journal.js';

// Validated schemas determine stable key order, including nested image metadata.
function binding(spec: BootstrapSpec) {
  return JSON.stringify(bootstrapSpecSchema.parse(spec));
}
export async function prepareGuestBootstrap(
  tx: Transaction,
  input: {
    allocation: Allocation;
    operation: Operation;
    image: GuestImage;
    enrollmentUrl: string;
    seal: BootstrapSeal;
  },
): Promise<BootstrapReference> {
  const { allocation, operation } = input;
  if (
    operation.kind !== 'machine.create' ||
    operation.accountId !== allocation.accountId ||
    operation.machineId !== allocation.machineId ||
    allocation.retiredAt
  )
    throw new CloudError('internal_error', 'Guest bootstrap requires its live create allocation.');
  const [current] = await tx
    .select()
    .from(guestBootstraps)
    .where(eq(guestBootstraps.allocationId, allocation.id));
  if (current) {
    if (current.accountId !== operation.accountId || current.operationId !== operation.id)
      throw new CloudError(
        'internal_error',
        'Guest bootstrap ownership does not match its operation.',
      );
    if (current.expiresAt.getTime() <= Date.now() || current.consumedAt)
      throw new CloudError(
        'provider_rejected',
        'Guest bootstrap is no longer usable for a new VM submission.',
      );
    return bootstrapReferenceSchema.parse({ version: 1, allocationId: allocation.id });
  }
  const offer = catalogItemSchema.parse(allocation.offer);
  if (input.image.architecture !== offer.architecture)
    throw new CloudError(
      'invalid_input',
      'Guest image architecture does not match the admitted offer.',
    );
  const spec = bootstrapSpecSchema.parse({
    version: 1,
    accountId: operation.accountId,
    machineId: operation.machineId,
    allocationId: allocation.id,
    operationId: operation.id,
    image: input.image,
    enrollmentUrl: input.enrollmentUrl,
    expiresAt: new Date(Date.parse(operation.createdAt) + 30 * 60_000).toISOString(),
  });
  const { sealed, hash } = input.seal.issue(binding(spec));
  await tx
    .insert(guestBootstraps)
    .values({
      accountId: operation.accountId,
      allocationId: allocation.id,
      operationId: operation.id,
      spec,
      tokenHash: hash,
      sealedToken: sealed,
      expiresAt: new Date(spec.expiresAt),
    })
    .onConflictDoNothing();
  // Concurrent preparation adopts the winner; it never returns the loser's transient secret.
  const [stored] = await tx
    .select()
    .from(guestBootstraps)
    .where(eq(guestBootstraps.allocationId, allocation.id));
  if (!stored || stored.accountId !== operation.accountId || stored.operationId !== operation.id)
    throw new CloudError('internal_error', 'Guest bootstrap could not be prepared.');
  return bootstrapReferenceSchema.parse({ version: 1, allocationId: allocation.id });
}

export async function recoverGuestBootstrap(
  db: Database,
  input: { reference: BootstrapReference; seal: BootstrapSeal },
): Promise<{ spec: BootstrapSpec; token: string }> {
  const [row] = await db
    .select({ bootstrap: guestBootstraps, allocation: allocations })
    .from(guestBootstraps)
    .innerJoin(
      allocations,
      and(
        eq(allocations.id, guestBootstraps.allocationId),
        eq(allocations.accountId, guestBootstraps.accountId),
      ),
    )
    .where(
      and(
        eq(guestBootstraps.allocationId, input.reference.allocationId),
        isNull(allocations.retiredAt),
      ),
    );
  if (
    !row ||
    row.bootstrap.expiresAt.getTime() <= Date.now() ||
    row.bootstrap.consumedAt ||
    !row.bootstrap.sealedToken
  )
    throw new CloudError(
      'provider_rejected',
      'Guest bootstrap is absent, expired, or already consumed.',
    );
  const spec = bootstrapSpecSchema.parse(row.bootstrap.spec);
  if (
    spec.accountId !== row.allocation.accountId ||
    spec.allocationId !== row.allocation.id ||
    spec.machineId !== row.allocation.machineId ||
    spec.operationId !== row.bootstrap.operationId ||
    spec.expiresAt !== row.bootstrap.expiresAt.toISOString()
  )
    throw new CloudError(
      'internal_error',
      'Guest bootstrap metadata does not match its allocation.',
    );
  const token = input.seal.recover(row.bootstrap.sealedToken, binding(spec));
  if (!input.seal.matches(token, row.bootstrap.tokenHash))
    throw new CloudError(
      'internal_error',
      'Guest bootstrap hash does not match its encrypted material.',
    );
  return { spec, token };
}

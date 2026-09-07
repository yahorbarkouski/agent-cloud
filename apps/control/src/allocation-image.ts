import { and, eq, sql } from 'drizzle-orm';
import {
  CloudError,
  catalogItemSchema,
  imageBuildIdSchema,
  imageBuildStateSchema,
  type ImageBuildId,
  type ImageProvider,
  type Operation,
} from '@agent-cloud/contracts';
import {
  allocationImages,
  allocations,
  imageBuilds,
  imagePublications,
  databaseTime,
  type Connection,
  type Executor,
  type Transaction,
} from '@agent-cloud/db';
import type { Allocation } from './resource-journal.js';
import {
  readPublishedImage,
  requireTrustedImageRelease,
  type ImageReleaseKeySource,
} from './image-publication.js';

export type ImageReleaseSelection = { buildId: ImageBuildId; readKeys: ImageReleaseKeySource };

/** Admission verifies signed metadata locally; the worker observes the provider before any create. */
export async function pinAllocationImage(
  tx: Transaction,
  input: {
    allocationId: string;
    operation: Operation;
    selection: ImageReleaseSelection;
  },
) {
  const [allocation] = await tx
    .select()
    .from(allocations)
    .where(
      and(
        eq(allocations.id, input.allocationId),
        eq(allocations.accountId, input.operation.accountId),
      ),
    );
  const [build] = await tx
    .select()
    .from(imageBuilds)
    .where(eq(imageBuilds.id, input.selection.buildId))
    .for('update');
  const [publication] = await tx
    .select()
    .from(imagePublications)
    .where(eq(imagePublications.buildId, input.selection.buildId));
  if (
    !allocation ||
    allocation.provider !== 'hetzner' ||
    allocation.retiredAt ||
    allocation.machineId !== input.operation.machineId ||
    input.operation.kind !== 'machine.create' ||
    !build ||
    imageBuildStateSchema.parse(build.state).kind !== 'retained' ||
    !publication?.release
  )
    throw new CloudError(
      'provider_unavailable',
      'New allocations require a retained published image.',
    );
  const { image, release } = requireTrustedImageRelease(
    publication.release,
    await input.selection.readKeys(),
    await databaseTime(tx),
  );
  const offer = catalogItemSchema.parse(allocation.offer);
  if (
    image.architecture !== offer.architecture ||
    release.payload.snapshot.diskGb > offer.diskGb ||
    Date.parse(release.payload.retainUntil) <= Date.parse(input.operation.createdAt) + 30 * 60_000
  )
    throw new CloudError(
      'invalid_input',
      'Image architecture, disk size or retention cannot cover this boot operation.',
    );
  await tx.insert(allocationImages).values({
    allocationId: allocation.id,
    accountId: allocation.accountId,
    operationId: input.operation.id,
    buildId: input.selection.buildId,
    snapshotId: image.providerImage,
  });
}

export async function imageSnapshotInUse(db: Executor, buildId: ImageBuildId) {
  const rows = await db.execute<{ in_use: boolean }>(
    sql`SELECT image_snapshot_in_use(${buildId}) AS in_use`,
  );
  const result = rows.rows[0];
  if (!result) throw new CloudError('internal_error', 'Image pin query returned no result.');
  return result.in_use;
}

/** A pinned allocation always resolves its original build, regardless of the operator's next default. */
export function createAllocationImageResolver(input: {
  connection: Connection;
  provider: ImageProvider;
  readKeys: ImageReleaseKeySource;
}) {
  return async (allocation: Allocation) => {
    const [pin] = await input.connection.db
      .select()
      .from(allocationImages)
      .where(
        and(
          eq(allocationImages.allocationId, allocation.id),
          eq(allocationImages.accountId, allocation.accountId),
        ),
      );
    if (!pin)
      throw new CloudError('provider_rejected', 'Allocation has no admitted image release.');
    const selected = await readPublishedImage({
      ...input,
      buildId: imageBuildIdSchema.parse(pin.buildId),
    });
    if (selected.kind === 'busy')
      throw new CloudError('provider_unavailable', 'Image publication is busy.', true);
    if (selected.value.image.providerImage !== pin.snapshotId)
      throw new CloudError(
        'provider_rejected',
        'Allocation image differs from its pinned snapshot.',
      );
    return selected.value.image;
  };
}

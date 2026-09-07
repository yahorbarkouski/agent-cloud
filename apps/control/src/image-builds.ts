import { eq, sql } from 'drizzle-orm';
import {
  CloudError,
  imageBuildAdmissionSchema,
  imagePublicationSchema,
  imageBuildStateSchema,
  imageBuilderWorkSchema,
  imageEffectOutcomeSchema,
  imageEffectResolutionSchema,
  imageProviderCommandSchema,
  imageResourceRefSchema,
  imageResourceRoleSchema,
  imageResourceStateSchema,
  type Catalog,
  type ImageBuildAdmission,
  type ImageBuildId,
  type ImageBuildLimits,
} from '@agent-cloud/contracts';
import {
  imageBuilds,
  imageBuildEffects,
  imageBuildResources,
  imageBuilderWork,
  imagePublications,
  type Database,
} from '@agent-cloud/db';
import { verifyImageInputs } from '@agent-cloud/images';
import { enqueueImageBuild } from './image-scheduling.js';
import { readImageVerification } from './image-verifier-records.js';
import {
  checkImageAdmission,
  checkImageLimits,
  checkImagePrices,
  parseImageReservations,
} from './image-budget.js';

/** Validates the actual local input tree before committing a resource-free admission. */
export async function admitImageBuild(input: {
  db: Database;
  admission: ImageBuildAdmission;
  sourceDirectory: string;
  catalog: Catalog;
  limits: ImageBuildLimits;
}) {
  const admission = imageBuildAdmissionSchema.parse(input.admission);
  const source = await verifyImageInputs(input.sourceDirectory, admission.source.manifestDigest);
  if (
    JSON.stringify(source) !==
    JSON.stringify({
      manifest: admission.source.manifest,
      inputs: admission.source.inputs,
      artifacts: admission.source.artifacts,
      manifestDigest: admission.source.manifestDigest,
      checksumDigest: admission.source.checksumDigest,
    })
  )
    throw new CloudError(
      'invalid_input',
      'Admission must describe the verified local image inputs.',
    );
  return input.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(78131026)`);
    const [previous] = await tx.select().from(imageBuilds).where(eq(imageBuilds.id, admission.id));
    if (previous) {
      if (
        JSON.stringify(imageBuildAdmissionSchema.parse(previous.admission)) !==
        JSON.stringify(admission)
      )
        throw new CloudError(
          'idempotency_conflict',
          'This build ID already describes a different admission.',
        );
      return { admission, state: imageBuildStateSchema.parse(previous.state) };
    }
    const now = Date.now();
    checkImageAdmission(admission, now);
    checkImagePrices({
      admission,
      catalog: input.catalog,
      storagePrice: admission.storagePrice,
      now,
    });
    const open = await tx
      .select()
      .from(imageBuilds)
      .where(sql`${imageBuilds.state}->>'kind' <> 'cleaned'`);
    checkImageLimits(
      parseImageReservations([...open, { admission, state: { kind: 'running' } }]),
      input.limits,
    );
    await tx.insert(imageBuilds).values({ id: admission.id, admission });
    await enqueueImageBuild(tx, admission.id, new Date(admission.deadlineAt));
    return { admission, state: imageBuildStateSchema.parse({ kind: 'running' }) };
  });
}

export async function inspectImageBuild(db: Database, buildId: ImageBuildId) {
  // One statement snapshot keeps cleanup and concurrent receipts from producing a mixed view.
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    const [row] = await tx.select().from(imageBuilds).where(eq(imageBuilds.id, buildId));
    if (!row) throw new CloudError('not_found', 'Image build not found.');
    const effects = await tx
      .select()
      .from(imageBuildEffects)
      .where(eq(imageBuildEffects.buildId, buildId))
      .orderBy(imageBuildEffects.createdAt, imageBuildEffects.id);
    const resources = await tx
      .select()
      .from(imageBuildResources)
      .where(eq(imageBuildResources.buildId, buildId))
      .orderBy(imageBuildResources.kind, imageBuildResources.providerId);
    const [builder] = await tx
      .select()
      .from(imageBuilderWork)
      .where(eq(imageBuilderWork.buildId, buildId));
    const [publication] = await tx
      .select()
      .from(imagePublications)
      .where(eq(imagePublications.buildId, buildId));
    return {
      runRequestedAt: row.runRequestedAt?.toISOString() ?? null,
      accessRemovedAt: row.accessRemovedAt?.toISOString() ?? null,
      publication: imagePublicationSchema.parse(
        !publication
          ? { kind: 'waiting' }
          : publication.release === null
            ? { kind: 'prepared', evidence: publication.evidence }
            : { kind: 'published', release: publication.release },
      ),
      admission: imageBuildAdmissionSchema.parse(row.admission),
      state: imageBuildStateSchema.parse(row.state),
      verification: await readImageVerification(tx, buildId),
      builderWork: imageBuilderWorkSchema.parse(
        builder
          ? {
              kind: 'recorded',
              serverId: builder.serverId,
              effectId: builder.effectId,
              progress: builder.progress,
              createdAt: builder.createdAt.toISOString(),
            }
          : { kind: 'waiting' },
      ),
      effects: effects.map((effect) => ({
        id: effect.id,
        key: effect.effectKey,
        command: imageProviderCommandSchema.parse(effect.command),
        outcome: imageEffectOutcomeSchema.parse(effect.outcome),
        resolution: imageEffectResolutionSchema.parse(effect.resolution),
        createdAt: effect.createdAt.toISOString(),
      })),
      resources: resources.map((resource) => ({
        ref: imageResourceRefSchema.parse({ kind: resource.kind, id: resource.providerId }),
        role: imageResourceRoleSchema.parse(resource.role),
        effectId: resource.effectId,
        state: imageResourceStateSchema.parse(resource.state),
      })),
    };
  });
}
export type ImageBuild = Awaited<ReturnType<typeof inspectImageBuild>>;

export async function requestImageCleanup(
  db: Database,
  buildId: ImageBuildId,
  reason: 'requested' | 'expired' | 'failed' = 'requested',
) {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(imageBuilds)
      .where(eq(imageBuilds.id, buildId))
      .for('update');
    if (!row) throw new CloudError('not_found', 'Image build not found.');
    if (['running', 'releasing', 'retained'].includes(imageBuildStateSchema.parse(row.state).kind))
      await tx
        .update(imageBuilds)
        .set({ state: { kind: 'cleaning', reason } })
        .where(eq(imageBuilds.id, buildId));
    if (imageBuildStateSchema.parse(row.state).kind !== 'cleaned' || !row.accessRemovedAt)
      await enqueueImageBuild(tx, buildId);
  });
}

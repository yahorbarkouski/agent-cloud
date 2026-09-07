import { eq } from 'drizzle-orm';
import {
  CloudError,
  imageBuilderBootSchema,
  imageBuilderProgressSchema,
  type ImageBuildId,
  type ImageBuilderProgress,
  type ImageProvider,
} from '@agent-cloud/contracts';
import {
  imageBuilderWork,
  withImageBuildLock,
  type Connection,
  type Database,
} from '@agent-cloud/db';
import type { createImageBuilder } from '@agent-cloud/remote';
import { inspectImageBuild, requestImageCleanup, type ImageBuild } from './image-builds.js';
import { imageCreateMatches, observeImageResource } from './image-resources.js';
import type { ImageAccessStore } from './image-access.js';

type Remote = ReturnType<typeof createImageBuilder>;
type Result =
  | { kind: 'progress'; progress: ImageBuilderProgress }
  | { kind: 'waiting'; reason: string }
  | { kind: 'cleanup' };

async function active(db: Database, buildId: ImageBuildId) {
  const build = await inspectImageBuild(db, buildId);
  if (build.state.kind !== 'running') return false;
  if (Date.parse(build.admission.deadlineAt) <= Date.now()) {
    await requestImageCleanup(db, buildId, 'expired');
    return false;
  }
  if (build.effects.some((effect) => effect.resolution.kind === 'pending'))
    throw new CloudError(
      'provider_outcome_unknown',
      'Reconcile image effects before builder execution.',
      true,
    );
  return true;
}

async function currentBuilder(db: Database, build: ImageBuild, provider: ImageProvider) {
  const builders = build.resources.filter((resource) => resource.role === 'builder');
  const resource = builders[0];
  const effect = build.effects.find((effect) => effect.id === resource?.effectId);
  if (
    builders.length !== 1 ||
    !resource ||
    resource.state.kind !== 'observed' ||
    !effect ||
    effect.command.kind !== 'create_server' ||
    effect.resolution.kind !== 'confirmed'
  )
    throw new CloudError(
      'provider_outcome_unknown',
      'Builder execution needs one confirmed owned server.',
      true,
    );
  if (
    build.builderWork.kind === 'recorded' &&
    (build.builderWork.serverId !== resource.ref.id || build.builderWork.effectId !== effect.id)
  )
    throw new CloudError(
      'permission_denied',
      'Builder execution belongs to another server intent.',
    );
  const command = effect.command;
  const ip = build.resources.find(
    (item) => item.role === 'builder_ip' && item.ref.id === command.primaryIpId,
  );
  if (!ip || ip.state.kind !== 'observed')
    throw new CloudError('provider_outcome_unknown', 'Builder address is not owned.', true);
  const address = await provider.get(ip.ref);
  await observeImageResource(db, build, ip.ref, address);
  if (
    address?.kind !== 'primary_ip' ||
    address.serverId !== resource.ref.id ||
    address.autoDelete ||
    address.region !== build.admission.offer.region
  )
    throw new CloudError('provider_outcome_unknown', 'Builder address assignment changed.', true);
  const current = await provider.get(resource.ref);
  await observeImageResource(db, build, resource.ref, current);
  const updated = await inspectImageBuild(db, build.admission.id);
  if (
    current?.kind !== 'server' ||
    current.ipv4 === null ||
    !imageCreateMatches(updated, effect, current)
  )
    throw new CloudError(
      'provider_outcome_unknown',
      'Builder server configuration or ownership changed.',
      true,
    );
  return { serverId: current.id, effectId: effect.id, address: current.ipv4 };
}

/** Advances one SSH phase under the same build lock used by provider effects and cleanup. */
export async function runImageBuilderWork(input: {
  connection: Connection;
  buildId: ImageBuildId;
  provider: ImageProvider;
  access: ImageAccessStore;
  remote: Remote;
  sourceDirectory: string;
}) {
  return withImageBuildLock({
    pool: input.connection.pool,
    buildId: input.buildId,
    work: async (db): Promise<Result> => {
      if (!(await active(db, input.buildId))) return { kind: 'cleanup' };
      const build = await inspectImageBuild(db, input.buildId);
      let work = build.builderWork;
      if (work.kind === 'recorded' && work.progress.kind === 'sanitized')
        return { kind: 'progress', progress: work.progress };
      // A previous process may have erased access without persisting its final receipt.
      if (work.kind === 'recorded' && work.progress.kind === 'sanitizing') {
        await requestImageCleanup(db, input.buildId, 'failed');
        return { kind: 'cleanup' };
      }
      const builder = await currentBuilder(db, build, input.provider);
      const material = await input.access.recover(build.admission);
      if (!(await active(db, input.buildId))) return { kind: 'cleanup' };
      if (work.kind === 'waiting') {
        await db.insert(imageBuilderWork).values({
          buildId: input.buildId,
          effectId: builder.effectId,
          serverId: builder.serverId,
        });
        work = (await inspectImageBuild(db, input.buildId)).builderWork;
      }
      if (work.kind !== 'recorded')
        throw new CloudError('internal_error', 'Builder intent was not persisted.');
      const target = {
        boot: imageBuilderBootSchema.parse({
          version: 1,
          buildId: input.buildId,
          effectId: builder.effectId,
          manifestDigest: build.admission.source.manifestDigest,
        }),
        address: builder.address,
        hostPublicKey: build.admission.access.hostPublicKey,
        managementPrivateKey: material.managementPrivateKey,
        checksumDigest: build.admission.source.checksumDigest,
        deadlineAt: build.admission.deadlineAt,
      };
      const save = async (progress: ImageBuilderProgress): Promise<Result> => {
        const parsed = imageBuilderProgressSchema.parse(progress);
        await db
          .update(imageBuilderWork)
          .set({ progress: parsed })
          .where(eq(imageBuilderWork.buildId, input.buildId));
        return { kind: 'progress', progress: parsed };
      };
      if (work.progress.kind === 'installing') {
        try {
          let installation = await input.remote.inspect(target);
          if (installation.kind === 'not_started') {
            if (!(await active(db, input.buildId))) return { kind: 'cleanup' };
            await input.remote.upload({ ...target, sourceDirectory: input.sourceDirectory });
            if (!(await active(db, input.buildId))) return { kind: 'cleanup' };
            installation = await input.remote.install(target);
          }
          if (installation.kind !== 'installed')
            return {
              kind: 'waiting',
              reason:
                'Builder installation has started; inspect its durable receipt on the next pass.',
            };
          return await save({ kind: 'installed', installation: installation.receipt });
        } catch (error) {
          if (
            error instanceof CloudError &&
            error.failure.code === 'guest_unreachable' &&
            error.failure.retryable
          )
            return {
              kind: 'waiting',
              reason:
                'Builder SSH ended without a receipt; reconcile installation before retrying.',
            };
          throw error;
        }
      }
      if (work.progress.kind !== 'installed')
        throw new CloudError('internal_error', 'Unexpected builder phase.');
      if (!(await active(db, input.buildId))) return { kind: 'cleanup' };
      await save({ kind: 'sanitizing', installation: work.progress.installation });
      let sanitation;
      try {
        sanitation = await input.remote.sanitize(target);
      } catch {
        await requestImageCleanup(db, input.buildId, 'failed');
        return { kind: 'cleanup' };
      }
      // Persist observed completion even if cancellation arrived during the SSH call. Cleanup still wins.
      return save({ kind: 'sanitized', installation: work.progress.installation, sanitation });
    },
  });
}

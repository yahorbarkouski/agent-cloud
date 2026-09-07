import { isDeepStrictEqual } from 'node:util';
import type { KeyObject } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  CloudError,
  imageEffectLabels,
  imageReleaseEvidenceSchema,
  type ImageBuildId,
  type ImageProvider,
  type ImageReleaseEvidence,
  type ImageReleaseKey,
} from '@agent-cloud/contracts';
import {
  imageBuilds,
  imagePublications,
  databaseTime,
  withImageBuildLock,
  type Connection,
  type Database,
} from '@agent-cloud/db';
import { signImageRelease, verifySignedImageRelease } from '@agent-cloud/images';
import { inspectImageBuild, type ImageBuild } from './image-builds.js';
import { requireActiveImageBuild } from './image-verifier-records.js';
import { observeImageResource } from './image-resources.js';
import { observeImageVerifier, verifierSnapshot } from './image-verifier.js';
import { matchesLabels } from './resource-journal.js';

type Ports = { connection: Connection; buildId: ImageBuildId; provider: ImageProvider };
export type ImagePublicationSigner = { privateKey: KeyObject; keys: ImageReleaseKey[] };

/** Validation has no I/O. An invalid release must fail admission or compensate an unsubmitted boot. */
export function requireTrustedImageRelease(value: unknown, keys: ImageReleaseKey[], now: Date) {
  try {
    return verifySignedImageRelease(value, keys, now);
  } catch {
    throw new CloudError(
      'permission_denied',
      'Image release is invalid, expired or its signing key is not trusted.',
    );
  }
}

/** Capture provenance before cleanup removes the source and verifier observations. */
export async function prepareImagePublication(input: Ports) {
  return withImageBuildLock({
    pool: input.connection.pool,
    buildId: input.buildId,
    work: async (db) => {
      const build = await inspectImageBuild(db, input.buildId);
      if (build.state.kind === 'releasing' || build.state.kind === 'retained')
        return build.publication;
      const { admission, verification, builderWork } = build;
      if (
        admission.retention.kind !== 'retain' ||
        verification.kind !== 'verified' ||
        builderWork.kind !== 'recorded' ||
        builderWork.progress.kind !== 'sanitized' ||
        build.effects.some((effect) => effect.resolution.kind === 'pending')
      )
        throw new CloudError(
          'permission_denied',
          'Publication needs an admitted retained snapshot and verified boot.',
        );
      await db.transaction((tx) => requireActiveImageBuild(tx, input.buildId));
      await observeImageVerifier(build, input.provider);
      const snapshot = verifierSnapshot(build);
      const current = await input.provider.get(snapshot.ref);
      await observeImageResource(db, build, snapshot.ref, current);
      const stopped = build.effects.find(
        (effect) =>
          effect.command.kind === 'power_off' &&
          effect.command.serverId === builderWork.serverId &&
          effect.resolution.kind === 'confirmed',
      );
      if (
        !current ||
        current.kind !== 'snapshot' ||
        current.status !== 'available' ||
        current.deleteProtected ||
        !stopped ||
        stopped.resolution.kind !== 'confirmed'
      )
        throw new CloudError(
          'provider_outcome_unknown',
          'Publication snapshot is unavailable or cannot be cleaned up.',
        );
      const evidence = imageReleaseEvidenceSchema.parse({
        format: 1,
        buildId: input.buildId,
        retainUntil: admission.retention.deleteAfter,
        manifest: admission.source.manifest,
        inputs: admission.source.inputs,
        artifacts: admission.source.artifacts,
        sanitation: { ...builderWork.progress.sanitation, serverId: builderWork.serverId },
        snapshot: {
          provider: 'hetzner',
          id: current.id,
          sourceServerId: builderWork.serverId,
          diskGb: current.diskGb,
          sourceStoppedAt: stopped.resolution.at,
          createdAt: current.createdAt,
        },
        verifiedBoot: {
          serverId: verification.result.serverId,
          bootId: verification.result.runtime.bootId,
          manifestDigest: verification.result.runtime.proof.manifestDigest,
          checkedAt: verification.result.verifiedAt,
        },
      });
      await db.transaction(async (tx) => {
        await requireActiveImageBuild(tx, input.buildId);
        await tx.insert(imagePublications).values({ buildId: input.buildId, evidence });
        await tx
          .update(imageBuilds)
          .set({ state: { kind: 'releasing' } })
          .where(eq(imageBuilds.id, input.buildId));
      });
      return { kind: 'prepared', evidence } satisfies {
        kind: 'prepared';
        evidence: ImageReleaseEvidence;
      };
    },
  });
}

function requireTemporaryCleanup(build: ImageBuild) {
  if (
    build.effects.some((effect) => effect.resolution.kind === 'pending') ||
    build.resources.some(
      (resource) => resource.role !== 'snapshot' && resource.state.kind !== 'absent',
    )
  )
    throw new CloudError(
      'provider_outcome_unknown',
      'Publication requires resolved effects and absent temporary resources.',
    );
}

/** Historical source ownership is saved before deletion; a different nonnull source is never accepted. */
async function observePublishedSnapshot(
  build: ImageBuild,
  evidence: ImageReleaseEvidence,
  provider: ImageProvider,
) {
  const snapshots = build.resources.filter((resource) => resource.role === 'snapshot');
  const record = snapshots[0];
  if (
    snapshots.length !== 1 ||
    !record ||
    record.ref.id !== evidence.snapshot.id ||
    record.state.kind !== 'observed' ||
    !build.effects.some(
      (effect) => effect.id === record.effectId && effect.resolution.kind === 'confirmed',
    )
  )
    throw new CloudError('provider_outcome_unknown', 'Release snapshot ownership is unresolved.');
  const snapshot = await provider.get(record.ref);
  if (
    !snapshot ||
    snapshot.kind !== 'snapshot' ||
    snapshot.id !== record.ref.id ||
    !matchesLabels(
      snapshot.labels,
      imageEffectLabels({
        buildId: build.admission.id,
        role: 'snapshot',
        effectId: record.effectId,
      }),
    ) ||
    snapshot.status !== 'available' ||
    snapshot.deleteProtected ||
    snapshot.architecture !== evidence.manifest.architecture ||
    snapshot.diskGb !== evidence.snapshot.diskGb ||
    snapshot.createdAt !== evidence.snapshot.createdAt ||
    (snapshot.sourceServerId !== null &&
      snapshot.sourceServerId !== evidence.snapshot.sourceServerId)
  )
    throw new CloudError(
      'provider_outcome_unknown',
      'Release snapshot is missing or its ownership or metadata changed.',
    );
  return snapshot;
}

/** Sign only after temporary cleanup. The release and retained state commit together. */
export async function publishImageRelease(input: Ports & ImagePublicationSigner) {
  return withImageBuildLock({
    pool: input.connection.pool,
    buildId: input.buildId,
    work: async (db) => {
      const build = await inspectImageBuild(db, input.buildId);
      if (build.state.kind === 'retained')
        return (await resolvePublishedImage(db, build, input)).release;
      if (build.state.kind !== 'releasing' || build.publication.kind !== 'prepared')
        throw new CloudError('permission_denied', 'The build has no active publication intent.');
      requireTemporaryCleanup(build);
      if (!build.accessRemovedAt)
        throw new CloudError(
          'permission_denied',
          'Publication requires recorded local key removal.',
        );
      const { evidence } = build.publication;
      const snapshot = await observePublishedSnapshot(build, evidence, input.provider);
      await observeImageResource(db, build, { kind: 'snapshot', id: snapshot.id }, snapshot);
      const issuedAt = await databaseTime(db);
      const release = signImageRelease(
        { ...evidence, issuedAt: issuedAt.toISOString() },
        input.privateKey,
      );
      requireTrustedImageRelease(release, input.keys, issuedAt);
      await db.transaction(async (tx) => {
        // The database guard locks the build and rechecks cancellation, deadline and cleanup.
        await tx
          .update(imagePublications)
          .set({ release })
          .where(eq(imagePublications.buildId, input.buildId));
        await tx
          .update(imageBuilds)
          .set({ state: { kind: 'retained', at: release.payload.issuedAt } })
          .where(eq(imageBuilds.id, input.buildId));
      });
      return release;
    },
  });
}

async function resolvePublishedImage(
  db: Database,
  build: ImageBuild,
  input: Ports & { keys: ImageReleaseKey[] },
) {
  if (build.state.kind !== 'retained' || build.publication.kind !== 'published')
    throw new CloudError('permission_denied', 'Only a retained published image can be selected.');
  requireTemporaryCleanup(build);
  const result = requireTrustedImageRelease(
    build.publication.release,
    input.keys,
    await databaseTime(db),
  );
  const evidence = imageReleaseEvidenceSchema.strip().parse(result.release.payload);
  if (!isDeepStrictEqual(result.release.payload.manifest, build.admission.source.manifest))
    throw new CloudError('permission_denied', 'Published image differs from its admission.');
  await observePublishedSnapshot(build, evidence, input.provider);
  const refreshed = await inspectImageBuild(db, input.buildId);
  if (refreshed.state.kind !== 'retained')
    throw new CloudError('permission_denied', 'Image retention was cancelled during selection.');
  requireTrustedImageRelease(result.release, input.keys, await databaseTime(db));
  return result;
}

/** Resolves one exact published build; allocation admission must separately pin its lifetime. */
export async function readPublishedImage(input: Ports & { keys: ImageReleaseKey[] }) {
  return withImageBuildLock({
    pool: input.connection.pool,
    buildId: input.buildId,
    work: async (db) =>
      resolvePublishedImage(db, await inspectImageBuild(db, input.buildId), input),
  });
}

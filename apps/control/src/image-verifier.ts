import { isDeepStrictEqual } from 'node:util';
import { eq } from 'drizzle-orm';
import {
  CloudError,
  imageVerifierSpecSchema,
  imageVerifierReferenceSchema,
  imageEffectLabels,
  type ImageBuildId,
  type ImageProvider,
  type ImageResourceRole,
} from '@agent-cloud/contracts';
import {
  imageVerifierBootstraps,
  databaseTime,
  withImageBuildLock,
  type Connection,
  type Database,
} from '@agent-cloud/db';
import type { BootstrapSeal } from './bootstrap-seal.js';
import { inspectImageBuild, type ImageBuild } from './image-builds.js';
import { requireActiveImageBuild } from './image-verifier-records.js';
import { matchesLabels } from './resource-journal.js';

export function confirmedImageResource(build: ImageBuild, role: ImageResourceRole) {
  const resources = build.resources.filter((item) => item.role === role);
  const resource = resources[0];
  if (
    resources.length !== 1 ||
    !resource ||
    resource.state.kind !== 'observed' ||
    !build.effects.some(
      (item) => item.id === resource.effectId && item.resolution.kind === 'confirmed',
    )
  )
    throw new CloudError(
      'provider_unavailable',
      'Image verification requires one confirmed owned resource for each role.',
      true,
    );
  return resource;
}

export function verifierSnapshot(build: ImageBuild) {
  const snapshot = confirmedImageResource(build, 'snapshot');
  if (
    build.builderWork.kind !== 'recorded' ||
    build.builderWork.progress.kind !== 'sanitized' ||
    snapshot.state.kind !== 'observed' ||
    snapshot.state.resource.kind !== 'snapshot' ||
    snapshot.state.resource.sourceServerId !== build.builderWork.serverId ||
    snapshot.state.resource.status !== 'available'
  )
    throw new CloudError(
      'permission_denied',
      'Image verification requires its sanitized builder snapshot.',
    );
  return snapshot;
}

export async function prepareImageVerification(input: {
  connection: Connection;
  buildId: ImageBuildId;
  seal: BootstrapSeal;
  enrollmentUrl: string;
}) {
  return withImageBuildLock({
    pool: input.connection.pool,
    buildId: input.buildId,
    work: async (db) => {
      const build = await inspectImageBuild(db, input.buildId);
      const snapshot = verifierSnapshot(build);
      const { manifest, manifestDigest } = build.admission.source;
      return db.transaction(async (tx) => {
        await requireActiveImageBuild(tx, input.buildId);
        const [existing] = await tx
          .select()
          .from(imageVerifierBootstraps)
          .where(eq(imageVerifierBootstraps.buildId, input.buildId));
        const spec = imageVerifierSpecSchema.parse({
          version: 2,
          subject: { kind: 'image_verifier', id: input.buildId },
          enrollmentUrl: input.enrollmentUrl,
          expiresAt:
            existing?.expiresAt.toISOString() ??
            new Date(
              Math.min(
                Date.parse(build.admission.deadlineAt),
                (await databaseTime(tx)).getTime() + 30 * 60_000,
              ),
            ).toISOString(),
          image: {
            providerImage: snapshot.ref.id,
            architecture: manifest.architecture,
            version: manifest.version,
            manifestDigest,
            ...manifest.trust,
            ...(manifest.customerSsh === 1 ? { customerSsh: 1 } : {}),
          },
        });
        if (existing) {
          if (
            !isDeepStrictEqual(imageVerifierSpecSchema.parse(existing.spec), spec) ||
            existing.snapshotId !== snapshot.ref.id
          )
            throw new CloudError(
              'idempotency_conflict',
              'Image verifier bootstrap already describes a different intent.',
            );
        } else {
          const secret = input.seal.issue(JSON.stringify(spec));
          await tx.insert(imageVerifierBootstraps).values({
            buildId: input.buildId,
            snapshotId: snapshot.ref.id,
            spec,
            tokenHash: secret.hash,
            sealedToken: secret.sealed,
            expiresAt: new Date(spec.expiresAt),
          });
        }
        return imageVerifierReferenceSchema.parse({ version: 2, subject: spec.subject });
      });
    },
  });
}

export async function recoverImageVerifierBootstrap(
  db: Database,
  input: { buildId: ImageBuildId; seal: BootstrapSeal },
) {
  return db.transaction(async (tx) => {
    await requireActiveImageBuild(tx, input.buildId);
    const [row] = await tx
      .select()
      .from(imageVerifierBootstraps)
      .where(eq(imageVerifierBootstraps.buildId, input.buildId));
    if (
      !row ||
      row.consumedAt ||
      row.expiresAt.getTime() <= (await databaseTime(tx)).getTime() ||
      !row.sealedToken
    )
      throw new CloudError(
        'permission_denied',
        'Image verifier bootstrap is absent, consumed or expired.',
      );
    const spec = imageVerifierSpecSchema.parse(row.spec);
    if (
      spec.subject.id !== input.buildId ||
      spec.image.providerImage !== row.snapshotId ||
      spec.expiresAt !== row.expiresAt.toISOString()
    )
      throw new CloudError('internal_error', 'Image verifier bootstrap binding is inconsistent.');
    const token = input.seal.recover(row.sealedToken, JSON.stringify(spec));
    if (!input.seal.matches(token, row.tokenHash))
      throw new CloudError('internal_error', 'Image verifier token hash is inconsistent.');
    return { spec, token };
  });
}

/** The address and boot source come from current provider ownership, never enrollment input. */
export async function observeImageVerifier(build: ImageBuild, provider: ImageProvider) {
  const snapshot = verifierSnapshot(build);
  const verifier = confirmedImageResource(build, 'verifier');
  const ip = confirmedImageResource(build, 'verifier_ip');
  const reads = await Promise.all(
    [snapshot, verifier, ip].map(async (record) => {
      const resource = await provider.get(record.ref);
      if (
        !resource ||
        resource.kind !== record.ref.kind ||
        resource.id !== record.ref.id ||
        !matchesLabels(
          resource.labels,
          imageEffectLabels({
            buildId: build.admission.id,
            role: record.role,
            effectId: record.effectId,
          }),
        )
      )
        throw new CloudError(
          'provider_outcome_unknown',
          'Image verifier resource ownership changed.',
        );
      return resource;
    }),
  );
  const [source, server, address] = reads;
  if (
    !source ||
    !server ||
    !address ||
    source.kind !== 'snapshot' ||
    server.kind !== 'server' ||
    address.kind !== 'primary_ip' ||
    build.builderWork.kind !== 'recorded' ||
    source.sourceServerId !== build.builderWork.serverId ||
    source.status !== 'available' ||
    server.id === build.builderWork.serverId ||
    server.imageId !== source.id ||
    server.primaryIpId !== address.id ||
    server.ipv4 !== address.ipv4 ||
    address.serverId !== server.id ||
    address.autoDelete ||
    server.power !== 'running' ||
    server.region !== build.admission.offer.region ||
    address.region !== server.region ||
    server.serverType !== build.admission.offer.serverType ||
    server.architecture !== build.admission.offer.architecture ||
    server.diskGb !== build.admission.offer.diskGb ||
    source.architecture !== server.architecture ||
    source.diskGb !== server.diskGb
  )
    throw new CloudError(
      'provider_outcome_unknown',
      'Image verifier boot source or assigned address changed.',
    );
  return { server, address: address.ipv4, effectId: verifier.effectId, snapshotId: source.id };
}

import { imageSnapshotInUse } from './allocation-image.js';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  CloudError,
  imageBuildStateSchema,
  imageProviderCommandSchema,
  imageSubmissionSchema,
  imageRoleKind,
  imageActionTarget,
  imageEffectLabels,
  isImageCreate,
  type Catalog,
  type ImageBuildId,
  type ImageBuildLimits,
  type ImageProvider,
  type ImageProviderCommand,
  type ImageSubmission,
  type ImageBuildAdmission,
} from '@agent-cloud/contracts';
import {
  imageBuilds,
  imageBuildEffects,
  databaseTime,
  withImageBuildLock,
  type Connection,
  type Database,
} from '@agent-cloud/db';
import { inspectImageBuild, type ImageBuild } from './image-builds.js';
import { checkImagePrices, checkImageLimits, parseImageReservations } from './image-budget.js';
import { imageEffectKey, checkImageCommand } from './image-effect-policy.js';
import { claimImageResource, observeImageResource, imageCreateMatches } from './image-resources.js';
import { matchesLabels } from './resource-journal.js';

type Effect = ImageBuild['effects'][number];
type Resolution =
  | { kind: 'confirmed' }
  | { kind: 'failed'; reason: string }
  | { kind: 'retry'; reason: string }
  | { kind: 'pending'; reason: string };

async function settle(
  db: Database,
  effect: Effect,
  result: Extract<Resolution, { kind: 'confirmed' | 'failed' }>,
) {
  const resolution =
    result.kind === 'confirmed' ? { kind: 'confirmed', at: new Date().toISOString() } : result;
  await db.update(imageBuildEffects).set({ resolution }).where(eq(imageBuildEffects.id, effect.id));
  return result;
}

export async function reconcileImageEffect(
  db: Database,
  build: ImageBuild,
  effect: Effect,
  provider: ImageProvider,
): Promise<Resolution> {
  if (effect.resolution.kind === 'superseded')
    return { kind: 'pending', reason: 'A later exact-ID effect owns this retry.' };
  if (effect.resolution.kind !== 'pending') return effect.resolution;
  const { command, outcome } = effect;
  if (outcome.kind === 'rejected')
    return settle(db, effect, { kind: 'failed', reason: outcome.reason });
  if (isImageCreate(command)) {
    const kind = imageRoleKind(command.labels.role);
    if (outcome.kind === 'accepted' || outcome.kind === 'completed') {
      const receiptRecorded = build.resources.some(
        (resource) =>
          resource.effectId === effect.id &&
          resource.ref.kind === outcome.resource.kind &&
          resource.ref.id === outcome.resource.id,
      );
      if (!receiptRecorded) await claimImageResource(db, build, effect, outcome.resource);
      if (outcome.kind === 'accepted') {
        const action = await provider.getAction({
          actionId: outcome.actionId,
          resource: imageActionTarget(command, outcome.resource),
        });
        if (action.kind === 'running')
          return { kind: 'pending', reason: 'Provider action is running.' };
        if (action.kind === 'failed')
          return settle(db, effect, {
            kind: 'failed',
            reason: 'Provider create action failed; its resource still requires cleanup.',
          });
      }
    }
    // Search even after a receipt: never silently select one of several matching resources.
    const labels = imageEffectLabels({
      buildId: build.admission.id,
      role: command.labels.role,
      effectId: effect.id,
    });
    const found = await provider.find({ kind, labels });
    let mismatched = false;
    const candidates = new Map(found.map((resource) => [resource.id, resource]));
    const knownIds = new Set([
      ...candidates.keys(),
      ...build.resources
        .filter((resource) => resource.effectId === effect.id)
        .map((resource) => resource.ref.id),
    ]);
    for (const resource of candidates.values()) {
      if (resource.kind !== kind || !matchesLabels(resource.labels, labels)) {
        mismatched = true;
        continue;
      }
      try {
        await claimImageResource(db, build, effect, { kind, id: resource.id });
        await observeImageResource(db, build, { kind, id: resource.id }, resource);
      } catch (error) {
        if (!(error instanceof CloudError)) throw error;
        mismatched = true;
      }
    }
    if (mismatched)
      return { kind: 'pending', reason: 'Provider candidates disagree with recorded ownership.' };
    if (knownIds.size > 1 || candidates.size !== 1)
      return {
        kind: 'pending',
        reason:
          knownIds.size > 1
            ? 'Duplicate image resources require reconciliation.'
            : 'Provider create outcome remains unknown.',
      };
    const resource = candidates.values().next().value;
    if (
      !resource ||
      ((outcome.kind === 'accepted' || outcome.kind === 'completed') &&
        resource.id !== outcome.resource.id)
    )
      return { kind: 'pending', reason: 'Provider receipt and lookup disagree.' };
    if (!imageCreateMatches(build, effect, resource))
      return {
        kind: 'pending',
        reason: 'Image resource does not yet match its intended configuration.',
      };
    return settle(db, effect, { kind: 'confirmed' });
  }
  const ref =
    command.kind === 'delete'
      ? command.resource
      : ({ kind: 'server', id: command.serverId } satisfies { kind: 'server'; id: string });
  if (
    (outcome.kind === 'accepted' || outcome.kind === 'completed') &&
    (outcome.resource.id !== ref.id || outcome.resource.kind !== ref.kind)
  )
    return { kind: 'pending', reason: 'Provider receipt refers to another resource.' };
  let retry = outcome.kind === 'prepared' || outcome.kind === 'unknown';
  if (outcome.kind === 'accepted') {
    const action = await provider.getAction({
      actionId: outcome.actionId,
      resource: outcome.resource,
    });
    if (action.kind === 'running')
      return { kind: 'pending', reason: 'Provider action is running.' };
    if (action.kind === 'failed')
      return settle(db, effect, { kind: 'failed', reason: 'Provider action failed.' });
    retry = action.kind === 'missing';
  }
  const current = await provider.get(ref);
  await observeImageResource(db, build, ref, current);
  if (command.kind === 'power_off' && !current)
    return settle(db, effect, {
      kind: 'failed',
      reason: 'The builder was deleted before shutdown could be confirmed.',
    });
  if (
    (command.kind === 'delete' && !current) ||
    (command.kind === 'power_off' && current?.kind === 'server' && current.power === 'off')
  )
    return settle(db, effect, { kind: 'confirmed' });
  return retry
    ? {
        kind: 'retry',
        reason:
          'The owned target still needs this exact-ID operation and no action is known to be running.',
      }
    : { kind: 'pending', reason: 'Provider resource has not reached the requested state.' };
}

/** Only a newly committed effect can reach submit. Existing intents always reconcile. */
export async function runImageEffect(
  input: {
    connection: Connection;
    buildId: ImageBuildId;
    provider: ImageProvider;
  } & (
    | {
        command: ImageProviderCommand;
        limits: ImageBuildLimits;
        pricing: () => Promise<{
          catalog: Catalog;
          storagePrice: ImageBuildAdmission['storagePrice'];
        }>;
      }
    | { command: Extract<ImageProviderCommand, { kind: 'delete' }> }
  ),
) {
  return withImageBuildLock({
    pool: input.connection.pool,
    buildId: input.buildId,
    work: async (db) => {
      const command = imageProviderCommandSchema.parse(input.command);
      const build = await inspectImageBuild(db, input.buildId);
      const baseKey = imageEffectKey(command);
      const previous = build.effects.filter(
        (effect) =>
          effect.key === baseKey ||
          (!isImageCreate(command) && effect.key.startsWith(baseKey + ':')),
      );
      const last = previous.at(-1);
      let supersede: Effect | null = null;
      if (last) {
        if (JSON.stringify(last.command) !== JSON.stringify(command))
          throw new CloudError(
            'idempotency_conflict',
            'Image effect identity already describes a different command.',
          );
        const resolution = await reconcileImageEffect(db, build, last, input.provider);
        const retry =
          !isImageCreate(command) && (resolution.kind === 'failed' || resolution.kind === 'retry');
        if (!retry) return resolution;
        if (resolution.kind === 'retry') supersede = last;
      }
      if (build.state.kind === 'cleaned') return { kind: 'confirmed' } satisfies Resolution;
      if (
        command.kind !== 'delete' &&
        (build.state.kind !== 'running' ||
          Date.parse(build.admission.deadlineAt) <= (await databaseTime(db)).getTime())
      )
        throw new CloudError('provider_rejected', 'The image build is expired or cleaning.');
      if (
        command.kind === 'delete' &&
        build.state.kind !== 'cleaning' &&
        build.state.kind !== 'releasing'
      )
        throw new CloudError(
          'permission_denied',
          'Request image cleanup before deleting its resources.',
        );
      if (
        command.kind !== 'delete' &&
        build.effects.some(
          (effect) => effect.resolution.kind === 'pending' && effect.id !== last?.id,
        )
      )
        throw new CloudError(
          'provider_outcome_unknown',
          'Reconcile pending image effects before starting another.',
        );
      if (
        command.kind === 'delete' &&
        command.resource.kind === 'snapshot' &&
        (await imageSnapshotInUse(db, input.buildId))
      )
        throw new CloudError(
          'provider_outcome_unknown',
          'Snapshot is pinned by an unsettled customer create.',
        );
      await checkImageCommand(build, command, input.provider, (await databaseTime(db)).getTime());
      if (isImageCreate(command) && !('pricing' in input))
        throw new CloudError('permission_denied', 'Cleanup cannot create provider resources.');
      const prices = isImageCreate(command) && 'pricing' in input ? await input.pricing() : null;
      const id = randomUUID();
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(78131026)`);
        const [row] = await tx
          .select()
          .from(imageBuilds)
          .where(eq(imageBuilds.id, input.buildId))
          .for('update');
        if (!row) throw new CloudError('not_found', 'Image build not found.');
        const state = imageBuildStateSchema.parse(row.state);
        const now = (await databaseTime(tx)).getTime();
        if (
          state.kind === 'cleaned' ||
          (command.kind !== 'delete' &&
            (state.kind !== 'running' || Date.parse(build.admission.deadlineAt) <= now))
        )
          throw new CloudError('provider_rejected', 'Image build no longer permits this effect.');
        if (prices && 'limits' in input) {
          checkImagePrices({ admission: build.admission, ...prices, now });
          const open = await tx
            .select()
            .from(imageBuilds)
            .where(sql`${imageBuilds.state}->>'kind' <> 'cleaned'`);
          checkImageLimits(parseImageReservations(open), input.limits);
        }
        await tx.insert(imageBuildEffects).values({
          id,
          buildId: input.buildId,
          effectKey: !isImageCreate(command) ? `${baseKey}:${previous.length + 1}` : baseKey,
          command,
        });
        if (supersede)
          await tx
            .update(imageBuildEffects)
            .set({ resolution: { kind: 'superseded', byEffectId: id } })
            .where(eq(imageBuildEffects.id, supersede.id));
      });
      let outcome: ImageSubmission;
      try {
        outcome = imageSubmissionSchema.parse(
          await input.provider.submit({ effectId: id, command }),
        );
      } catch {
        outcome = {
          kind: 'unknown',
          reason: 'Provider submission ended without a definitive response.',
        };
      }
      await db.update(imageBuildEffects).set({ outcome }).where(eq(imageBuildEffects.id, id));
      const updated = await inspectImageBuild(db, input.buildId);
      const effect = updated.effects.find((effect) => effect.id === id);
      if (!effect)
        throw new CloudError('internal_error', 'Image effect disappeared after submission.');
      return reconcileImageEffect(db, updated, effect, input.provider);
    },
  });
}

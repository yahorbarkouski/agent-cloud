import { CloudError } from '@agent-cloud/contracts';
import { imageSnapshotInUse } from './allocation-image.js';
import { eq } from 'drizzle-orm';
import { imageBuilds, withImageBuildLock, type Connection } from '@agent-cloud/db';
import {
  imageActionTarget,
  type ImageBuildId,
  type ImageProvider,
  type ImageProviderCommand,
} from '@agent-cloud/contracts';
import { inspectImageBuild, requestImageCleanup } from './image-builds.js';
import { reconcileImageEffect } from './image-effect-journal.js';
import { observeImageResource } from './image-resources.js';

/** Reconcile first, then return one owned deletion. This function never creates capacity. */
export async function planImageCleanup(input: {
  connection: Connection;
  buildId: ImageBuildId;
  provider: ImageProvider;
  intent?: 'abort' | 'release';
}) {
  return withImageBuildLock({
    pool: input.connection.pool,
    buildId: input.buildId,
    work: async (db) => {
      if (input.intent !== 'release') await requestImageCleanup(db, input.buildId);
      let build = await inspectImageBuild(db, input.buildId);
      if (input.intent === 'release' && build.state.kind !== 'releasing')
        throw new CloudError(
          'permission_denied',
          'Retained cleanup requires an active publication intent.',
        );
      if (build.state.kind === 'cleaned') return { kind: 'cleaned' } satisfies { kind: 'cleaned' };
      for (const effect of build.effects) {
        if (effect.resolution.kind === 'pending')
          await reconcileImageEffect(db, build, effect, input.provider);
      }
      build = await inspectImageBuild(db, input.buildId);
      for (const resource of build.resources) {
        if (resource.state.kind === 'absent') continue;
        const current = await input.provider.get(resource.ref);
        // An in-flight create can appear later. A 404 alone cannot retire its receipt.
        const effect = build.effects.find((effect) => effect.id === resource.effectId);
        if (current || effect?.resolution.kind !== 'pending')
          await observeImageResource(db, build, resource.ref, current);
      }
      build = await inspectImageBuild(db, input.buildId);
      const pending = build.effects.filter((effect) => effect.resolution.kind === 'pending');
      const runningCreates = new Set<string>();
      for (const effect of pending) {
        if (
          effect.outcome.kind === 'accepted' &&
          (
            await input.provider.getAction({
              actionId: effect.outcome.actionId,
              resource: imageActionTarget(effect.command, effect.outcome.resource),
            })
          ).kind === 'running'
        )
          runningCreates.add(effect.id);
      }
      const waiting = () =>
        ({ kind: 'waiting', effects: pending.map((effect) => effect.id) }) satisfies {
          kind: 'waiting';
          effects: string[];
        };
      const deleting = pending.find((effect) => effect.command.kind === 'delete');
      if (deleting?.command.kind === 'delete')
        return { kind: 'delete', command: deleting.command } satisfies {
          kind: 'delete';
          command: ImageProviderCommand;
        };
      // Server attachments must disappear before deleting their IP, firewall or access key.
      const order = ['server', 'snapshot', 'primary_ip', 'firewall', 'ssh_key'];
      const retaining = build.state.kind === 'releasing';
      const pinned = await imageSnapshotInUse(db, input.buildId);
      const remaining = build.resources.filter(
        (resource) =>
          resource.state.kind !== 'absent' && !(retaining && resource.role === 'snapshot'),
      );
      const next = remaining
        .filter((resource) => {
          const creator = pending.find((effect) => effect.id === resource.effectId);
          if (resource.role === 'snapshot' && pinned) return false;
          if ((creator && runningCreates.has(creator.id)) || resource.state.kind !== 'observed')
            return false;
          if (
            resource.ref.kind !== 'server' &&
            pending.some((effect) => effect.command.kind === 'create_server')
          )
            return false;
          if (
            resource.role === 'builder' &&
            pending.some((effect) => effect.command.kind === 'create_snapshot')
          )
            return false;
          return true;
        })
        .sort((a, b) => order.indexOf(a.ref.kind) - order.indexOf(b.ref.kind))[0];
      if (next)
        return { kind: 'delete', command: { kind: 'delete', resource: next.ref } } satisfies {
          kind: 'delete';
          command: ImageProviderCommand;
        };
      if (pending.length) return waiting();
      if (remaining.length)
        return {
          kind: 'waiting',
          effects: remaining.map((resource) => resource.effectId),
        } satisfies { kind: 'waiting'; effects: string[] };
      if (retaining) return { kind: 'ready_to_publish' } satisfies { kind: 'ready_to_publish' };
      await db
        .update(imageBuilds)
        .set({ state: { kind: 'cleaned', at: new Date().toISOString() } })
        .where(eq(imageBuilds.id, input.buildId));
      return { kind: 'cleaned' } satisfies { kind: 'cleaned' };
    },
  });
}

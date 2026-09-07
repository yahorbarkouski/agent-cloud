import type { ImageBuildId, ImageBuildLimits, ImageProvider } from '@agent-cloud/contracts';
import type { Connection } from '@agent-cloud/db';
import { inspectImageBuild, requestImageCleanup } from './image-builds.js';
import { runImageEffect } from './image-effect-journal.js';
import { runImageBuilderWork } from './image-builder-work.js';
import { planImageCleanup } from './image-cleanup.js';
import { planImageRelease } from './image-release-plan.js';

type Advance =
  | { kind: 'provider'; result: Awaited<ReturnType<typeof runImageEffect>> }
  | { kind: 'builder'; result: Awaited<ReturnType<typeof runImageBuilderWork>> }
  | { kind: 'verification_required'; snapshotId: string }
  | { kind: 'busy' }
  | { kind: 'waiting'; effects: string[] }
  | { kind: 'cleaned' };

/** One recoverable controller pass. Live CLI activation still requires the verifier lifecycle. */
export async function advanceImageBuild(input: {
  connection: Connection;
  buildId: ImageBuildId;
  provider: ImageProvider;
  limits: ImageBuildLimits;
  pricing: Parameters<typeof runImageEffect>[0]['pricing'];
  access: Parameters<typeof runImageBuilderWork>[0]['access'];
  remote: Parameters<typeof runImageBuilderWork>[0]['remote'];
  sourceDirectory: string;
}): Promise<Advance> {
  const build = await inspectImageBuild(input.connection.db, input.buildId);
  const plan = planImageRelease(build);
  switch (plan.kind) {
    case 'effect':
      return {
        kind: 'provider',
        result: await runImageEffect({ ...input, command: plan.command }),
      };
    case 'builder':
      return { kind: 'builder', result: await runImageBuilderWork(input) };
    case 'verification_required':
      return plan;
    case 'cleanup': {
      await requestImageCleanup(input.connection.db, input.buildId, plan.reason);
      const cleanup = await planImageCleanup(input);
      if (cleanup.kind === 'busy') return cleanup;
      if (cleanup.value.kind === 'delete')
        return {
          kind: 'provider',
          result: await runImageEffect({ ...input, command: cleanup.value.command }),
        };
      if (cleanup.value.kind === 'waiting') return cleanup.value;
      await input.access.remove(build.admission);
      return { kind: 'cleaned' };
    }
    case 'cleaned':
      await input.access.remove(build.admission);
      return { kind: 'cleaned' };
    default: {
      const exhaustive: never = plan;
      return exhaustive;
    }
  }
}

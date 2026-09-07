import type {
  SignedImageRelease,
  ImageBuildId,
  ImageBuildLimits,
  ImageProvider,
} from '@agent-cloud/contracts';
import { imageBuilds, type Connection } from '@agent-cloud/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { inspectImageBuild, requestImageCleanup, type ImageBuild } from './image-builds.js';
import { runImageEffect } from './image-effect-journal.js';
import { runImageBuilderWork } from './image-builder-work.js';
import { planImageCleanup } from './image-cleanup.js';
import { planImageRelease } from './image-release-plan.js';
import { prepareImageVerification } from './image-verifier.js';
import type { BootstrapSeal } from './bootstrap-seal.js';
import type { createImageVerifierRuntime } from './image-verifier-runtime.js';

import {
  prepareImagePublication,
  publishImageRelease,
  readPublishedImage,
  type ImagePublicationSigner,
} from './image-publication.js';

type Advance =
  | { kind: 'provider'; result: Awaited<ReturnType<typeof runImageEffect>> }
  | { kind: 'builder'; result: Awaited<ReturnType<typeof runImageBuilderWork>> }
  | { kind: 'verification_required'; snapshotId: string }
  | { kind: 'verifier_prepared'; result: Awaited<ReturnType<typeof prepareImageVerification>> }
  | {
      kind: 'verifier';
      result: Awaited<ReturnType<ReturnType<typeof createImageVerifierRuntime>['check']>>;
    }
  | { kind: 'verified' }
  | { kind: 'publication_prepared'; result: Awaited<ReturnType<typeof prepareImagePublication>> }
  | { kind: 'retained'; release: SignedImageRelease }
  | { kind: 'busy' }
  | { kind: 'waiting'; effects: string[] }
  | { kind: 'cleaned' };

export async function completeImageAccessCleanup(
  input: { connection: Connection; access: Parameters<typeof runImageBuilderWork>[0]['access'] },
  build: ImageBuild,
) {
  if (build.accessRemovedAt) return;
  await input.access.remove(build.admission);
  await input.connection.db
    .update(imageBuilds)
    .set({ accessRemovedAt: sql`clock_timestamp()` })
    .where(and(eq(imageBuilds.id, build.admission.id), isNull(imageBuilds.accessRemovedAt)));
}

/** One recoverable controller pass. Live CLI activation still requires production recovery and bounded provider proof. */
export async function advanceImageBuild(input: {
  connection: Connection;
  buildId: ImageBuildId;
  provider: ImageProvider;
  limits: ImageBuildLimits;
  pricing: Parameters<typeof runImageEffect>[0]['pricing'];
  access: Parameters<typeof runImageBuilderWork>[0]['access'];
  remote: Parameters<typeof runImageBuilderWork>[0]['remote'];
  sourceDirectory: string;
  publication?: ImagePublicationSigner;
  verification?: {
    seal: BootstrapSeal;
    enrollmentUrl: string;
    runtime: ReturnType<typeof createImageVerifierRuntime>;
  };
}): Promise<Advance> {
  const build = await inspectImageBuild(input.connection.db, input.buildId);
  const plan = planImageRelease(
    build,
    Date.now(),
    input.verification !== undefined,
    input.publication !== undefined,
  );
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
    case 'verifier_prepare':
      if (!input.verification) throw new Error('Verifier plan requires configured ports.');
      return {
        kind: 'verifier_prepared',
        result: await prepareImageVerification({ ...input, ...input.verification }),
      };
    case 'verifier_check':
      if (!input.verification) throw new Error('Verifier plan requires configured ports.');
      return { kind: 'verifier', result: await input.verification.runtime.check(input.buildId) };
    case 'verified':
      return plan;
    case 'publication_prepare':
      return { kind: 'publication_prepared', result: await prepareImagePublication(input) };
    case 'retained': {
      await completeImageAccessCleanup(input, build);
      if (!input.publication)
        throw new Error('Returning a release requires its verification key policy.');
      const selected = await readPublishedImage({ ...input, keys: input.publication.keys });
      if (selected.kind === 'busy') return selected;
      return { kind: 'retained', release: selected.value.release };
    }
    case 'release_cleanup': {
      const cleanup = await planImageCleanup({ ...input, intent: 'release' });
      if (cleanup.kind === 'busy') return cleanup;
      if (cleanup.value.kind === 'delete')
        return {
          kind: 'provider',
          result: await runImageEffect({ ...input, command: cleanup.value.command }),
        };
      if (cleanup.value.kind === 'waiting') return cleanup.value;
      if (cleanup.value.kind !== 'ready_to_publish' || !input.publication)
        throw new Error('Publication requires its configured signer after retained cleanup.');
      await completeImageAccessCleanup(input, build);
      const published = await publishImageRelease({ ...input, ...input.publication });
      if (published.kind === 'busy') return published;
      return { kind: 'retained', release: published.value };
    }
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
      if (cleanup.value.kind !== 'cleaned')
        throw new Error('Full abort must remove every resource.');
      await completeImageAccessCleanup(input, build);
      return { kind: 'cleaned' };
    }
    case 'cleaned':
      await completeImageAccessCleanup(input, build);
      return { kind: 'cleaned' };
    default: {
      const exhaustive: never = plan;
      return exhaustive;
    }
  }
}

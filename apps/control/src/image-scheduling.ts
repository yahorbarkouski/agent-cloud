import { eq, sql } from 'drizzle-orm';
import {
  CloudError,
  imageBuildAdmissionSchema,
  imageBuildStateSchema,
  type ImageBuildId,
} from '@agent-cloud/contracts';
import { imageBuilds, type Executor, type Database } from '@agent-cloud/db';

export async function enqueueImageBuild(db: Executor, buildId: string, runAt = new Date()) {
  await db.execute(sql`SELECT graphile_worker.add_job(
    'advance_image_build', ${JSON.stringify({ buildId })}::json,
    max_attempts := 25, job_key := ${'image:' + buildId}, run_at := ${runAt.toISOString()}::timestamptz
  )`);
}

/** Explicitly opt an admitted build into provider work. A repeated request preserves the first intent. */
export async function requestImageRun(db: Database, buildId: ImageBuildId) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(imageBuilds)
      .where(eq(imageBuilds.id, buildId))
      .for('update');
    if (!row) throw new CloudError('not_found', 'Image build not found.');
    const state = imageBuildStateSchema.parse(row.state);
    if (
      !row.runRequestedAt &&
      (state.kind !== 'running' ||
        Date.parse(imageBuildAdmissionSchema.parse(row.admission).deadlineAt) <= Date.now())
    )
      throw new CloudError('permission_denied', 'Only an active admitted build can be started.');
    if (!row.runRequestedAt)
      await tx
        .update(imageBuilds)
        .set({ runRequestedAt: sql`clock_timestamp()` })
        .where(eq(imageBuilds.id, buildId));
    await enqueueImageBuild(tx, buildId);
  });
}

/** Read and enqueue under the same row lock used by cancel/start, so a stale timer cannot erase cancellation. */
export async function scheduleImageBuild(db: Database, buildId: ImageBuildId, delayMs = 1000) {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(imageBuilds)
      .where(eq(imageBuilds.id, buildId))
      .for('update');
    if (!row) return;
    const state = imageBuildStateSchema.parse(row.state);
    const admission = imageBuildAdmissionSchema.parse(row.admission);
    if (state.kind === 'cleaned' && row.accessRemovedAt) return;
    let runAt = Date.now() + delayMs;
    if (state.kind === 'retained' && admission.retention.kind === 'retain')
      runAt = Math.max(runAt, Date.parse(admission.retention.deleteAfter));
    else if (state.kind === 'running')
      runAt = row.runRequestedAt
        ? Math.min(runAt, Date.parse(admission.deadlineAt))
        : Date.parse(admission.deadlineAt);
    await enqueueImageBuild(tx, buildId, new Date(runAt));
  });
}

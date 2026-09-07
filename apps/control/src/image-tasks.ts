import { eq, sql } from 'drizzle-orm';
import type { TaskList } from 'graphile-worker';
import { z } from 'zod';
import { CloudError, imageBuildIdSchema } from '@agent-cloud/contracts';
import { imageBuilds, type Connection } from '@agent-cloud/db';
import { advanceImageBuild } from './advance-image-build.js';
import { inspectImageBuild, type ImageBuild } from './image-builds.js';
import { scheduleImageBuild } from './image-scheduling.js';

const payloadSchema = z.strictObject({ buildId: imageBuildIdSchema });
type Controller = Omit<Parameters<typeof advanceImageBuild>[0], 'connection' | 'buildId'>;

/** Uses the real controller and journal. Infrastructure ports are supplied by the operator worker. */
export function createImageTasks(input: {
  connection: Connection;
  controller: (build: ImageBuild) => Controller;
}): TaskList {
  return {
    advance_image_build: async (payload) => {
      const { buildId } = payloadSchema.parse(payload);
      const [row] = await input.connection.db
        .select({ id: imageBuilds.id })
        .from(imageBuilds)
        .where(eq(imageBuilds.id, buildId));
      if (!row) return;
      const build = await inspectImageBuild(input.connection.db, buildId);
      if (build.state.kind === 'cleaned' && build.accessRemovedAt) return;
      if (
        build.state.kind === 'running' &&
        !build.runRequestedAt &&
        Date.parse(build.admission.deadlineAt) > Date.now()
      ) {
        await scheduleImageBuild(input.connection.db, buildId);
        return;
      }
      let delay = 1000;
      try {
        await advanceImageBuild({
          ...input.controller(build),
          connection: input.connection,
          buildId,
        });
      } catch (error) {
        if (!(error instanceof CloudError)) throw error;
        // The original state/effects remain authoritative; expected provider failures retry slowly.
        delay = 30_000;
      }
      await scheduleImageBuild(input.connection.db, buildId, delay);
    },
    reconcile_image_builds: async () => {
      const rows = await input.connection.db.select({ id: imageBuilds.id }).from(imageBuilds)
        .where(sql`
        ${imageBuilds.state}->>'kind'<>'cleaned' OR ${imageBuilds.accessRemovedAt} IS NULL`);
      for (const row of rows)
        await scheduleImageBuild(input.connection.db, imageBuildIdSchema.parse(row.id));
    },
  };
}

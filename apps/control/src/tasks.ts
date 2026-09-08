import { z } from 'zod';
import type { HostingService } from './hosting.js';
import { enqueueBackup, type BackupService } from './backups.js';
import type { Config } from './config.js';
import { eq, sql } from 'drizzle-orm';
import type { TaskList, JobHelpers } from 'graphile-worker';
import {
  operationIdSchema,
  accessSessionIdSchema,
  isOperationTerminal,
  type MachineProvider,
} from '@agent-cloud/contracts';
import {
  operations,
  operationRecord,
  enqueueOperation,
  databaseTime,
  accessSessions,
  type Connection,
} from '@agent-cloud/db';
import { createImageTasks } from './image-tasks.js';
import { advanceOperation, type GuestProvisioning } from './advance-operation.js';
import type { AccessService } from './access-sessions.js';

const payloadSchema = z.object({ operationId: operationIdSchema });

export function createTasks(input: {
  connection: Connection;
  provider: MachineProvider;
  limits: Config['limits'];
  guest?: GuestProvisioning;
  images?: Parameters<typeof createImageTasks>[0]['advance'];
  access?: AccessService;
  hosting?: HostingService;
  backups?: BackupService;
}): TaskList {
  return {
    ...(input.backups
      ? {
          advance_backup: async (payload: unknown, helpers: JobHelpers) => {
            const request = z
              .strictObject({ kind: z.enum(['backup', 'restore']), id: z.uuidv4() })
              .parse(payload);
            await input.backups?.advance(request.kind, request.id);
            const pending = await input.connection.db.execute<{ pending: boolean }>(
              request.kind === 'backup'
                ? sql`SELECT record->'state'->>'kind' = 'pending' OR (work->>'kind' = 'stored' AND work->>'guestCleanup' = 'pending' AND (work->>'attempts')::int < 5) AS pending FROM backups WHERE id = ${request.id}`
                : sql`SELECT record->'state'->>'kind' = 'pending' AS pending FROM backup_restores WHERE id = ${request.id}`,
            );
            if (pending.rows[0]?.pending)
              await helpers.addJob('advance_backup', request, {
                jobKey: `${request.kind}:${request.id}`,
                runAt: new Date((await databaseTime(input.connection.db)).getTime() + 1000),
              });
          },
        }
      : {}),
    ...(input.hosting
      ? {
          apply_hosting_route: async (payload: unknown) => {
            await input.hosting?.advance(
              z.object({ hostname: z.string() }).parse(payload).hostname,
            );
          },
        }
      : {}),
    ...(input.access
      ? {
          issue_access_session: async (payload: unknown, helpers: JobHelpers) => {
            const { sessionId } = z.object({ sessionId: accessSessionIdSchema }).parse(payload);
            await input.access?.issue(sessionId);
            const [row] = await input.connection.db
              .select({ issuance: accessSessions.issuance })
              .from(accessSessions)
              .where(eq(accessSessions.id, sessionId));
            if (
              row &&
              ['pending', 'attempted'].includes(
                z.object({ kind: z.string() }).parse(row.issuance).kind,
              )
            )
              await helpers.addJob(
                'issue_access_session',
                { sessionId },
                {
                  jobKey: sessionId,
                  runAt: new Date((await databaseTime(input.connection.db)).getTime() + 1000),
                },
              );
          },
        }
      : {}),
    ...(input.images
      ? createImageTasks({ connection: input.connection, advance: input.images })
      : {}),
    advance_operation: async (payload, helpers) => {
      const { operationId } = payloadSchema.parse(payload);
      await advanceOperation({ ...input, operationId });
      const [row] = await input.connection.db
        .select()
        .from(operations)
        .where(eq(operations.id, operationId));
      if (!row) return;
      const operation = operationRecord(row);
      if (isOperationTerminal(operation)) return;
      const delay = operation.progress.kind === 'blocked' ? 30_000 : 1_000;
      await helpers.addJob(
        'advance_operation',
        { operationId },
        {
          jobKey: operationId,
          runAt: new Date((await databaseTime(input.connection.db)).getTime() + delay),
        },
      );
    },
    reconcile_operations: async () => {
      if (input.backups) {
        await input.backups.schedules.reconcile();
        const pending = await input.connection.db.execute<{
          kind: 'backup' | 'restore';
          id: string;
        }>(sql`
          SELECT 'backup' AS kind, id FROM backups WHERE record->'state'->>'kind' = 'pending'
            OR (work->>'kind' = 'stored' AND work->>'guestCleanup' = 'pending' AND (work->>'attempts')::int < 5)
          UNION ALL SELECT 'restore' AS kind, id FROM backup_restores WHERE record->'state'->>'kind' = 'pending' LIMIT 1000`);
        for (const row of pending.rows) await enqueueBackup(input.connection.db, row.kind, row.id);
      }
      if (input.hosting) {
        const routes = await input.connection.db.execute<{ hostname: string }>(
          sql`SELECT hostname FROM hosting_routes WHERE record->'application'->>'kind' = 'pending' LIMIT 1000`,
        );
        for (const row of routes.rows)
          await input.connection.db.execute(
            sql`SELECT graphile_worker.add_job('apply_hosting_route', ${JSON.stringify({ hostname: row.hostname })}::json, job_key := ${`hosting:${row.hostname}`}, max_attempts := 10)`,
          );
      }
      if (input.access) {
        const pendingAccess = await input.connection.db
          .select({ id: accessSessions.id })
          .from(accessSessions)
          .where(sql`${accessSessions.issuance}->>'kind' IN ('pending','attempted')`)
          .limit(1000);
        for (const row of pendingAccess) await input.access.enqueue(input.connection.db, row.id);
      }
      const pending = await input.connection.db
        .select({ id: operations.id })
        .from(operations)
        .where(sql`${operations.progress}->>'kind' NOT IN ('succeeded', 'failed', 'cancelled')`);
      for (const row of pending) await enqueueOperation(input.connection.db, row.id);
    },
  };
}

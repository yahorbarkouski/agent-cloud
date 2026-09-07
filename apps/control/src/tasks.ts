import { z } from 'zod';
import type { Config } from './config.js';
import { eq, sql } from 'drizzle-orm';
import type { TaskList } from 'graphile-worker';
import {
  operationIdSchema,
  isOperationTerminal,
  type MachineProvider,
} from '@agent-cloud/contracts';
import {
  operations,
  operationRecord,
  enqueueOperation,
  databaseTime,
  type Connection,
} from '@agent-cloud/db';
import { createImageTasks } from './image-tasks.js';
import { advanceOperation, type GuestProvisioning } from './advance-operation.js';

const payloadSchema = z.object({ operationId: operationIdSchema });

export function createTasks(input: {
  connection: Connection;
  provider: MachineProvider;
  limits: Config['limits'];
  guest?: GuestProvisioning;
  images?: Parameters<typeof createImageTasks>[0]['advance'];
}): TaskList {
  return {
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
      const pending = await input.connection.db
        .select({ id: operations.id })
        .from(operations)
        .where(sql`${operations.progress}->>'kind' NOT IN ('succeeded', 'failed')`);
      for (const row of pending) await enqueueOperation(input.connection.db, row.id);
    },
  };
}

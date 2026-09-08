import { run } from 'graphile-worker';
import { simulatedCatalog } from '@agent-cloud/contracts';
import { connect } from '@agent-cloud/db';
import { readConfig } from './config.js';
import { SimulatedProvider } from './simulated-provider.js';
import { createTasks } from './tasks.js';
import { createImageTasks } from './image-tasks.js';
import { createOperatorRuntime } from './operator-runtime.js';
import { openControlFence } from './control-fence.js';
import { createWorkerLogger } from './worker-logger.js';

const config = readConfig();
const connection = connect(config.databaseUrl);
const fence = await openControlFence(connection, config.controlGenerationFile, {
  onLost: () => process.exit(1),
});
const runtime =
  config.provider === 'hetzner' ? await createOperatorRuntime(connection, config) : undefined;
const taskList =
  runtime?.mode === 'image_factory'
    ? createImageTasks({ connection, advance: (build) => runtime.advance(build.admission.id) })
    : createTasks({
        connection,
        limits: config.limits,
        provider:
          runtime?.mode === 'customer'
            ? runtime.provider
            : new SimulatedProvider({
                db: connection.db,
                catalog: () => simulatedCatalog(config.limits.currency),
              }),
        ...(runtime?.mode === 'customer'
          ? {
              guest: runtime.guest,
              ...(runtime.access ? { access: runtime.access } : {}),
              ...(runtime.hosting ? { hosting: runtime.hosting.service } : {}),
              ...(runtime.backups ? { backups: runtime.backups.service } : {}),
            }
          : {}),
      });
for (const [name, task] of Object.entries(taskList)) {
  if (task)
    taskList[name] = async (payload, helpers) => {
      await fence?.check();
      return task(payload, helpers);
    };
}
const runner = await run({
  logger: createWorkerLogger(),
  pgPool: connection.pool,
  concurrency: 4,
  pollInterval: 1_000,
  taskList,
  crontab:
    runtime?.mode === 'image_factory'
      ? '* * * * * reconcile_image_builds'
      : '* * * * * reconcile_operations',
});
process.stdout.write(
  JSON.stringify({
    event: 'worker.started',
    provider: config.provider,
    mode: runtime?.mode ?? 'simulated',
  }) + '\n',
);
try {
  await runner.promise;
} finally {
  await fence?.close();
  await connection.pool.end();
}

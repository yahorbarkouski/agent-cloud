import { run } from 'graphile-worker';
import { simulatedCatalog } from '@agent-cloud/contracts';
import { connect } from '@agent-cloud/db';
import { readConfig } from './config.js';
import { SimulatedProvider } from './simulated-provider.js';
import { createTasks } from './tasks.js';
import { createImageTasks } from './image-tasks.js';
import { createOperatorRuntime } from './operator-runtime.js';

const config = readConfig();
const connection = connect(config.databaseUrl);
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
          ? { guest: runtime.guest, ...(runtime.access ? { access: runtime.access } : {}) }
          : {}),
      });
const runner = await run({
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
  await connection.pool.end();
}

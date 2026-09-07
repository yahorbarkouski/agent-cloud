import { run } from 'graphile-worker';
import { simulatedCatalog } from '@agent-cloud/contracts';
import { connect } from '@agent-cloud/db';
import { readConfig } from './config.js';
import { SimulatedProvider } from './simulated-provider.js';
import { createTasks } from './tasks.js';
import { createImageTasks } from './image-tasks.js';
import { createImageRuntime } from './image-runtime.js';
import { readRuntimeConfig } from './runtime-config.js';

const config = readConfig();
const connection = connect(config.databaseUrl);
const images =
  config.provider === 'hetzner'
    ? await createImageRuntime({
        connection,
        config,
        runtime: await readRuntimeConfig(config.runtimeConfigFile),
      })
    : undefined;
const taskList = images
  ? createImageTasks({ connection, advance: (build) => images.advance(build.admission.id) })
  : createTasks({
      connection,
      limits: config.limits,
      provider: new SimulatedProvider({
        db: connection.db,
        catalog: () => simulatedCatalog(config.limits.currency),
      }),
    });
const runner = await run({
  pgPool: connection.pool,
  concurrency: 4,
  pollInterval: 1_000,
  taskList,
  crontab: images ? '* * * * * reconcile_image_builds' : '* * * * * reconcile_operations',
});
process.stdout.write(
  JSON.stringify({
    event: 'worker.started',
    provider: config.provider,
    mode: images ? 'image_factory' : 'simulated',
  }) + '\n',
);
try {
  await runner.promise;
} finally {
  await connection.pool.end();
}

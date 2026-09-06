import { run } from 'graphile-worker';
import { connect } from '@agent-cloud/db';
import { readConfig } from './config.js';
import { SimulatedProvider } from './simulated-provider.js';
import { createTasks } from './tasks.js';

const config = readConfig();
if (config.provider !== 'simulated') {
  throw new Error(
    'Live worker activation requires the verified guest template and provider credentials. Use PROVIDER=simulated during local development.',
  );
}
const connection = connect(config.databaseUrl);
const provider = new SimulatedProvider({ db: connection.db });
const runner = await run({
  pgPool: connection.pool,
  concurrency: 4,
  pollInterval: 1_000,
  taskList: createTasks({ connection, provider }),
  crontab: '* * * * * reconcile_operations',
});
process.stdout.write(JSON.stringify({ event: 'worker.started', provider: provider.kind }) + '\n');
try {
  await runner.promise;
} finally {
  await connection.pool.end();
}

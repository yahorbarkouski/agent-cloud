import { serve } from '@hono/node-server';
import { simulatedCatalog } from '@agent-cloud/contracts';
import { connect } from '@agent-cloud/db';
import { createApp } from './app.js';
import { readConfig } from './config.js';

const config = readConfig();
if (config.provider !== 'simulated') {
  throw new Error(
    'Live admission is not enabled until guest verification, current pricing, and IP cleanup are wired.',
  );
}
const connection = connect(config.databaseUrl);
const app = createApp({
  db: connection.db,
  provider: config.provider,
  limits: config.limits,
  catalog: () => simulatedCatalog(config.limits.currency),
});
const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
  process.stdout.write(
    JSON.stringify({
      event: 'api.listening',
      host: config.host,
      port: config.port,
      provider: config.provider,
    }) + '\n',
  );
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close(() => {
      void connection.pool.end();
    });
  });
}

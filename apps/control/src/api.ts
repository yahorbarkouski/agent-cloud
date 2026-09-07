import { serve } from '@hono/node-server';
import { connect } from '@agent-cloud/db';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { createCatalogRuntime } from './catalog-runtime.js';
import { readRuntimeConfig } from './runtime-config.js';
import { createImageRuntime } from './image-runtime.js';

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
if (images) await images.checkConfiguration();
const onCatalogFailure = () => {
  process.stderr.write(JSON.stringify({ event: 'catalog.refresh_failed' }) + '\n');
};
const catalog = createCatalogRuntime(config, onCatalogFailure);
await catalog.refresh().catch(onCatalogFailure);
catalog.start();
const app = createApp({
  db: connection.db,
  provider: config.provider,
  limits: config.limits,
  catalog: catalog.snapshot,
  ...(images ? { imageEnrollment: images.enrollment, customerAccess: 'disabled' } : {}),
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
    catalog.stop();
    server.close(() => {
      void connection.pool.end();
    });
  });
}

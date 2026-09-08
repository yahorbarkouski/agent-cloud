import { readPrivateFile } from './private-file.js';
import { serve } from '@hono/node-server';
import { connect } from '@agent-cloud/db';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { createCatalogRuntime } from './catalog-runtime.js';
import { createOperatorRuntime } from './operator-runtime.js';
import { createCustomerLogin } from './customer-login.js';
import { readGithubConfig, githubIdentityVerifier } from './github-identity.js';
import { openControlFence } from './control-fence.js';

const config = readConfig();
const connection = connect(config.databaseUrl);
const fence = await openControlFence(connection, config.controlGenerationFile, {
  onLost: () => process.exit(1),
});
const runtime =
  config.provider === 'hetzner' ? await createOperatorRuntime(connection, config) : undefined;
if (runtime?.mode === 'image_factory') await runtime.checkConfiguration();
const onCatalogFailure = () => {
  process.stderr.write(JSON.stringify({ event: 'catalog.refresh_failed' }) + '\n');
};
const catalog = createCatalogRuntime(config, onCatalogFailure);
await catalog.refresh().catch(onCatalogFailure);
catalog.start();
const github =
  config.githubConfigFile && runtime?.mode !== 'image_factory'
    ? await readGithubConfig(config.githubConfigFile)
    : undefined;
const app = createApp({
  ...(fence ? { checkControl: fence.check } : {}),
  db: connection.db,
  provider: config.provider,
  limits: config.limits,
  catalog: catalog.snapshot,
  ...(github
    ? {
        login: createCustomerLogin({
          db: connection.db,
          clientId: github.clientId,
          verify: githubIdentityVerifier(github),
        }),
      }
    : {}),
  ...(runtime?.mode === 'image_factory'
    ? { imageEnrollment: runtime.enrollment, customerAccess: 'disabled' }
    : {}),
  ...(runtime?.mode === 'customer'
    ? {
        enrollment: runtime.enrollment,
        renewal: runtime.renewal,
        imageRelease: runtime.imageRelease,
        ...(runtime.internalReference ? { internalReference: runtime.internalReference } : {}),
        ...(runtime.access ? { access: runtime.access } : {}),
        ...(runtime.backups ? { backups: runtime.backups.service } : {}),
        ...(runtime.hosting
          ? {
              hosting: {
                service: runtime.hosting.service,
                gatewayToken: await readPrivateFile(runtime.hosting.gatewayTokenFile),
              },
            }
          : {}),
      }
    : {}),
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
      void (async () => {
        await fence?.close();
        await connection.pool.end();
      })();
    });
  });
}

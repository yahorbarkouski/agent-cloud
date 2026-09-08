import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { open, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { readPrivateFile } from './control/dist/private-file.js';

const [command, ...args] = process.argv.slice(2);
const passwordFile = '/run/agent-cloud/postgres-password';

async function main() {
  if (command === 'initialize-wal') {
    if (args.length) throw new Error('Unexpected WAL initialization argument.');
    const { initializeControlWal } = await import('./control/dist/control-wal-config.js');
    await initializeControlWal('/run/agent-cloud-wal/pgbackrest.conf');
    process.stdout.write('{"initialized":true}\n');
    return;
  }
  if (process.env.ACLD_CONTAINER_ENV_FILE)
    Object.assign(
      process.env,
      parseEnv(await readPrivateFile(process.env.ACLD_CONTAINER_ENV_FILE)),
    );
  if (command === 'initialize-local') {
    if (args.length) throw new Error('Unexpected initialization argument.');
    try {
      const file = await open(passwordFile, 'wx', 0o600);
      try {
        await file.writeFile(randomBytes(32).toString('hex') + '\n');
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    if (!/^[a-f0-9]{64}$/.test(await readPrivateFile(passwordFile)))
      throw new Error('Existing local database secret is invalid.');
    // A retry may follow a terminated writer that left valid but unsynced contents.
    const saved = await open(passwordFile, 'r');
    try {
      await saved.sync();
    } finally {
      await saved.close();
    }
    const directory = await open('/run/agent-cloud', 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    process.stdout.write('{"initialized":true}\n');
    return;
  }
  if (process.env.ACLD_LOCAL_QUICKSTART === '1') {
    if (process.env.PROVIDER !== 'simulated' || process.env.PUBLIC_URL !== 'http://127.0.0.1:4319')
      throw new Error('Local quickstart requires simulated provider and its loopback origin.');
    const password = await readPrivateFile(passwordFile);
    if (!/^[a-f0-9]{64}$/.test(password)) throw new Error('Invalid local database secret.');
    process.env.DATABASE_URL = `postgres://agentcloud:${password}@postgres:5432/agentcloud`;
  }
  if (command === 'bootstrap-internal') {
    if (
      process.env.ACLD_LOCAL_QUICKSTART !== '1' ||
      args.join(' ') !== '--allow-internal-development'
    )
      throw new Error('Internal bootstrap requires the explicit local development allowance.');
    const { bootstrap } = await import('./control/dist/bootstrap.js');
    await bootstrap();
    return;
  }
  const entries = {
    api: 'control/dist/api.js',
    worker: 'control/dist/worker.js',
    migrate: 'control/node_modules/@agent-cloud/db/dist/migrate.js',
    cli: 'cli/dist/index.js',
    'access-gateway': 'access-gateway/dist/index.js',
    'public-gateway': 'public-gateway/dist/main.js',
    'backup-retention': 'control/dist/backup-retention-main.js',
  };
  if (!Object.hasOwn(entries, command)) throw new Error('Unknown runtime command.');
  const path = await realpath(`/opt/agent-cloud/${entries[command]}`);
  process.argv = [process.execPath, path, ...args];
  await import(pathToFileURL(path).href);
}

main().catch(() => {
  process.stderr.write(
    '{"error":"Runtime command failed; inspect private configuration and service health."}\n',
  );
  process.exitCode = 1;
});

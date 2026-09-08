import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { grants } from '../packages/db/src/index.js';
import { projectResponseSchema, simulatedCatalog } from '../packages/contracts/src/index.js';
import { createApp } from '../apps/control/src/app.js';
import { openControlFence } from '../apps/control/src/control-fence.js';
import { prepareControlGeneration } from '../apps/control/src/control-recovery.js';
import { seedAccount, testDatabase } from '../tests/database.js';

const scratch = await mkdtemp(join(tmpdir(), 'acld-control-dump-'));
const source = await testDatabase();
const target = await testDatabase();
const run = promisify(execFile);
let stage = 'source CLI';
let server: ReturnType<typeof serve> | undefined;
let fence: Awaited<ReturnType<typeof openControlFence>>;
const evidence = {
  reference: 'fixture:source-stopped-and-external-mutators-fenced',
  sha256: 'f'.repeat(64),
};
const generationPath = join(scratch, 'target-generation.json');
async function stop() {
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server?.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
    server = undefined;
  }
  await fence?.close();
  fence = undefined;
}
async function start(fixture: typeof source, path: string) {
  fence = await openControlFence(fixture.connection, path);
  const app = createApp({
    db: fixture.connection.db,
    provider: 'simulated',
    limits: { currency: 'EUR', maxMachines: 2, maxHourlyMicros: 20000 },
    catalog: simulatedCatalog,
    ...(fence ? { checkControl: fence.check } : {}),
  });
  server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function credentials(endpoint: string, token: string) {
  const path = join(scratch, randomUUID() + '.json');
  await writeFile(path, JSON.stringify({ server: endpoint, token }), { mode: 0o600, flag: 'wx' });
  return path;
}
const cli = (path: string, args: string[]) =>
  run(process.execPath, ['apps/cli/dist/index.js', ...args], {
    env: { ACLD_CREDENTIALS: path },
    timeout: 15_000,
    maxBuffer: 65536,
  });
const environment = {
  DATABASE_URL: target.databaseUrl,
  PROVIDER: 'simulated',
  ACLD_CONTROL_GENERATION_FILE: generationPath,
};
async function operator(request: unknown) {
  const path = join(scratch, randomUUID() + '.json');
  await writeFile(path, JSON.stringify(request), { mode: 0o600, flag: 'wx' });
  await run(process.execPath, ['apps/control/dist/control-recovery-main.js', 'apply', path], {
    env: environment,
    timeout: 15_000,
    maxBuffer: 65536,
  });
}
try {
  const originalPath = await source.controlIdentity();
  const owner = await seedAccount(source.connection.db);
  const originalUrl = await start(source, originalPath);
  const originalCredentials = await credentials(originalUrl, owner.token);
  const before = projectResponseSchema.parse(
    JSON.parse((await cli(originalCredentials, ['project', 'create', 'before-checkpoint'])).stdout),
  ).project;
  await stop();
  stage = 'actual isolated PostgreSQL dump and restore';
  const container = process.env.ACLD_TEST_POSTGRES_CONTAINER ?? 'agent-cloud-dev-postgres-1';
  const dbName = (url: string) =>
    z
      .string()
      .regex(/^agentcloud_test_[a-f0-9]{32}$/)
      .parse(new URL(url).pathname.slice(1));
  const dump = await run(
    'docker',
    ['exec', container, 'pg_dump', '-U', 'agentcloud', '-Fc', dbName(source.databaseUrl)],
    {
      encoding: 'buffer',
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const checkpointSha256 = createHash('sha256').update(dump.stdout).digest('hex');
  // These writes are newer than the checkpoint. They must not become restored authority.
  await source.connection.db
    .update(grants)
    .set({ revokedAt: new Date() })
    .where(eq(grants.id, owner.principal.grantId));
  const restored = spawn(
    'docker',
    [
      'exec',
      '-i',
      container,
      'pg_restore',
      '-U',
      'agentcloud',
      '--clean',
      '--if-exists',
      '--exit-on-error',
      '-d',
      dbName(target.databaseUrl),
    ],
    { stdio: ['pipe', 'ignore', 'ignore'] },
  );
  const timeout = setTimeout(() => restored.kill('SIGKILL'), 30_000);
  try {
    restored.stdin.on('error', () => {});
    const finished = once(restored, 'exit');
    restored.stdin.end(dump.stdout);
    const [code] = z.tuple([z.number().nullable(), z.string().nullable()]).parse(await finished);
    assert.equal(code, 0, 'Isolated database restore failed');
  } finally {
    clearTimeout(timeout);
  }
  dump.stdout.fill(0);
  const [restoredGrant] = await target.connection.db
    .select()
    .from(grants)
    .where(eq(grants.id, owner.principal.grantId));
  assert.equal(restoredGrant?.revokedAt, null);
  const generation = await prepareControlGeneration(generationPath);
  stage = 'restored API and worker refusal';
  for (const entry of ['api', 'worker']) {
    await assert.rejects(
      run(process.execPath, [`apps/control/dist/${entry}.js`], {
        env: environment,
        timeout: 10_000,
        maxBuffer: 16384,
      }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 1,
    );
  }
  stage = 'operator fencing and explicit resume';
  const recoveryId = randomUUID();
  await operator({
    kind: 'begin',
    id: recoveryId,
    generation: generation.generation,
    operator: 'fixture',
    checkpointSha256,
    evidence,
    oldProcessesStopped: true,
    oldProviderCredentialsRevoked: true,
    oldSigningCredentialsRevoked: true,
    oldStorageMutatorsFenced: true,
  });
  const inspection = z
    .object({
      blockers: z.array(z.unknown()).length(0),
      stateDigest: z.string(),
      inventoryDigest: z.string(),
    })
    .parse(
      JSON.parse(
        (
          await run(process.execPath, ['apps/control/dist/control-recovery-main.js', 'inspect'], {
            env: environment,
            timeout: 15_000,
            maxBuffer: 65536,
          })
        ).stdout,
      ),
    );
  await operator({
    kind: 'resume',
    id: randomUUID(),
    recoveryId,
    generation: generation.generation,
    operator: 'fixture',
    expectedState: inspection.stateDigest,
    expectedInventory: inspection.inventoryDigest,
    evidence,
    postCheckpointEffectsClosed: true,
  });
  const endpoint = await start(target, generationPath);
  const staleCredentials = await credentials(endpoint, owner.token);
  await assert.rejects(cli(staleCredentials, ['whoami']));
  const fresh = await seedAccount(target.connection.db);
  const freshCredentials = await credentials(endpoint, fresh.token);
  await cli(freshCredentials, ['whoami']);
  const after = projectResponseSchema.parse(
    JSON.parse((await cli(freshCredentials, ['project', 'create', 'after-recovery'])).stdout),
  ).project;
  const retained = await target.connection.pool.query<{ id: string }>(
    'SELECT id FROM projects WHERE id=$1',
    [before.id],
  );
  assert.equal(retained.rows[0]?.id, before.id);
  const sourceGrant = await source.connection.db
    .select()
    .from(grants)
    .where(eq(grants.id, owner.principal.grantId));
  assert.ok(sourceGrant[0]?.revokedAt);
  process.stdout.write(
    JSON.stringify({
      checkpointSha256,
      actualDumpRestore: true,
      restoredApiAndWorkerRefused: true,
      staleCredentialRejected: true,
      restoredProjectPreserved: before.id,
      freshCliProject: after.id,
      providerProof: false,
    }) + '\n',
  );
} catch {
  throw new Error(`Control recovery smoke failed at ${stage}.`);
} finally {
  await stop();
  await target.close();
  await source.close();
  await rm(scratch, { recursive: true, force: true });
  process.stdout.write('{"isolatedControlDatabasesAndPrivateFilesRemoved":true}\n');
}

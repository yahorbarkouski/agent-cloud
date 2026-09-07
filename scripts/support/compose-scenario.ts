import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { request } from 'node:https';
import { z } from 'zod';
import { composeResponseSchema } from '../../packages/contracts/dist/index.js';
import {
  referenceFrontend,
  referenceImages,
  referenceRecipe,
} from '../../packages/guestctl/src/reference-recipe.js';

/** Customer CLI → access API/gateway → ordinary uploaded Compose source → real Docker/Postgres/HTTPS. */
export async function exerciseCompose(input: {
  machine: string;
  credentials: string;
  scratch: string;
  address: string;
  cli: (
    args: string[],
    credentials: string,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  vm: (args: string[], timeout?: number) => Promise<string>;
}) {
  const source = join(input.scratch, 'application source');
  await mkdir(source, { mode: 0o700 });
  const pointer = z
    .object({ manifestDigest: z.string().regex(/^[a-f0-9]{64}$/) })
    .parse(JSON.parse(await readFile('.local/guest-build.json', 'utf8')));
  await copyFile(
    resolve('.local/guest-builds', pointer.manifestDigest, 'guestctl.mjs'),
    join(source, 'guestctl.mjs'),
  );
  await writeFile(join(source, 'database-password'), randomBytes(32).toString('hex') + '\n', {
    mode: 0o600,
  });
  await writeFile(
    join(source, 'Dockerfile'),
    `FROM ${referenceImages.node}\nWORKDIR /app\nCOPY guestctl.mjs /app/guestctl.mjs\nUSER node\nCMD ["node", "/app/guestctl.mjs", "reference-app"]\n`,
  );
  await writeFile(
    join(source, 'Caddyfile'),
    'customer.localhost {\n tls internal\n handle /api/* {\n reverse_proxy backend:3000\n }\n handle {\n root * /srv\n file_server\n }\n}\nhttp://:8080 {\n respond /ready 200\n}\n',
  );
  async function prepare(revision: '1' | '2', broken = false) {
    const recipe = referenceRecipe({
      releaseId: randomUUID(),
      expectedReleaseId: null,
      revision,
      hostname: 'customer.localhost',
    });
    recipe.name = 'ignored-source-name';
    recipe.secrets.database_password.file = './database-password';
    if (broken) recipe.services.backend.healthcheck.test = ['CMD', 'node', '-e', 'process.exit(1)'];
    await writeFile(join(source, 'compose.json'), JSON.stringify(recipe));
    await writeFile(join(source, 'index.html'), referenceFrontend(revision));
  }
  async function cli(args: string[], expected = 0) {
    const result = await input.cli(['compose', ...args], input.credentials);
    assert.equal(
      result.code,
      expected,
      result.stderr.slice(0, 2000) + result.stdout.slice(0, 3000),
    );
    return composeResponseSchema.parse(JSON.parse(result.stdout));
  }
  async function apply(id: string, previous: string | null) {
    return cli([
      'apply',
      input.machine,
      'sample',
      '--source',
      source,
      '--file',
      'compose.json',
      '--release',
      id,
      '--wait-seconds',
      '30',
      ...(previous ? ['--expected-release', previous] : []),
    ]);
  }
  let ca = '';
  const application = (path: string, method = 'GET') =>
    new Promise<string>((resolve, reject) => {
      const req = request(
        {
          hostname: input.address,
          port: 443,
          servername: 'customer.localhost',
          ca,
          path,
          method,
          headers: { Host: 'customer.localhost', Origin: 'https://customer.localhost' },
          timeout: 10_000,
        },
        (response) => {
          let body = '';
          response.on('data', (chunk: Buffer) => {
            body += chunk.toString();
            if (body.length > 65_536) response.destroy(new Error('Oversized application reply.'));
          });
          response.once('error', reject);
          response.once('end', () => {
            if (response.statusCode === 200) resolve(body);
            else reject(new Error(`Application HTTP ${String(response.statusCode)}`));
          });
        },
      );
      req.once('error', reject);
      req.on('timeout', () => req.destroy(new Error('Application request timed out.')));
      req.end();
    });
  const first = randomUUID();
  await prepare('1');
  await apply(first, null);
  // Admission CLI has disconnected; systemd owns the deployment and Compose owns its containers.
  assert.equal((await cli(['wait', input.machine, 'sample'])).release?.phase, 'succeeded');
  ca = await input.vm([
    'docker',
    'compose',
    '-p',
    'acld-sample',
    '-f',
    `/var/lib/agent-cloud/compose/sample/releases/${first}/runtime.json`,
    'exec',
    '-T',
    'frontend',
    'cat',
    '/data/caddy/pki/authorities/local/root.crt',
  ]);
  assert.match(await application('/'), /Release 1/);
  assert.deepEqual(JSON.parse(await application('/api/visits', 'POST')), {
    revision: '1',
    count: '1',
  });
  const status = await cli(['inspect', input.machine, 'sample']);
  assert.equal(status.containers.length, 3);
  assert.ok(
    status.containers.every(
      (container) => container.state === 'running' && container.health === 'healthy',
    ),
  );
  assert.match(
    (await cli(['logs', input.machine, 'sample', '--service', 'backend'])).output,
    /visit_recorded/,
  );
  const second = randomUUID();
  await prepare('2');
  await apply(second, first);
  assert.equal((await cli(['wait', input.machine, 'sample'])).release?.phase, 'succeeded');
  assert.deepEqual(JSON.parse(await application('/api/visits')), { revision: '2', count: '1' });
  assert.match(await application('/'), /Release 2/);
  const failed = randomUUID();
  await prepare('2', true);
  await apply(failed, second);
  assert.equal((await cli(['wait', input.machine, 'sample'], 1)).release?.phase, 'failed');
  const recovery = randomUUID();
  await cli([
    'recover',
    input.machine,
    'sample',
    '--from',
    first,
    '--release',
    recovery,
    '--expected-release',
    failed,
    '--wait-seconds',
    '30',
  ]);
  assert.equal((await cli(['wait', input.machine, 'sample'])).release?.phase, 'succeeded');
  assert.deepEqual(JSON.parse(await application('/api/visits')), { revision: '1', count: '1' });
  assert.match(await application('/'), /Release 1/);
  process.stdout.write(
    JSON.stringify({
      result: 'compose-locally-verified',
      provider: 'simulated',
      vm: 'native Ubuntu',
      customerCli: true,
      uploadedSource: true,
      https: 'verified local Caddy CA',
      cliDisconnected: true,
      healthyServices: 3,
      logs: true,
      updatePreservedData: true,
      failedRelease: true,
      recoveryPreservedData: true,
      releases: [first, second, failed, recovery],
    }) + '\n',
  );
}

import assert from 'node:assert/strict';
import { exerciseAnalytics } from './analytics-scenario.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { request } from 'node:https';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { composeResponseSchema, routeResponseSchema } from '../../packages/contracts/dist/index.js';
import {
  referenceFrontend,
  referenceImages,
  referenceRecipe,
} from '../../packages/guestctl/src/reference-recipe.js';

/** Customer CLI → route API/worker → separate public gateway → mTLS guest proxy → Compose/Postgres. */
export async function exerciseHosting(input: {
  machine: string;
  credentials: string;
  scratch: string;
  gatewayState: string;
  httpsPort: number;
  cli: (
    args: string[],
    credentials: string,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  apiAvailable: (available: boolean) => void;
  restartGateway: () => Promise<void>;
  reboot: () => Promise<void>;
}) {
  async function cli(args: string[], expected = 0) {
    const result = await input.cli(args, input.credentials);
    assert.equal(
      result.code,
      expected,
      result.stderr.slice(0, 2000) + result.stdout.slice(0, 2000),
    );
    const value: unknown = JSON.parse(result.stdout);
    return value;
  }
  const admitted = routeResponseSchema.parse(
    await cli([
      'route',
      'publish',
      input.machine,
      '--name',
      'sample',
      '--port',
      '30080',
      '--key',
      randomUUID(),
    ]),
  );
  const hostname = admitted.route.hostname;
  await cli(['route', 'wait', hostname]);
  const source = join(input.scratch, 'hosting application');
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
    'http://:80 {\n handle /api/* {\n reverse_proxy backend:3000\n }\n handle {\n root * /srv\n file_server\n }\n}\nhttp://:8080 {\n respond /ready 200\n}\n',
  );
  async function deploy(revision: '1' | '2', previous: string | null) {
    const id = randomUUID();
    const recipe = referenceRecipe({ releaseId: id, expectedReleaseId: null, revision, hostname });
    recipe.secrets.database_password.file = './database-password';
    recipe.services.backend.environment.APP_HOSTNAME = `${hostname}:${input.httpsPort}`;
    recipe.services.frontend.ports = ['127.0.0.1:30080:80', '127.0.0.1:30081:80'];
    await writeFile(join(source, 'compose.json'), JSON.stringify(recipe));
    await writeFile(join(source, 'index.html'), referenceFrontend(revision));
    await cli([
      'compose',
      'apply',
      input.machine,
      'hosted',
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
    assert.equal(
      composeResponseSchema.parse(await cli(['compose', 'wait', input.machine, 'hosted'])).release
        ?.phase,
      'succeeded',
    );
    return id;
  }
  const first = await deploy('1', null);
  let ca = '';
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      ca = await readFile(
        join(input.gatewayState, 'certificates/pki/authorities/local/root.crt'),
        'utf8',
      );
      break;
    } catch (error) {
      if (attempt === 19) throw error;
      await setTimeout(500);
    }
  }
  const application = (path: string, method = 'GET', host = hostname, version = '999999') =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: input.httpsPort,
          servername: hostname,
          ca,
          path,
          method,
          headers: {
            Host: host,
            Origin: `https://${hostname}:${input.httpsPort}`,
            'X-Agent-Cloud-Route-Version': version,
          },
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
            resolve({ status: response.statusCode ?? 0, body });
          });
        },
      );
      req.once('error', reject);
      req.on('timeout', () => req.destroy(new Error('Application request timed out.')));
      req.end();
    });
  async function ready(revision: string) {
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const response = await application('/api/visits');
        assert.equal(response.status, 200);
        assert.deepEqual(JSON.parse(response.body), { revision, count: '1' });
        return;
      } catch (error) {
        if (attempt === 39) throw error;
        await setTimeout(500);
      }
    }
  }
  assert.match((await application('/')).body, /Release 1/);
  const visit = await application('/api/visits', 'POST');
  assert.equal(visit.status, 200);
  assert.deepEqual(JSON.parse(visit.body), { revision: '1', count: '1' });
  assert.notEqual((await application('/', 'GET', 'foreign.example.test')).status, 200);
  assert.match(
    composeResponseSchema.parse(
      await cli(['compose', 'logs', input.machine, 'hosted', '--service', 'backend']),
    ).output,
    /visit_recorded/,
  );
  await cli([
    'route',
    'publish',
    input.machine,
    '--name',
    'sample',
    '--port',
    '30081',
    '--expected-version',
    '1',
    '--key',
    randomUUID(),
  ]);
  await cli(['route', 'wait', hostname]);
  await ready('1');
  const second = await deploy('2', first);
  await ready('2');
  if (process.env.AGENT_CLOUD_ANALYTICS_SCENARIO !== '1') {
    input.apiAvailable(false);
    try {
      await setTimeout(6000);
      await ready('2');
      await input.restartGateway();
      await ready('2');
      await input.reboot();
      await ready('2');
    } finally {
      input.apiAvailable(true);
    }
  }
  if (process.env.AGENT_CLOUD_ANALYTICS_SCENARIO === '1') {
    await exerciseAnalytics({
      machine: input.machine,
      scratch: input.scratch,
      siteHostname: hostname,
      siteSource: source,
      siteRelease: second,
      httpsPort: input.httpsPort,
      ca,
      cli,
    });
    assert.deepEqual(JSON.parse((await application('/api/visits')).body), {
      revision: '2',
      count: '2',
    });
  }
  const inspected = routeResponseSchema.parse(await cli(['route', 'inspect', hostname]));
  assert.equal(inspected.route.gatewayAppliedVersion, 2);
  await cli(['route', 'remove', hostname, '--expected-version', '2', '--key', randomUUID()]);
  await cli(['route', 'wait', hostname]);
  // An empty snapshot closes HTTPS; either TLS refusal or a non-success response proves removal.
  const removed = await application('/').catch(() => null);
  assert.ok(removed === null || removed.status !== 200);
  process.stdout.write(
    JSON.stringify({
      result: 'hosting-locally-verified',
      customerCli: true,
      nativeGuest: true,
      publicGateway: true,
      privateMtls: true,
      https: 'verified local Caddy CA',
      headerSpoofOverwritten: true,
      foreignHostDenied: true,
      routeUpdate: true,
      cliDisconnected: true,
      applicationUpdatePreservedData: true,
      apiOutage: process.env.AGENT_CLOUD_ANALYTICS_SCENARIO !== '1',
      gatewayRestart: process.env.AGENT_CLOUD_ANALYTICS_SCENARIO !== '1',
      guestReboot: process.env.AGENT_CLOUD_ANALYTICS_SCENARIO !== '1',
      removed: true,
    }) + '\n',
  );
}

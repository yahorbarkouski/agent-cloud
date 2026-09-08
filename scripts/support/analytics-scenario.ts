import assert from 'node:assert/strict';
import { visitAnalyticsSite } from './analytics-browser.js';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request } from 'node:https';
import { parseEnv, promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { composeResponseSchema, routeResponseSchema } from '../../packages/contracts/dist/index.js';

/** The real browser supplies pageviews/clicks; this fixture never calls the collection endpoint. */
export async function exerciseAnalytics(input: {
  machine: string;
  scratch: string;
  siteHostname: string;
  siteSource: string;
  siteRelease: string;
  httpsPort: number;
  ca: string;
  cli: (args: string[]) => Promise<unknown>;
}) {
  const context = join(input.scratch, 'analytics recipe');
  await promisify(execFile)(
    process.execPath,
    [
      'apps/cli/dist/index.js',
      'recipe',
      'prepare',
      'umami',
      '--version',
      '1.0.0',
      '--output',
      context,
    ],
    { timeout: 10000 },
  );
  const release = z.uuid().parse((await readFile(join(context, 'release-id'), 'utf8')).trim());
  await input.cli([
    'compose',
    'apply',
    input.machine,
    'analytics',
    '--source',
    context,
    '--file',
    'compose.yaml',
    '--release',
    release,
    '--wait-seconds',
    '30',
  ]);
  const deployed = composeResponseSchema.parse(
    await input.cli(['compose', 'wait', input.machine, 'analytics']),
  );
  assert.equal(deployed.release?.phase, 'succeeded');
  const { route } = routeResponseSchema.parse(
    await input.cli([
      'route',
      'publish',
      input.machine,
      '--name',
      'analytics',
      '--port',
      '3000',
      '--key',
      randomUUID(),
    ]),
  );
  await input.cli(['route', 'wait', route.hostname]);
  const publicOrigin = `https://${route.hostname}:${input.httpsPort}`;
  async function api(path: string, options: { body?: unknown; token?: string } = {}) {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: input.httpsPort,
          servername: route.hostname,
          ca: input.ca,
          path,
          method: body ? 'POST' : 'GET',
          timeout: 10000,
          headers: {
            Host: route.hostname,
            ...(body
              ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
              : {}),
            ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
          },
        },
        (response) => {
          let content = '';
          response.on('data', (chunk: Buffer) => {
            content += chunk.toString();
            if (content.length > 262144)
              response.destroy(new Error('Oversized analytics response.'));
          });
          response.once('error', reject);
          response.once('end', () => {
            try {
              resolve({ status: response.statusCode ?? 0, body: JSON.parse(content) });
            } catch {
              reject(new Error('Analytics returned invalid JSON.'));
            }
          });
        },
      );
      req.once('error', reject);
      req.once('timeout', () => req.destroy(new Error('Analytics request timed out.')));
      req.end(body);
    });
  }
  const password = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(
      parseEnv(await readFile(join(context, 'secrets/umami.env'), 'utf8')).RECIPE_ADMIN_PASSWORD,
    );
  assert.equal(
    (await api('/api/auth/login', { body: { username: 'admin', password: 'umami' } })).status,
    401,
  );
  const login = await api('/api/auth/login', { body: { username: 'admin', password } });
  assert.equal(login.status, 200);
  const { token } = z.object({ token: z.string().min(1) }).parse(login.body);
  const websiteId = randomUUID();
  const created = await api('/api/websites', {
    token,
    body: { id: websiteId, name: 'Native customer site', domain: input.siteHostname },
  });
  assert.equal(created.status, 200);
  assert.equal(z.object({ id: z.uuid() }).parse(created.body).id, websiteId);
  const html = (await readFile(join(input.siteSource, 'index.html'), 'utf8'))
    .replace(
      '<title>',
      `<script defer src="${publicOrigin}/script.js" data-website-id="${websiteId}"></script><title>`,
    )
    .replace('<button id="visit">', '<button id="visit" data-umami-event="record-visit">');
  await writeFile(join(input.siteSource, 'index.html'), html);
  const instrumentedRelease = randomUUID();
  await input.cli([
    'compose',
    'apply',
    input.machine,
    'hosted',
    '--source',
    input.siteSource,
    '--file',
    'compose.json',
    '--release',
    instrumentedRelease,
    '--expected-release',
    input.siteRelease,
    '--wait-seconds',
    '30',
  ]);
  assert.equal(
    composeResponseSchema.parse(await input.cli(['compose', 'wait', input.machine, 'hosted']))
      .release?.phase,
    'succeeded',
  );
  const startedAt = Date.now() - 1000;
  const siteUrl = `https://${input.siteHostname}:${input.httpsPort}/`;
  await writeFile(
    join(input.scratch, 'analytics-browser.json'),
    JSON.stringify({ siteUrl, analyticsUrl: publicOrigin, websiteId, instrumentedRelease }),
    { mode: 0o600, flag: 'wx' },
  );
  process.stdout.write(
    JSON.stringify({
      phase: 'analytics-browser-ready',
      siteUrl,
      analyticsUrl: publicOrigin,
      websiteId,
      action: 'Visit the deployed site in a browser and click Record a visit once.',
    }) + '\n',
  );
  const browser = await visitAnalyticsSite({ siteUrl, analyticsUrl: publicOrigin });
  process.stdout.write(JSON.stringify({ phase: 'analytics-browser-completed', ...browser }) + '\n');
  let verified = false;
  for (let attempt = 0; attempt < 15; attempt++) {
    const query = `startAt=${startedAt}&endAt=${Date.now() + 1000}`;
    const statsResponse = await api(`/api/websites/${websiteId}/stats?${query}`, { token });
    assert.equal(statsResponse.status, 200);
    const stats = z
      .object({ pageviews: z.number(), visitors: z.number() })
      .parse(statsResponse.body);
    const eventsResponse = await api(
      `/api/websites/${websiteId}/events/series?${query}&unit=hour&timezone=UTC`,
      { token },
    );
    assert.equal(eventsResponse.status, 200);
    const events = z.array(z.object({ x: z.string(), y: z.number() })).parse(eventsResponse.body);
    const clicks = events
      .filter((event) => event.x === 'record-visit')
      .reduce((sum, event) => sum + event.y, 0);
    if (stats.pageviews >= 1 && stats.visitors >= 1 && clicks === 1) {
      process.stdout.write(
        JSON.stringify({
          result: 'native-site-analytics-verified',
          siteUrl,
          websiteId,
          instrumentedRelease,
          pageviews: stats.pageviews,
          visitors: stats.visitors,
          recordVisitEvents: clicks,
          collectorRequestsFromFixture: 0,
        }) + '\n',
      );
      verified = true;
      break;
    }
    await setTimeout(2000);
  }
  assert.ok(
    verified,
    'The browser must produce a recorded pageview, visitor and one intended event within thirty seconds of the browser click.',
  );
  await input.cli([
    'route',
    'remove',
    route.hostname,
    '--expected-version',
    String(route.version),
    '--key',
    randomUUID(),
  ]);
  await input.cli(['route', 'wait', route.hostname]);
}

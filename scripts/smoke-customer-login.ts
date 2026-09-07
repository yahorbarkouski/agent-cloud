import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  capabilitySchema,
  githubUserIdSchema,
  grantPolicySchema,
  regionSchema,
  sizeSchema,
  whoamiResponseSchema,
} from '../packages/contracts/src/index.js';
import { testDatabase } from '../tests/database.js';

// Explicit real-GitHub smoke. No provider credentials or VM allocation are used.
const githubUserId = githubUserIdSchema.parse(process.env.ACLD_GITHUB_USER_ID);
const githubConfig = resolve(z.string().min(1).parse(process.env.ACLD_GITHUB_CONFIG));
const port = z.coerce
  .number()
  .int()
  .min(1024)
  .max(65535)
  .default(4338)
  .parse(process.env.ACLD_LOGIN_SMOKE_PORT);
const fixture = await testDatabase();
const scratch = await mkdtemp(join(tmpdir(), 'acld-real-login-'));
const endpoint = `http://127.0.0.1:${port}`;
const ownerFile = join(scratch, 'customer.json');
const agentFile = join(scratch, 'agent.json');
const environment = {
  ...process.env,
  DATABASE_URL: fixture.databaseUrl,
  PROVIDER: 'simulated',
  HOST: '127.0.0.1',
  PORT: String(port),
  PUBLIC_URL: endpoint,
  ACLD_GITHUB_CONFIG: githubConfig,
  MAX_LIVE_MACHINES: '0',
  MAX_PROVIDER_HOURLY: '0',
  PROVIDER_CURRENCY: 'EUR',
  ACLD_CREDENTIALS: ownerFile,
};
const execute = promisify(execFile);
const api = spawn(process.execPath, ['apps/control/dist/api.js'], {
  env: environment,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const stopped = once(api, 'exit');
api.stdout.pipe(process.stdout);
api.stderr.pipe(process.stderr);
const abort = new AbortController();
const onSignal = () => {
  abort.abort();
};
process.once('SIGINT', onSignal);
process.once('SIGTERM', onSignal);
async function cli(args: string[], credentials = ownerFile, device = false) {
  const child = execute(process.execPath, ['apps/cli/dist/index.js', ...args], {
    env: { ...environment, ACLD_CREDENTIALS: credentials },
    timeout: device ? 900_000 : 20_000,
    maxBuffer: 1_048_576,
    signal: abort.signal,
  });
  if (device) child.child.stderr?.pipe(process.stderr);
  const result: unknown = JSON.parse((await child).stdout);
  return result;
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (api.exitCode !== null) throw new Error('Sign-in fixture API exited.');
    try {
      ready = (await fetch(`${endpoint}/healthz`, { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      /* API is starting. */
    }
    if (ready) break;
    await setTimeout(100, undefined, { signal: abort.signal });
  }
  if (!ready) throw new Error('Sign-in fixture API did not become ready.');
  const policy = grantPolicySchema.parse({
    capabilities: capabilitySchema.options,
    projects: { kind: 'all' },
    sizes: sizeSchema.options,
    regions: regionSchema.options,
    maxMachines: 0,
    currency: 'EUR',
    maxHourlyMicros: 0,
  });
  const admissionFile = join(scratch, 'admission.json');
  await writeFile(
    admissionFile,
    JSON.stringify({
      githubUserId,
      name: 'real-github-smoke',
      policy,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }),
    { mode: 0o600 },
  );
  await execute(
    process.execPath,
    ['--import', 'tsx', 'scripts/customer.ts', 'admit', admissionFile],
    { env: environment, timeout: 20_000 },
  );
  process.stdout.write(
    JSON.stringify({ event: 'customer_login.ready', endpoint, githubUserId, allocationLimit: 0 }) +
      '\n',
  );
  await cli(['login', '--server', endpoint], ownerFile, true);
  const { principal } = whoamiResponseSchema.parse(await cli(['whoami']));
  const policyFile = join(scratch, 'agent-policy.json');
  await writeFile(
    policyFile,
    JSON.stringify({ ...policy, capabilities: ['project:read', 'machine:read'] }),
  );
  await cli([
    'grant',
    'create',
    'existing-agent',
    '--policy',
    policyFile,
    '--expires-at',
    new Date(Date.now() + 600_000).toISOString(),
    '--credentials',
    agentFile,
  ]);
  await cli(['project', 'list'], agentFile);
  const agent = whoamiResponseSchema.parse(await cli(['whoami'], agentFile));
  await cli(['grant', 'revoke', agent.principal.grantId]);
  let denied = false;
  try {
    await cli(['whoami'], agentFile);
  } catch {
    denied = true;
  }
  if (!denied) throw new Error('Revoked agent still authenticated.');
  await cli(['logout']);
  process.stdout.write(
    JSON.stringify({
      event: 'customer_login.passed',
      accountId: principal.accountId,
      verified: [
        'real GitHub device authorization',
        'OAuth app binding',
        'operator admission',
        'CLI/API identity',
        'delegated access',
        'revocation',
        'logout',
      ],
      machinesAllocated: 0,
    }) + '\n',
  );
} finally {
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);
  api.kill('SIGTERM');
  const deadline = globalThis.setTimeout(() => api.kill('SIGKILL'), 5000);
  try {
    await stopped;
  } finally {
    globalThis.clearTimeout(deadline);
  }
  await fixture.close();
  await rm(scratch, { recursive: true, force: true });
  process.stdout.write(
    JSON.stringify({
      event: 'customer_login.cleaned',
      databaseDropped: true,
      credentialsRemoved: true,
      apiStopped: true,
    }) + '\n',
  );
}

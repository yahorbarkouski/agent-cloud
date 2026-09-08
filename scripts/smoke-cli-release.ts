import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { serve } from '@hono/node-server';
import { z } from 'zod';
import {
  capabilitiesResponseSchema,
  projectResponseSchema,
  projectsResponseSchema,
  simulatedCatalog,
  whoamiResponseSchema,
} from '../packages/contracts/src/index.js';
import { createApp } from '../apps/control/src/app.js';
import { seedAccount, testDatabase } from '../tests/database.js';
import { inspectCliBundle } from './support/cli-release.js';

const execute = promisify(execFile);
const scratch = await mkdtemp(join(tmpdir(), 'acld-release-check-'));
const output = join(scratch, 'artifacts');
const customer = join(scratch, 'customer');
const credentials = join(customer, 'credentials.json');
const digest = (content: Uint8Array | string) => createHash('sha256').update(content).digest('hex');
const environment = {
  PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
  HOME: customer,
  ACLD_CREDENTIALS: credentials,
};
let fixture: Awaited<ReturnType<typeof testDatabase>> | undefined;
let server: ReturnType<typeof serve> | undefined;
let stage = 'archive build';
const builtEntry = resolve('apps/cli/dist/index.js');
const originalEntry = await readFile(builtEntry);
try {
  await writeFile(
    builtEntry,
    "#!/usr/bin/env node\nthrow new Error('stale release build fixture');\n",
  );
  const builder = resolve('scripts/release-cli.ts');
  const built = await execute(process.execPath, ['--import', 'tsx', builder, '--output', output], {
    timeout: 120_000,
    maxBuffer: 65536,
  });
  const manifest = z
    .object({
      archive: z.string().regex(/^agent-cloud-cli-[0-9a-z.-]+\.tar\.gz$/),
      bytes: z.int().positive(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      cliVersion: z.string(),
    })
    .parse(JSON.parse(built.stdout));
  const archive = join(output, manifest.archive);
  const original = await readFile(archive);
  assert.equal(original.byteLength, manifest.bytes);
  assert.equal(digest(original), manifest.sha256);
  const verifier = process.platform === 'darwin' ? 'shasum' : 'sha256sum';
  const verify = () =>
    execute(
      verifier,
      [...(process.platform === 'darwin' ? ['-a', '256'] : []), '--check', 'SHA256SUMS'],
      { cwd: output, timeout: 10_000 },
    );
  await verify();
  await writeFile(archive, Buffer.concat([original, Buffer.from('damaged')]));
  await assert.rejects(verify());
  await writeFile(archive, original);
  await verify();
  // A second build must not replace a release a customer may already have downloaded.
  await assert.rejects(
    execute(process.execPath, ['--import', 'tsx', builder, '--output', output], {
      timeout: 10_000,
    }),
  );
  assert.equal(digest(await readFile(archive)), manifest.sha256);
  await mkdir(customer, { mode: 0o700 });
  await execute('tar', ['-xzf', archive, '-C', customer], { timeout: 30_000 });
  const bundle = join(customer, manifest.archive.replace(/\.tar\.gz$/, ''));
  await inspectCliBundle(bundle);
  await rm(output, { recursive: true });
  const cli = join(customer, 'acld');
  await symlink(join(bundle, 'bin/acld'), cli);
  async function run(args: string[]) {
    try {
      return await execute(cli, args, {
        cwd: customer,
        env: environment,
        timeout: 15_000,
        maxBuffer: 131072,
      });
    } catch {
      throw new Error(`Released CLI failed at ${args[0] ?? 'invocation'}.`);
    }
  }
  assert.equal((await run(['--version'])).stdout.trim(), manifest.cliVersion);
  stage = 'offline agent instructions and recipes';
  const canonical = await readFile(
    new URL('../skills/agent-cloud/SKILL.md', import.meta.url),
    'utf8',
  );
  const instructions = z
    .object({ markdown: z.string(), sha256: z.string(), version: z.string() })
    .parse(JSON.parse((await run(['agent', 'instructions'])).stdout));
  assert.equal(instructions.markdown, canonical);
  assert.equal(instructions.sha256, digest(canonical));
  assert.equal(instructions.version, manifest.cliVersion);
  assert.match(canonical, /^---\nname: agent-cloud\n/);
  assert.doesNotMatch(canonical, /\]\(\.\.\//);
  const target = join(customer, 'agent-cloud');
  const receipt = z
    .object({ path: z.string(), sha256: z.string() })
    .parse(JSON.parse((await run(['agent', 'install', '--directory', target])).stdout));
  assert.equal(receipt.path, join(target, 'SKILL.md'));
  assert.equal(receipt.sha256, instructions.sha256);
  assert.equal(await readFile(receipt.path, 'utf8'), canonical);
  assert.equal((await stat(target)).mode & 0o777, 0o700);
  assert.equal((await stat(receipt.path)).mode & 0o777, 0o600);
  const edited = canonical + '\nCustomer-specific operating rules.\n';
  await writeFile(receipt.path, edited);
  await assert.rejects(run(['agent', 'install', '--directory', target]));
  const linked = join(customer, 'linked-skill');
  await symlink(target, linked);
  await assert.rejects(run(['agent', 'install', '--directory', linked]));
  assert.equal(await readFile(receipt.path, 'utf8'), edited);
  const recipes = z
    .object({ recipes: z.array(z.object({ id: z.string(), version: z.string() })) })
    .parse(JSON.parse((await run(['recipe', 'list'])).stdout));
  assert.deepEqual(
    recipes.recipes.map((recipe) => recipe.id),
    ['postgres', 'umami'],
  );
  for (const recipe of recipes.recipes) {
    const destination = join(customer, recipe.id);
    await run([
      'recipe',
      'prepare',
      recipe.id,
      '--version',
      recipe.version,
      '--output',
      destination,
    ]);
    assert.equal((await stat(destination)).mode & 0o777, 0o700);
    assert.ok((await stat(join(destination, 'compose.yaml'))).size > 0);
  }
  await assert.rejects(stat(credentials), { code: 'ENOENT' });
  stage = 'authenticated CLI and revocation';
  fixture = await testDatabase();
  const owner = await seedAccount(fixture.connection.db);
  const app = createApp({
    db: fixture.connection.db,
    provider: 'simulated',
    limits: { currency: 'EUR', maxMachines: 2, maxHourlyMicros: 20000 },
    catalog: simulatedCatalog,
  });
  server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const login = spawn(cli, ['login', '--server', endpoint, '--token-stdin'], {
    cwd: customer,
    env: environment,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  const timeout = setTimeout(() => login.kill('SIGKILL'), 15_000);
  try {
    const exited = once(login, 'exit');
    login.stdin.on('error', () => {});
    login.stdin.end(owner.token + '\n');
    assert.equal((await exited)[0], 0);
  } finally {
    clearTimeout(timeout);
  }
  assert.equal((await stat(credentials)).mode & 0o777, 0o600);
  assert.equal(
    whoamiResponseSchema.parse(JSON.parse((await run(['whoami'])).stdout)).principal.accountId,
    owner.principal.accountId,
  );
  assert.equal(
    capabilitiesResponseSchema.parse(JSON.parse((await run(['capabilities'])).stdout)).provider,
    'simulated',
  );
  const created = projectResponseSchema.parse(
    JSON.parse((await run(['project', 'create', 'released-cli'])).stdout),
  ).project;
  assert.ok(
    projectsResponseSchema
      .parse(JSON.parse((await run(['project', 'list'])).stdout))
      .projects.some((project) => project.id === created.id),
  );
  await run(['logout']);
  await assert.rejects(stat(credentials), { code: 'ENOENT' });
  const revoked = await fetch(endpoint + '/v1/whoami', {
    headers: { Authorization: `Bearer ${owner.token}` },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(revoked.status, 401);
  await assert.rejects(run(['whoami']));
  process.stdout.write(
    JSON.stringify({
      result: 'passed',
      archive: manifest.archive,
      sha256: manifest.sha256,
      bytes: manifest.bytes,
      verified: [
        'checksum and corruption refusal',
        'occupied release preserved',
        'portable executable outside checkout',
        'stale compiled output replaced before packaging',
        'bundled licenses and private-path audit',
        'offline skills and recipes',
        'private login, API commands and revocation',
      ],
      providerProof: false,
    }) + '\n',
  );
} catch {
  throw new Error(`CLI release verification failed at ${stage}.`);
} finally {
  // Preserve the existing development build if the intentionally stale fixture failed early.
  if (
    (await readFile(builtEntry).catch(() => Buffer.from(''))).includes(
      'stale release build fixture',
    )
  )
    await writeFile(builtEntry, originalEntry);
  if (server)
    await new Promise<void>((resolve, reject) =>
      server?.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  await fixture?.close();
  await rm(scratch, { recursive: true, force: true });
}
await assert.rejects(stat(scratch), { code: 'ENOENT' });
process.stdout.write('{"fixtureCleanupVerified":true}\n');

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { isolatedBackupConfig } from '../packages/guestctl/src/backup-system.ts';

const exec = promisify(execFile);
async function docker(args, timeout = 30_000) {
  try {
    return (
      await exec('docker', args, { timeout, maxBuffer: 131_072, killSignal: 'SIGKILL' })
    ).stdout.trim();
  } catch {
    throw new Error('Recipe Docker command failed.');
  }
}
async function cleanup(project) {
  const removed = { containers: [], networks: [], volumes: [] };
  for (const [kind, list] of [
    ['container', ['ps', '-aq', '--no-trunc']],
    ['network', ['network', 'ls', '-q', '--no-trunc']],
    ['volume', ['volume', 'ls', '-q']],
  ]) {
    const args = [...list, '--filter', `label=com.docker.compose.project=${project}`];
    for (const id of (await docker(args)).split('\n').filter(Boolean)) {
      const item = JSON.parse(await docker([kind, 'inspect', id]))[0];
      const labels = kind === 'container' ? item.Config.Labels : item.Labels;
      assert.equal(labels['com.docker.compose.project'], project);
      await docker([kind, 'rm', ...(kind === 'container' ? ['--force'] : []), id]);
      removed[`${kind}s`].push(id);
    }
    assert.equal(await docker(args), '');
  }
  process.stdout.write(JSON.stringify({ project, cleanupVerified: true, removed }) + '\n');
}
const directory = await mkdtemp('/tmp/acld-recipes-check-');
let stage = 'configuration';
let passed = false;
const results = [];
try {
  const recipes = process.argv.length === 2 ? ['postgres', 'umami'] : process.argv.slice(2);
  assert.ok(recipes.every((recipe) => ['postgres', 'umami'].includes(recipe)));
  for (const recipe of recipes) {
    const project = `acld-recipe-${randomUUID().slice(0, 8)}`;
    const context = join(directory, recipe);
    const listener = createServer();
    await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    await exec(
      process.execPath,
      [
        'recipes/prepare.mjs',
        recipe,
        '--output',
        context,
        ...(recipe === 'umami' ? ['--port', String(port)] : []),
      ],
      { timeout: 10_000, maxBuffer: 4096 },
    );
    const compose = (args) =>
      docker(
        ['compose', '--project-name', project, '--file', join(context, 'compose.yaml'), ...args],
        210_000,
      );
    try {
      const config = JSON.parse(await compose(['config', '--format', 'json']));
      const isolated = isolatedBackupConfig(config, {
        sourceRoot: context,
        customerRoot: '/var/lib/agent-customer',
        filesRoot: '/tmp/isolated-files',
        declared: [],
        databaseService: 'database',
      });
      assert.deepEqual(isolated.networks, { default: { internal: true } });
      assert.equal(isolated.volumes.database.name, undefined);
      assert.equal(isolated.secrets.database_password.file, './secrets/database-password');
      for (const service of Object.values(isolated.services))
        assert.deepEqual(service.networks, ['default']);
      assert.equal(isolated.services.database.volumes[0].target, '/var/lib/postgresql/data');
      if (recipe === 'umami')
        assert.equal(isolated.services.umami.volumes[0].source, './bootstrap.mjs');
      await writeFile(join(context, 'isolated.json'), JSON.stringify(isolated), { mode: 0o600 });
      await docker([
        'compose',
        '--project-name',
        `${project}-isolated`,
        '--file',
        join(context, 'isolated.json'),
        'config',
        '--quiet',
      ]);
      for (const name of await readdir(join(context, 'secrets')))
        assert.equal((await stat(join(context, 'secrets', name))).mode & 0o777, 0o600);
      assert.equal((await stat(context)).mode & 0o777, 0o700);
      for (const service of Object.values(config.services)) {
        assert.match(service.image, /@sha256:[a-f0-9]{64}$/);
        const cached = await docker(['image', 'inspect', service.image]).then(
          () => true,
          () => false,
        );
        if (!cached) await docker(['pull', '--quiet', service.image], 120_000);
      }
      stage = `${recipe} health`;
      await compose([
        'up',
        '--detach',
        '--wait',
        '--wait-timeout',
        '180',
        '--no-build',
        '--pull',
        'never',
      ]);
      const database = await compose(['ps', '--all', '--quiet', 'database']);
      const account = recipe === 'postgres' ? 'app' : 'umami';
      const sql = (container, query) =>
        docker([
          'exec',
          container,
          'psql',
          '-X',
          '-A',
          '-t',
          '-v',
          'ON_ERROR_STOP=1',
          '-U',
          account,
          '-d',
          account,
          '-c',
          query,
        ]);
      assert.match(await sql(database, 'show server_version'), /^17\./);
      const detail = JSON.parse(await docker(['container', 'inspect', database]))[0];
      assert.deepEqual(detail.HostConfig.PortBindings, {});
      assert.equal(Object.keys(detail.NetworkSettings.Networks).length, 1);
      assert.equal(
        JSON.parse(
          await docker(['network', 'inspect', Object.keys(detail.NetworkSettings.Networks)[0]]),
        )[0].Internal,
        true,
      );
      if (recipe === 'postgres') {
        await sql(
          database,
          'create table recipe_probe(value integer);insert into recipe_probe values(17);',
        );
        await compose([
          'up',
          '--detach',
          '--wait',
          '--force-recreate',
          '--no-build',
          '--pull',
          'never',
        ]);
        const replacement = await compose(['ps', '--all', '--quiet', 'database']);
        assert.notEqual(database, replacement);
        assert.equal(await sql(replacement, 'select value from recipe_probe'), '17');
        results.push({ recipe, postgres17: true, privateDatabase: true, persistentVolume: true });
      } else {
        stage = 'Umami default login rejection';
        const env = Object.fromEntries(
          (await readFile(join(context, 'secrets/umami.env'), 'utf8'))
            .trim()
            .split('\n')
            .map((line) => {
              const split = line.indexOf('=');
              return [line.slice(0, split), line.slice(split + 1)];
            }),
        );
        const base = `http://127.0.0.1:${port}`;
        const request = async (path, { body, token } = {}) => {
          const response = await globalThis.fetch(`${base}${path}`, {
            method: body ? 'POST' : 'GET',
            headers: {
              ...(body ? { 'Content-Type': 'application/json' } : {}),
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
            signal: globalThis.AbortSignal.timeout(10_000),
          });
          if (!response.headers.get('content-type')?.includes('application/json'))
            process.stdout.write(
              JSON.stringify({ check: 'API content type', status: response.status }) + '\n',
            );
          return { status: response.status, body: await response.json() };
        };
        const defaultLogin = await request('/api/auth/login', {
          body: { username: 'admin', password: 'umami' },
        });
        process.stdout.write(
          JSON.stringify({ check: 'default login', status: defaultLogin.status }) + '\n',
        );
        assert.equal(defaultLogin.status, 401);
        stage = 'Umami generated administrator login';
        const login = await request('/api/auth/login', {
          body: { username: 'admin', password: env.RECIPE_ADMIN_PASSWORD },
        });
        assert.equal(login.status, 200);
        const token = login.body.token;
        assert.equal(typeof token, 'string');
        stage = 'Umami website creation';
        const websiteId = randomUUID();
        const site = await request('/api/websites', {
          token,
          body: { id: websiteId, name: 'Recipe fixture', domain: 'recipe.example' },
        });
        assert.equal(site.status, 200);
        assert.equal(site.body.id, websiteId);
        stage = 'Umami pageview and event collection';
        const start = Date.now() - 60_000;
        for (const name of [undefined, 'recipe-click']) {
          const event = await request('/api/send', {
            body: {
              type: 'event',
              payload: {
                website: websiteId,
                hostname: 'recipe.example',
                url: '/recipe-proof',
                screen: '1280x720',
                language: 'en-US',
                userAgent:
                  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
                ...(name ? { name } : {}),
              },
            },
          });
          assert.equal(event.status, 200);
          assert.equal(typeof event.body.sessionId, 'string');
        }
        stage = 'Umami metric verification';
        const stats = await request(
          `/api/websites/${websiteId}/stats?startAt=${start}&endAt=${Date.now() + 60_000}`,
          { token },
        );
        assert.equal(stats.status, 200);
        assert.equal(stats.body.pageviews, 1);
        assert.equal(stats.body.visitors, 1);
        assert.equal(
          await sql(
            database,
            `select count(*) from website_event where website_id='${websiteId}' and event_name='recipe-click'`,
          ),
          '1',
        );
        stage = 'Umami administrator password change';
        const changedPassword = randomUUID() + randomUUID();
        assert.equal(
          (
            await request('/api/me/password', {
              token,
              body: { currentPassword: env.RECIPE_ADMIN_PASSWORD, newPassword: changedPassword },
            })
          ).status,
          200,
        );
        stage = 'Umami restart with changed administrator password';
        await compose([
          'up',
          '--detach',
          '--wait',
          '--force-recreate',
          '--no-build',
          '--pull',
          'never',
        ]);
        assert.equal(
          (
            await request('/api/auth/login', {
              body: { username: 'admin', password: changedPassword },
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await request('/api/auth/login', {
              body: { username: 'admin', password: env.RECIPE_ADMIN_PASSWORD },
            })
          ).status,
          401,
        );
        stage = 'Umami isolated configuration with existing administrator';
        await docker(
          [
            'compose',
            '--project-name',
            project,
            '--file',
            join(context, 'isolated.json'),
            'up',
            '--detach',
            '--wait',
            '--wait-timeout',
            '180',
            '--no-build',
            '--pull',
            'never',
          ],
          210_000,
        );
        const isolatedContainer = await compose(['ps', '--all', '--quiet', 'umami']);
        const isolatedDetail = JSON.parse(
          await docker(['container', 'inspect', isolatedContainer]),
        )[0];
        assert.deepEqual(Object.keys(isolatedDetail.NetworkSettings.Networks), [
          `${project}_default`,
        ]);
        assert.equal(
          JSON.parse(await docker(['network', 'inspect', `${project}_default`]))[0].Internal,
          true,
        );
        // Read the isolated listener from its container; never put the password in argv.
        const verification = exec(
          'docker',
          [
            'exec',
            '-i',
            isolatedContainer,
            'node',
            '-e',
            "let body='';process.stdin.on('data',b=>body+=b);process.stdin.on('end',async()=>{const r=await fetch('http://127.0.0.1:3000/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body});process.stdout.write(String(r.status))})",
          ],
          { timeout: 10_000, maxBuffer: 4096 },
        );
        verification.child.stdin.end(
          JSON.stringify({ username: 'admin', password: changedPassword }),
        );
        assert.equal((await verification).stdout, '200');
        results.push({
          recipe,
          initialDefaultLoginDenied: true,
          operatorPasswordPreserved: true,
          isolatedStartupVerified: true,
          pageviews: 1,
          visitors: 1,
          customEvents: 1,
        });
      }
    } finally {
      await cleanup(project);
    }
  }
  passed = true;
} catch {
  process.exitCode = 1;
  process.stderr.write(JSON.stringify({ error: 'Recipe smoke failed.', stage }) + '\n');
} finally {
  await rm(directory, { recursive: true, force: true });
}
process.stdout.write(
  JSON.stringify({
    passed,
    results,
    isolatedBackupConfig: passed,
    ownerOnlySecrets: passed,
    temporaryFilesRemoved: true,
  }) + '\n',
);

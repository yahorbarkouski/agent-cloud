import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';

export async function verifyPackagedGateway({ image, docker }) {
  const project = `acld-gateway-${randomUUID()}`;
  const directory = await mkdtemp(join(tmpdir(), 'acld-gateway-'));
  const composeFile = join(directory, 'compose.json');
  const fixture = fileURLToPath(new URL('./gateway-container-fixture.mjs', import.meta.url));
  let admitted = false;
  let stage = 'ownership';
  const compose = (args) =>
    docker(['compose', '--project-name', project, '-f', composeFile, ...args]);
  async function owned(kind) {
    return docker([
      kind,
      'ls',
      ...(kind === 'container' ? ['--all'] : []),
      '--quiet',
      '--filter',
      `label=com.docker.compose.project=${project}`,
    ]);
  }
  const state = async (mode = 'state') =>
    JSON.parse(await compose(['exec', '-T', 'fixture', 'node', '/fixture.mjs', mode]));
  async function eventually(work) {
    let latest;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        return await work();
      } catch (error) {
        latest = error;
      }
      await delay(500);
    }
    throw latest;
  }
  async function cleanup() {
    let cleaned = !admitted;
    try {
      if (admitted) {
        await compose(['--profile', 'setup', 'down', '--volumes', '--remove-orphans']);
        for (const kind of ['container', 'network', 'volume']) assert.equal(await owned(kind), '');
        cleaned = true;
        process.stdout.write(
          JSON.stringify({ gatewayProject: project, cleanupVerified: true }) + '\n',
        );
      }
    } catch {
      process.stderr.write(
        JSON.stringify({ gatewayProject: project, cleanupVerified: false, composeFile }) + '\n',
      );
      throw new Error(
        'Gateway fixture cleanup is incomplete; retained Compose file identifies its exact resources.',
      );
    } finally {
      if (cleaned) await rm(directory, { recursive: true, force: true });
    }
  }

  try {
    for (const kind of ['container', 'network', 'volume']) assert.equal(await owned(kind), '');
    const common = {
      image,
      pull_policy: 'never',
      init: true,
      read_only: true,
      user: '1000:1000',
      tmpfs: ['/tmp:size=64m,mode=1777'],
      cap_drop: ['ALL'],
      security_opt: ['no-new-privileges:true'],
      pids_limit: 128,
      mem_limit: '256m',
      cpus: 1,
      logging: { driver: 'local', options: { 'max-size': '1m', 'max-file': '2' } },
    };
    const fixtureMount = `${fixture}:/fixture.mjs:ro`;
    await writeFile(
      composeFile,
      JSON.stringify({
        services: {
          initialize: {
            ...common,
            profiles: ['setup'],
            entrypoint: ['node', '/fixture.mjs'],
            command: ['initialize'],
            volumes: [fixtureMount, 'fixture-data:/work/.local', 'gateway-data:/run/agent-cloud'],
          },
          fixture: {
            ...common,
            entrypoint: ['node', '/fixture.mjs'],
            command: ['serve'],
            volumes: [fixtureMount, 'fixture-data:/work/.local'],
            ports: ['127.0.0.1::8444'],
            healthcheck: {
              test: ['CMD', 'node', '/fixture.mjs', 'state'],
              interval: '1s',
              timeout: '3s',
              retries: 30,
            },
          },
          gateway: {
            ...common,
            command: ['public-gateway'],
            environment: { ACLD_PUBLIC_GATEWAY_CONFIG: '/run/agent-cloud/controller.json' },
            network_mode: 'service:fixture',
            volumes: ['gateway-data:/run/agent-cloud'],
            depends_on: { fixture: { condition: 'service_healthy' } },
          },
        },
        volumes: { 'fixture-data': {}, 'gateway-data': {} },
        networks: { default: {} },
      }) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    admitted = true;
    stage = 'private fixture initialization';
    await compose(['run', '--rm', '--no-deps', 'initialize']);
    stage = 'fixture startup';
    await compose(['up', '--detach', '--wait', 'fixture']);
    stage = 'production gateway startup';
    await compose(['up', '--detach', '--wait', 'gateway']);
    stage = 'Caddy executable';
    const caddy = await compose(['exec', '-T', 'gateway', 'caddy', 'version']);
    assert.match(caddy, /^v2\.11\.4\b/);
    stage = 'published HTTPS address';
    const address = await compose(['port', 'fixture', '8444']);
    assert.match(address, /^127\.0\.0\.1:\d+$/);
    const port = Number(address.split(':')[1]);
    const caPath = '/run/agent-cloud/state/certificates/pki/authorities/local/root.crt';
    const readCa = () => compose(['exec', '-T', 'gateway', 'cat', caPath]);
    stage = 'first route and public CA';
    const ca = await eventually(async () => {
      assert.ok((await state()).acks > 0);
      const pem = await readCa();
      assert.match(pem, /BEGIN CERTIFICATE/);
      return pem;
    });
    function https({ hostname = 'app.fixture.test', servername = 'app.fixture.test' } = {}) {
      return new Promise((resolve, reject) => {
        const call = request(
          {
            hostname: '127.0.0.1',
            port,
            servername,
            ca,
            method: 'GET',
            path: '/data',
            headers: { Host: hostname, 'X-Agent-Cloud-Route-Version': '999' },
          },
          (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
              body += chunk;
              if (body.length > 4096) response.destroy(new Error('Fixture reply too large.'));
            });
            response.on('error', reject);
            response.on('end', () => resolve({ status: response.statusCode, body }));
          },
        );
        call.on('error', reject);
        call.setTimeout(5000, () => call.destroy(new Error('Fixture HTTPS timed out.')));
        call.end();
      });
    }
    const readApplication = () =>
      eventually(async () => {
        const response = await https();
        assert.equal(response.status, 200);
        assert.deepEqual(JSON.parse(response.body), { count: 42 });
      });
    stage = 'trusted public HTTPS through mTLS upstream';
    await readApplication();
    const beforeForeign = (await state()).upstreamRequests;
    const foreign = await https({ hostname: 'foreign.fixture.test' });
    assert.ok([404, 421].includes(foreign.status));
    await assert.rejects(
      https({ hostname: 'foreign.fixture.test', servername: 'foreign.fixture.test' }),
    );
    assert.equal((await state()).upstreamRequests, beforeForeign);
    stage = 'API outage with retained application routing';
    await state('outage');
    await delay(2500);
    await readApplication();
    const acknowledged = (await state()).acks;
    stage = 'gateway restart while API remains unavailable';
    await compose(['restart', 'gateway']);
    await readApplication();
    assert.equal(await readCa(), ca);
    assert.equal((await state()).acks, acknowledged);
    stage = 'control API recovery';
    await state('recover');
    await eventually(async () => assert.ok((await state()).acks > acknowledged));
    await readApplication();
    return {
      packagedGateway: true,
      caddy: '2.11.4',
      trustedHttps: true,
      mutualTlsUpstream: true,
      authoritativeRouteHeader: true,
      foreignHostRejected: true,
      retainedAcrossRestartAndApiOutage: true,
      publicCaDigest: createHash('sha256').update(ca).digest('hex'),
      providerProof: false,
    };
  } catch (error) {
    let diagnostics;
    if (admitted) {
      const output = await compose(['ps', '--all', '--format', 'json']).catch(() => '');
      diagnostics = output
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            const row = JSON.parse(line);
            return [
              {
                service: row.Service,
                state: row.State,
                health: row.Health,
                exitCode: row.ExitCode,
              },
            ];
          } catch {
            return [];
          }
        });
    }
    throw Object.assign(new Error('Packaged gateway verification failed.', { cause: error }), {
      fixtureFailure: {
        gatewayStage: stage,
        type: error.name,
        exitCode: error.fixtureFailure?.exitCode,
        missingHealthcheck: /no healthcheck/i.test(error.cause?.stderr ?? ''),
        portUnavailable: /no port|no public port|not published/i.test(error.cause?.stderr ?? ''),
        diagnostics,
      },
    });
  } finally {
    await cleanup();
  }
}

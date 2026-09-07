import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { serve } from '@hono/node-server';
import { z } from 'zod';
import { referenceResponseSchema, type MachineId } from '../../packages/contracts/dist/index.js';
import type { createApp } from '../../apps/control/src/app.js';

/** Actual CLI -> authenticated API -> native SSH -> systemd -> Docker Compose on the owned local VM. */
export async function exerciseReferenceScenario(input: {
  app: ReturnType<typeof createApp>;
  machineId: MachineId;
  token: string;
  scratch: string;
  address: string;
  vm: (args: string[], timeout?: number) => Promise<string>;
}) {
  const server = serve({ fetch: input.app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected local API port.');
  const url = `http://127.0.0.1:${address.port}`;
  const credentials = join(input.scratch, 'reference.credentials.json');
  const cli = (args: string[], stdin = '') =>
    new Promise<unknown>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        ['apps/cli/dist/index.js', ...args],
        {
          env: { ...process.env, ACLD_CREDENTIALS: credentials },
          timeout: 90_000,
          maxBuffer: 131_072,
        },
        (error, stdout, stderr) => {
          if (error) reject(new Error(`Reference CLI failed: ${stderr.slice(0, 2000)}`));
          else {
            try {
              resolve(JSON.parse(stdout));
            } catch {
              reject(new Error('Reference CLI returned invalid JSON.'));
            }
          }
        },
      );
      child.stdin?.on('error', () => {});
      child.stdin?.end(stdin);
    });
  const inspect = async () =>
    referenceResponseSchema.parse(await cli(['internal', 'reference', 'inspect', input.machineId]));
  const wait = async (releaseId: string) => {
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline) {
      const result = await inspect();
      if (result.state.kind === 'release' && result.state.release.releaseId === releaseId) {
        if (result.state.phase === 'failed')
          throw new Error('Reference deployment failed on the VM.');
        if (result.state.phase === 'succeeded') return result;
      }
      await setTimeout(3000);
    }
    throw new Error('Reference deployment did not finish before the local deadline.');
  };
  let ca = '';
  const application = (path: string, method = 'GET') =>
    new Promise<string>((resolve, reject) => {
      const req = request(
        {
          hostname: input.address,
          port: 443,
          servername: 'reference.localhost',
          ca,
          path,
          method,
          headers: { Host: 'reference.localhost', Origin: 'https://reference.localhost' },
          timeout: 10_000,
        },
        (response) => {
          let body = '';
          response.on('data', (chunk: Buffer) => {
            body += chunk.toString();
            if (body.length > 65_536)
              response.destroy(new Error('Oversized application response.'));
          });
          response.once('error', reject);
          response.once('end', () => {
            if (response.statusCode === 200) resolve(body);
            else reject(new Error(`Application HTTP ${String(response.statusCode)}`));
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('Application request timed out.')));
      req.once('error', reject);
      req.end();
    });
  try {
    await cli(['login', '--server', url, '--token-stdin'], input.token);
    const first = randomUUID();
    const apply = [
      'internal',
      'reference',
      'apply',
      input.machineId,
      '--release',
      first,
      '--revision',
      '1',
    ];
    referenceResponseSchema.parse(await cli(apply));
    // The first CLI has exited. No SSH connection keeps application work alive.
    const deployed = await wait(first);
    assert.match(deployed.output, /backend/);
    ca = await input.vm([
      'docker',
      'compose',
      '-p',
      'agent-cloud-reference',
      '-f',
      `/var/lib/agent-cloud/reference/releases/${first}/compose.json`,
      'exec',
      '-T',
      'frontend',
      'cat',
      '/data/caddy/pki/authorities/local/root.crt',
    ]);
    assert.match(await application('/'), /Your application is running/);
    const countSchema = z.object({
      revision: z.enum(['1', '2']),
      count: z.string().regex(/^\d+$/),
    });
    const recorded = countSchema.parse(JSON.parse(await application('/api/visits', 'POST')));
    assert.equal(recorded.revision, '1');
    assert.equal(recorded.count, '1');
    await cli(apply);
    assert.equal(countSchema.parse(JSON.parse(await application('/api/visits'))).count, '1');
    const logs = referenceResponseSchema.parse(
      await cli(['internal', 'reference', 'logs', input.machineId]),
    );
    assert.match(logs.output, /reference_ready/);
    assert.match(logs.output, /visit_recorded/);
    const second = randomUUID();
    await cli([
      'internal',
      'reference',
      'apply',
      input.machineId,
      '--release',
      second,
      '--revision',
      '2',
      '--expected-release',
      first,
    ]);
    await wait(second);
    assert.deepEqual(countSchema.parse(JSON.parse(await application('/api/visits'))), {
      revision: '2',
      count: '1',
    });
    assert.match(await application('/'), /Release 2/);
    // Read through a fresh process again after every deployment connection has ended.
    assert.equal((await inspect()).state.kind, 'release');
    process.stdout.write(
      JSON.stringify({
        result: 'reference-locally-verified',
        provider: 'simulated',
        vm: 'native Ubuntu',
        https: 'verified local Caddy CA',
        cliDisconnected: true,
        updatePreservedData: true,
        releases: [first, second],
      }) + '\n',
    );
  } finally {
    if ('closeAllConnections' in server) server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
}

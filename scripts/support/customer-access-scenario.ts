import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connect } from 'node:net';
import { once } from 'node:events';
import { serve } from '@hono/node-server';
import { run } from 'graphile-worker';
import { z } from 'zod';
import { grantIdSchema } from '../../packages/contracts/dist/index.js';
import { createAccessService } from '../../apps/control/src/access-sessions.js';
import { createApp } from '../../apps/control/src/app.js';
import { createTasks } from '../../apps/control/src/tasks.js';
import { createAccessGateway } from '../../apps/access-gateway/src/server.js';
import { hashToken } from '../../apps/control/src/auth.js';
import type { Connection } from '../../packages/db/src/index.js';
import type { CustomerSshSigner, Signer } from '../../packages/pki/dist/index.js';
import type { prepareEnrollmentFixture } from './enrollment-fixture.js';
import { exerciseDurableRuns } from './durable-runs-scenario.js';
import { exerciseCompose } from './compose-scenario.js';
import { prepareHostingFixture } from './hosting-fixture.js';
import { exerciseHosting } from './hosting-scenario.js';
import { exerciseBackups } from './backup-scenario.js';
import { prepareBackupStoreFixture } from './backup-store-fixture.js';
import type { NativeBackupTarget } from './backup-target-fixture.js';
import { createGuestProbe } from '../../packages/remote/dist/index.js';
import { createGuestReadiness } from '../../apps/control/src/guest-readiness.js';
import { prepareGuestBootstrap } from '../../apps/control/src/guest-bootstrap.js';
import type { GuestProvisioning } from '../../apps/control/src/advance-operation.js';

/** Actual CLI, Graphile worker, gateway, native SSH/SFTP and owned Ubuntu guest. No paid provider. */
export async function exerciseCustomerAccess(input: {
  connection: Connection;
  fixture: Awaited<ReturnType<typeof prepareEnrollmentFixture>>;
  signer: CustomerSshSigner;
  controlSigner: Signer;
  scratch: string;
  address: string;
  reboot: () => Promise<void>;
  vm: (args: string[], timeout?: number) => Promise<string>;
  nativeTarget?: NativeBackupTarget;
}) {
  const f = input.fixture;
  if (input.nativeTarget) {
    f.limits.maxMachines = 2;
    f.setProvisionGuest(input.nativeTarget.provision);
  }
  // OrbStack's host alias is an inbound forwarding address, not the host's SSH egress.
  // Observe one fresh TCP peer at the guest and fail if the fixture is not isolated.
  const probe = connect({ host: z.ipv4().parse(input.address), port: 22 });
  let hostAddress: string;
  try {
    await once(probe, 'connect', { signal: AbortSignal.timeout(5000) });
    const peers = (await input.vm(['ss', '-Htn', 'state', 'established', 'sport = :22']))
      .trim()
      .split('\n');
    assert.equal(peers.length, 1, 'Expected exactly one SSH peer in the owned fixture.');
    hostAddress = z.ipv4().parse(peers[0]?.trim().split(/\s+/)[3]?.split(':')[0]);
  } finally {
    probe.destroy();
  }
  let handle: (request: Request) => Response | Promise<Response> = () =>
    new Response(null, { status: 503 });
  let available = true;
  const server = serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => (available ? handle(request) : new Response(null, { status: 503 })),
  });
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing customer API port.');
  const controlUrl = `http://127.0.0.1:${address.port}`;
  const token = `aclg_${randomBytes(32).toString('base64url')}`;
  const gateway = createAccessGateway({ controlUrl, token, port: 0 });
  await gateway.listen();
  const gatewayAddress = gateway.server.address();
  if (!gatewayAddress || typeof gatewayAddress === 'string')
    throw new Error('Missing gateway port.');
  const access = createAccessService({
    connection: input.connection,
    provider: f.provider,
    config: {
      tokenHash: hashToken(token),
      gateway: {
        id: 'local-native',
        origin: `ws://127.0.0.1:${gatewayAddress.port}`,
        egressCidrs: [`${hostAddress}/32`],
      },
    },
    signer: () => Promise.resolve(input.signer),
    checkNetwork: async () => {},
  });
  const hosting =
    process.env.AGENT_CLOUD_HOSTING_SCENARIO === '1' || input.nativeTarget
      ? await prepareHostingFixture({
          connection: input.connection,
          provider: f.provider,
          signer: input.controlSigner,
          scratch: input.scratch,
          controlUrl,
        })
      : undefined;
  const backup = input.nativeTarget
    ? await prepareBackupStoreFixture({
        connection: input.connection,
        provider: f.provider,
        signer: input.controlSigner,
        scratch: input.scratch,
      })
    : undefined;
  const app = createApp({
    db: input.connection.db,
    provider: f.provider.kind,
    catalog: f.catalog,
    limits: f.limits,
    access,
    ...(backup ? { backups: backup.runtime.service } : {}),
    ...(hosting
      ? { hosting: { service: hosting.runtime.service, gatewayToken: hosting.gatewayToken } }
      : {}),
  });
  handle = (request) => app.fetch(request);
  const worker = await run({
    ...(process.env.AGENT_CLOUD_BACKUP_SCHEDULE_SCENARIO === '1'
      ? { crontab: '* * * * * reconcile_operations' }
      : {}),
    pgPool: input.connection.pool,
    concurrency: 2,
    pollInterval: 100,
    taskList: createTasks({
      connection: input.connection,
      provider: f.provider,
      limits: f.limits,
      access,
      ...(backup
        ? {
            backups: backup.runtime.service,
            guest: {
              kind: 'enabled',
              resolveImage: () => Promise.resolve(f.image),
              prepareBootstrap: (tx, context) =>
                prepareGuestBootstrap(tx, {
                  ...context,
                  seal: f.seal,
                  enrollmentUrl: f.enrollmentUrl,
                }),
              runtime: createGuestReadiness({
                provider: f.provider,
                signer: input.controlSigner,
                probe: createGuestProbe(),
              }),
            } satisfies GuestProvisioning,
          }
        : {}),
      ...(hosting ? { hosting: hosting.runtime.service } : {}),
    }),
  });
  const ownerFile = join(input.scratch, 'ssh-owner.json');
  const agentFile = join(input.scratch, 'ssh-agent.json');
  const cli = (args: string[], credentials = ownerFile, stdin = '', ready?: () => void) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        ['apps/cli/dist/index.js', ...args],
        {
          env: { ...process.env, ACLD_CREDENTIALS: credentials },
          timeout: backup
            ? 960_000
            : process.env.AGENT_CLOUD_COMPOSE_SCENARIO === '1' || hosting
              ? 330_000
              : 100_000,
          maxBuffer: 262_144,
        },
        (error, stdout, stderr) => {
          if (
            stdout.includes(f.account.token) ||
            stderr.includes(f.account.token) ||
            stdout.includes(token) ||
            stderr.includes(token)
          ) {
            reject(new Error('Credential leaked into CLI output.'));
            return;
          }
          resolve({ code: error ? 1 : 0, stdout, stderr });
        },
      );
      let announced = false;
      child.stdout?.on('data', (chunk: Buffer) => {
        if (!announced && chunk.toString().includes('session_ready')) {
          announced = true;
          ready?.();
        }
      });
      child.stdin?.on('error', () => {});
      child.stdin?.end(stdin);
    });
  const success = async (args: string[], credentials = ownerFile, stdin = '') => {
    const result = await cli(args, credentials, stdin);
    assert.equal(result.code, 0, result.stderr.slice(0, 3000));
    return result.stdout;
  };
  const machine = f.operation.machineId;
  async function closeLongSession(credentials: string, interrupt: () => Promise<void>) {
    const announced = Promise.withResolvers<boolean>();
    const result = cli(
      ['ssh', machine, '--', "printf 'session_ready\\n'; sleep 60"],
      credentials,
      '',
      () => {
        announced.resolve(true);
      },
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        announced.promise,
        result.then((value) => {
          if (!value.stdout.includes('session_ready'))
            throw new Error(`SSH did not start: ${value.stderr.slice(0, 2000)}`);
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new Error('Native SSH did not announce readiness.'));
          }, 30_000);
        }),
      ]);
      const started = performance.now();
      await interrupt();
      const closed = await result;
      assert.notEqual(closed.code, 0);
      const elapsedMs = performance.now() - started;
      assert.ok(elapsedMs < 18_000, `SSH authority closure took ${elapsedMs}ms`);
      return Math.round(elapsedMs);
    } finally {
      clearTimeout(timeout);
    }
  }
  try {
    hosting?.start();
    await success(['login', '--server', controlUrl, '--token-stdin'], ownerFile, f.account.token);
    const policy = {
      ...f.account.principal.policy,
      capabilities: [
        'machine:read',
        'machine:exec',
        ...(hosting ? ['route:publish'] : []),
        ...(backup ? ['machine:create', 'backup:read', 'backup:create', 'backup:restore'] : []),
      ],
      projects: { kind: 'selected', ids: [f.account.projectId] },
      maxMachines: backup ? 2 : 0,
      maxHourlyMicros: backup ? f.limits.maxHourlyMicros : 0,
    };
    const policyFile = join(input.scratch, 'ssh-policy.json');
    await writeFile(policyFile, JSON.stringify(policy));
    const issued = z
      .object({ grant: z.object({ id: grantIdSchema }) })
      .parse(
        JSON.parse(
          await success([
            'grant',
            'create',
            'native-customer',
            '--policy',
            policyFile,
            '--expires-at',
            new Date(Date.now() + 3_600_000).toISOString(),
            '--credentials',
            agentFile,
          ]),
        ),
      );
    if (backup && input.nativeTarget) {
      await exerciseBackups({
        machine,
        credentials: agentFile,
        ownerCredentials: ownerFile,
        scratch: input.scratch,
        address: input.address,
        vm: input.vm,
        cli,
        rotateWrappingKey: () => backup.rotateWrappingKey(),
        keyRecovery: backup.keyRecovery,
        ...(hosting
          ? { hosting: { gatewayState: hosting.gatewayState, httpsPort: hosting.httpsPort } }
          : {}),
      });
      await input.nativeTarget.cleanup();
      return;
    }
    if (hosting) {
      await exerciseHosting({
        machine,
        credentials: agentFile,
        scratch: input.scratch,
        gatewayState: hosting.gatewayState,
        httpsPort: hosting.httpsPort,
        cli,
        apiAvailable: (value) => {
          available = value;
        },
        restartGateway: hosting.restart,
        reboot: input.reboot,
      });
      return;
    }
    if (process.env.AGENT_CLOUD_COMPOSE_SCENARIO === '1') {
      await exerciseCompose({
        machine,
        credentials: agentFile,
        scratch: input.scratch,
        address: input.address,
        cli,
        vm: input.vm,
      });
      return;
    }
    if (process.env.AGENT_CLOUD_RUN_SCENARIO === '1') {
      await exerciseDurableRuns({
        machine,
        credentials: agentFile,
        ownerCredentials: ownerFile,
        scratch: input.scratch,
        cli,
        vm: input.vm,
        reboot: input.reboot,
      });
      return;
    }
    assert.equal(
      (
        await success(
          ['ssh', machine, '--', '/usr/bin/sudo', '-n', '--', '/usr/bin/id', '-u'],
          agentFile,
        )
      ).trim(),
      '0',
    );
    const source = join(input.scratch, 'source with spaces.txt');
    const destination = join(input.scratch, 'received with spaces.txt');
    const remote = '/var/lib/agent-customer/transfer with spaces.txt';
    const content = `persistent native transfer ${randomBytes(16).toString('hex')}\n`;
    await writeFile(source, content, { mode: 0o600 });
    await success(['file', 'put', machine, source, remote], agentFile);
    await success(['file', 'get', machine, remote, destination], agentFile);
    assert.equal(await readFile(destination, 'utf8'), content);
    const revocationMs = await closeLongSession(agentFile, async () => {
      await success(['grant', 'revoke', issued.grant.id]);
    });
    assert.notEqual((await cli(['ssh', machine, '--', 'true'], agentFile)).code, 0);
    const outageMs = await closeLongSession(ownerFile, () => {
      available = false;
      return Promise.resolve();
    });
    available = true;
    assert.equal(await input.vm(['cat', remote]), content);
    process.stdout.write(
      JSON.stringify({
        result: 'customer-access-locally-verified',
        provider: 'simulated',
        vm: 'native Ubuntu',
        cli: true,
        worker: true,
        gateway: true,
        nativeSsh: true,
        sftpRoundTrip: true,
        revokedCredentialDenied: true,
        revocationMs,
        outageMs,
        guestFileRetained: true,
      }) + '\n',
    );
  } finally {
    available = true;
    await hosting?.stop();
    await backup?.stop();
    await gateway.close();
    await worker.stop();
    if ('closeAllConnections' in server) server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
}

import { createInternalReference } from '../apps/control/src/internal-reference.js';
import { runReferenceCommand } from '../packages/remote/dist/index.js';
import { exerciseReferenceScenario } from './support/reference-scenario.js';
import { prepareGuestBootstrap } from '../apps/control/dist/guest-bootstrap.js';
import { imageInstallCommand } from '../packages/images/dist/index.js';
import { readGuestBuild } from './support/guest-build.js';
import { prepareVmSeedFixture } from './support/vm-seed.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:https';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { getRequestListener } from '@hono/node-server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import {
  guestImageSchema,
  guestSubject,
  guestManifestSchema,
  guestProofSchema,
  operationResponseSchema,
  type OperationId,
} from '../packages/contracts/dist/index.js';
import { machines, operations, machineRecord } from '../packages/db/src/index.js';
import { createSigner, guestName } from '../packages/pki/dist/index.js';
import { createGuestProbe } from '../packages/remote/dist/index.js';
import { createApp } from '../apps/control/src/app.js';
import { createGuestRenewalService } from '../apps/control/src/guest-renewal.js';
import { createEnrollmentService } from '../apps/control/src/guest-enrollment.js';
import { createGuestReadiness } from '../apps/control/src/guest-readiness.js';
import { advanceOperation } from '../apps/control/src/advance-operation.js';
import { readPrivateFile } from '../apps/control/src/private-file.js';
import { testDatabase } from '../tests/database.js';
import { prepareEnrollmentFixture } from './support/enrollment-fixture.js';
import { readImageBuilder, imageReceiptSchema } from './support/image-builder.js';

const ownershipPath = resolve('.local/guest-image-machine.json');
const ownerSchema = z.object({
  purpose: z.literal('agent-cloud-local-image-validation'),
  name: z.string().regex(/^agent-cloud-image-[0-9a-f]{8}$/),
  builderId: z.uuid(),
  architecture: z.literal('amd64'),
  distribution: z.literal('ubuntu:noble'),
});
const infoSchema = z.object({
  record: z.object({
    id: z.string(),
    name: z.string(),
    builtin: z.literal(false),
    image: z.object({
      distro: z.literal('ubuntu'),
      version: z.literal('noble'),
      arch: z.literal('amd64'),
    }),
  }),
  ip4: z.ipv4(),
});
const progress = (phase: string) =>
  process.stdout.write(JSON.stringify({ phase, cloudResourcesCreated: 0 }) + '\n');
async function command(binary: string, args: string[], timeout = 30_000) {
  try {
    return (
      await promisify(execFile)(binary, args, { timeout, killSignal: 'SIGKILL', maxBuffer: 65_536 })
    ).stdout;
  } catch {
    throw new Error(`Local VM tooling failed: ${binary}. Inspect the owned VM status files.`);
  }
}
const guestBuild = await readGuestBuild();
await mkdir('.local', { recursive: true, mode: 0o700 });
const clone = process.env.AGENT_CLOUD_SANITIZED_IMAGE === '1';
let owner;
try {
  owner = ownerSchema.parse(JSON.parse(await readPrivateFile(ownershipPath)));
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  owner = ownerSchema.parse({
    purpose: 'agent-cloud-local-image-validation',
    name: `agent-cloud-image-${randomUUID().slice(0, 8)}`,
    builderId: randomUUID(),
    architecture: 'amd64',
    distribution: 'ubuntu:noble',
  });
  // Record intent before creation so an interrupted run remains discoverable.
  await writeFile(ownershipPath, JSON.stringify(owner) + '\n', { mode: 0o600, flag: 'wx' });
  if (clone) {
    const source = await readImageBuilder();
    assert.equal(source.phase, 'sanitized', 'The recorded image builder is not sanitized.');
    const sourceInfo = z
      .object({ record: infoSchema.shape.record.extend({ state: z.literal('stopped') }) })
      .parse(JSON.parse(await command('orb', ['info', source.name, '--format', 'json'])));
    assert.equal(sourceInfo.record.name, source.name);
    await command('orb', ['clone', source.name, owner.name], 120_000);
    await command('orb', ['start', owner.name], 120_000);
  } else
    await command(
      'orb',
      ['create', '--arch', 'amd64', '--user', 'agent-cloud-build', 'ubuntu:noble', owner.name],
      180_000,
    );
}
async function runningInfo(name: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const value: unknown = JSON.parse(await command('orb', ['info', name, '--format', 'json']));
    const metadata = z.object({ record: infoSchema.shape.record }).parse(value);
    assert.equal(metadata.record.name, name);
    const result = infoSchema.safeParse(value);
    if (result.success) return result.data;
    await setTimeout(1000);
  }
  throw new Error('Owned guest did not receive an IPv4 address before the local deadline.');
}
const info = await runningInfo(owner.name);
assert.equal(info.record.name, owner.name);
const vm = (args: string[], timeout?: number) =>
  command('orb', ['run', '-m', owner.name, '-u', 'root', '-w', '/tmp', ...args], timeout);
const scratch = await mkdtemp(resolve('.local/guest-smoke-'));
const database = await testDatabase();
let server: ReturnType<typeof createServer> | undefined;
try {
  // Refuse to overwrite an allocation, even in the owned fixture VM.
  await vm([
    '/bin/sh',
    '-c',
    'test ! -e /var/lib/agent-cloud/keys && test ! -e /var/lib/agent-cloud/bootstrap.json && test ! -e /var/lib/agent-cloud/guest.json',
  ]);
  if (clone) {
    progress('booting clone of recorded sanitized image');
    const receipt = imageReceiptSchema.parse(
      JSON.parse(await vm(['cat', '/usr/lib/agent-cloud/image-build.json'])),
    );
    assert.equal(receipt.builderId, (await readImageBuilder()).builderId);
  } else {
    progress('installing owned local Ubuntu VM');
    await vm(['rm', '-rf', '/tmp/agent-cloud-input']);
    await vm(['cp', '-R', '/mnt/mac' + guestBuild.directory, '/tmp/agent-cloud-input']);
    await vm(
      imageInstallCommand({
        directory: '/tmp/agent-cloud-input',
        builderId: owner.builderId,
        manifestDigest: guestBuild.manifestDigest,
        checksumDigest: guestBuild.checksumDigest,
      }),
      600_000,
    );
    await prepareVmSeedFixture(vm);
    imageReceiptSchema.parse(
      JSON.parse(await vm(['/usr/local/bin/guestctl', 'prepare-image', '--json'], 120_000)),
    );
    await command('orb', ['restart', owner.name], 120_000);
  }
  const step = resolve('.local/tools/step-0.30.6');
  await command('env', [
    'STEPPATH=' + scratch,
    step,
    'ca',
    'certificate',
    'host.orb.internal',
    join(scratch, 'api.crt'),
    join(scratch, 'api.key'),
    '--ca-url',
    'https://localhost:9449',
    '--root',
    resolve('.local/pki/public/root_ca.crt'),
    '--provisioner',
    'agent-cloud-control',
    '--provisioner-password-file',
    resolve('.local/pki/provisioner-password'),
    '--kty',
    'EC',
    '--curve',
    'P-256',
    '--not-after',
    '1h',
  ]);
  await chmod(join(scratch, 'api.key'), 0o600);
  const signer = createSigner({
    binary: step,
    caUrl: 'https://localhost:9449',
    tlsRoot: await readFile('.local/pki/public/root_ca.crt', 'utf8'),
    sshHostCa: (await readFile('.local/pki/public/ssh_host_ca_key.pub', 'utf8')).trim(),
    sshUserCa: (await readFile('.local/pki/public/ssh_user_ca_key.pub', 'utf8')).trim(),
    provisioner: 'agent-cloud-control',
    provisionerPassword: await readPrivateFile(resolve('.local/pki/provisioner-password')),
  });
  let handle: (input: Request) => Response | Promise<Response> = () =>
    new Response(null, { status: 503 });
  const listener = getRequestListener((input) => handle(input));
  server = createServer(
    {
      key: await readFile(join(scratch, 'api.key')),
      cert: await readFile(join(scratch, 'api.crt')),
    },
    (request, response) => {
      void listener(request, response).catch(() => {
        response.destroy();
      });
    },
  );
  await new Promise<void>((resolve) => server?.listen(0, '::', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected local HTTPS port.');
  const manifest = guestManifestSchema.parse(
    JSON.parse(await readFile(guestBuild.directory + '/image.json', 'utf8')),
  );
  const image = guestImageSchema.parse({
    providerImage: 'orbstack-local-ubuntu',
    version: manifest.version,
    architecture: manifest.architecture,
    manifestDigest: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    ...manifest.trust,
  });
  if (clone) {
    const receipt = imageReceiptSchema.parse(
      JSON.parse(await vm(['cat', '/usr/lib/agent-cloud/image-build.json'])),
    );
    assert.equal(receipt.manifestDigest, image.manifestDigest);
  }
  const fixture = await prepareEnrollmentFixture({
    connection: database.connection,
    image,
    address: info.ip4,
    enrollmentUrl: `https://host.orb.internal:${address.port}/guest/enroll`,
  });
  const probe = createGuestProbe();
  const runtime = createGuestReadiness({ provider: fixture.provider, signer, probe });
  const tick = (operationId: OperationId = fixture.operation.id) =>
    advanceOperation({
      connection: database.connection,
      operationId,
      provider: fixture.provider,
      limits: fixture.limits,
      guest: {
        kind: 'enabled',
        resolveImage: () => Promise.resolve(image),
        prepareBootstrap: (tx, input) =>
          prepareGuestBootstrap(tx, {
            ...input,
            seal: fixture.seal,
            enrollmentUrl: fixture.bootstrap.spec.enrollmentUrl,
          }),
        runtime,
      },
    });
  const operationProgress = async (operationId: OperationId = fixture.operation.id) =>
    (
      await database.connection.db.select().from(operations).where(eq(operations.id, operationId))
    )[0]?.progress;
  const enrollment = createEnrollmentService({
    connection: database.connection,
    seal: fixture.seal,
    signer,
    probe,
    provider: fixture.provider,
  });
  const app = createApp({
    db: database.connection.db,
    provider: fixture.provider.kind,
    limits: fixture.limits,
    catalog: fixture.catalog,
    enrollment,
    ...(process.env.AGENT_CLOUD_REFERENCE_SCENARIO === '1'
      ? {
          internalReference: createInternalReference({
            connection: database.connection,
            provider: fixture.provider,
            grantId: fixture.account.principal.grantId,
            signer: () => Promise.resolve(signer),
            remote: (input) =>
              runReferenceCommand({
                ...input,
                command:
                  input.command.kind === 'apply'
                    ? { ...input.command, hostname: 'reference.localhost' }
                    : input.command,
              }),
          }),
        }
      : {}),
    renewal: createGuestRenewalService({
      connection: database.connection,
      signer,
      probe,
      provider: fixture.provider,
    }),
  });
  handle = (input) =>
    ['/guest/enroll', '/guest/renew'].includes(new URL(input.url).pathname)
      ? app.fetch(input)
      : new Response(null, { status: 404 });
  await writeFile(join(scratch, 'user-data'), fixture.userData, { mode: 0o600 });
  await writeFile(
    join(scratch, 'meta-data'),
    JSON.stringify({
      'instance-id': fixture.bootstrap.spec.allocationId,
      'local-hostname': 'agent-cloud-guest-fixture',
    }),
    { mode: 0o600 },
  );
  await vm(['install', '-d', '-m', '0700', '/var/lib/cloud/seed/nocloud']);
  for (const file of ['user-data', 'meta-data'])
    await vm([
      'install',
      '-m',
      '0600',
      '/mnt/mac' + join(scratch, file),
      '/var/lib/cloud/seed/nocloud/' + file,
    ]);
  // OrbStack owns fixture networking and disk sizing; keep both provider defaults in production.
  await writeFile(
    join(scratch, 'datasource.cfg'),
    'datasource_list: [NoCloud]\nnetwork:\n  config: disabled\ngrowpart:\n  mode: "off"\nresize_rootfs: false\n',
    { mode: 0o600 },
  );
  await vm([
    'install',
    '-m',
    '0600',
    '/mnt/mac' + join(scratch, 'datasource.cfg'),
    '/etc/cloud/cloud.cfg.d/91-agent-cloud-smoke.cfg',
  ]);
  progress('booting actual cloud-init and systemd enrollment');
  await vm(['cloud-init', 'schema', '--config-file', '/var/lib/cloud/seed/nocloud/user-data']);
  await command('orb', ['restart', owner.name], 120_000);
  const deadline = Date.now() + 180_000;
  let enrolled = false;
  while (Date.now() < deadline) {
    const status = await vm([
      '/bin/sh',
      '-c',
      'if test -f /var/lib/agent-cloud/enrollment-status.json; then cat /var/lib/agent-cloud/enrollment-status.json; else printf "{}"; fi',
    ]);
    if (z.object({ phase: z.literal('enrolled') }).safeParse(JSON.parse(status)).success) {
      enrolled = true;
      break;
    }
    await setTimeout(2000);
  }
  assert.ok(enrolled, 'Guest did not complete enrollment before the local deadline.');
  await vm(['systemctl', 'is-active', '--quiet', 'systemd-random-seed.service']);
  await vm(['test', '-s', '/var/lib/systemd/random-seed']);
  progress('verifying real SSH, Caddy and bootstrap cleanup');
  const proof = guestProofSchema.parse(
    JSON.parse(await vm(['/usr/local/bin/guestctl', 'identity', '--json'])),
  );
  assert.equal(proof.allocationId, fixture.bootstrap.spec.allocationId);
  assert.equal(proof.manifestDigest, image.manifestDigest);
  assert.deepEqual(
    await probe.readIdentity({
      subject: guestSubject(proof),
      address: info.ip4,
      credential: await signer.issueProbeCredential(guestSubject(proof)),
      trust: { kind: 'host_ca', publicKey: signer.trust.sshHostCa },
    }),
    proof,
  );
  assert.equal(
    (await vm(['systemctl', 'is-active', 'agent-cloud-proxy.service'])).trim(),
    'active',
  );
  assert.equal(
    (await vm(['docker', 'version', '--format', '{{.Server.Version}}'])).trim(),
    manifest.components.docker,
  );
  const health = z.object({
    allocationId: z.literal(proof.allocationId),
    imageVersion: z.literal(image.version),
  });
  health.parse(JSON.parse(await vm(['curl', '--fail', '--silent', 'http://127.0.0.1:8081/ready'])));
  if (process.env.AGENT_CLOUD_REFERENCE_SCENARIO === '1') {
    for (let attempt = 0; attempt < 10; attempt++) {
      await tick();
      if (z.object({ kind: z.literal('succeeded') }).safeParse(await operationProgress()).success)
        break;
      await setTimeout(1000);
    }
    assert.partialDeepStrictEqual(await operationProgress(), { kind: 'succeeded' });
    await exerciseReferenceScenario({
      app,
      machineId: fixture.operation.machineId,
      token: fixture.account.token,
      scratch,
      address: info.ip4,
      vm,
    });
  } else {
    progress('verifying renewal timer and certificate reload preserve proxy configuration');
    await vm(['systemctl', 'is-enabled', '--quiet', 'agent-cloud-renew.timer']);
    await vm(['systemctl', 'is-active', '--quiet', 'agent-cloud-renew.timer']);
    const proxyConfiguration = await vm(['cat', '/var/lib/agent-cloud/caddy.json']);
    await vm(['systemctl', 'start', 'agent-cloud-renew.service']);
    assert.equal(
      (
        await vm(['systemctl', 'show', '--property=Result', '--value', 'agent-cloud-renew.service'])
      ).trim(),
      'success',
    );
    assert.equal(await vm(['cat', '/var/lib/agent-cloud/caddy.json']), proxyConfiguration);
    health.parse(
      JSON.parse(await vm(['curl', '--fail', '--silent', 'http://127.0.0.1:8081/ready'])),
    );
    progress('testing restricted runtime inspection and unhealthy services');
    await assert.rejects(
      vm([
        '/usr/sbin/runuser',
        '-u',
        'agent-probe',
        '--',
        '/usr/bin/sudo',
        '-n',
        '--',
        '/usr/bin/id',
      ]),
    );
    await assert.rejects(
      vm([
        '/usr/sbin/runuser',
        '-u',
        'agent-probe',
        '--',
        '/usr/local/bin/guestctl',
        'inspect',
        '--json',
      ]),
    );
    const runtimeCredential = await signer.issueRuntimeCredential(guestSubject(proof));
    const readRuntime = () =>
      probe.readRuntime({
        subject: guestSubject(proof),
        address: info.ip4,
        credential: runtimeCredential,
        trust: { kind: 'host_ca', publicKey: signer.trust.sshHostCa },
      });
    const firstRuntime = await readRuntime();
    assert.equal(firstRuntime.checks.docker.kind, 'ok');
    assert.equal(firstRuntime.checks.proxy.kind, 'ok');
    await vm(['systemctl', 'stop', 'docker.service', 'docker.socket']);
    try {
      assert.equal((await readRuntime()).checks.docker.kind, 'unavailable');
      await tick();
      assert.partialDeepStrictEqual(await operationProgress(), {
        kind: 'waiting_guest',
        stage: 'runtime',
      });
    } finally {
      await vm(['systemctl', 'start', 'docker.service']);
    }
    await vm(['systemctl', 'stop', 'agent-cloud-proxy.service']);
    try {
      assert.equal((await readRuntime()).checks.proxy.kind, 'unavailable');
      await tick();
      assert.partialDeepStrictEqual(await operationProgress(), {
        kind: 'waiting_guest',
        stage: 'runtime',
      });
    } finally {
      await vm(['systemctl', 'start', 'agent-cloud-proxy.service']);
    }
    // Give only this owned VM's state directory a small temporary filesystem. Never fill a disk.
    await vm(['cp', '-a', '/var/lib/agent-cloud', '/tmp/agent-cloud-runtime-state']);
    let mounted = false;
    try {
      await vm([
        'mount',
        '-t',
        'tmpfs',
        '-o',
        'size=32m,mode=0700',
        'agent-cloud-runtime-smoke',
        '/var/lib/agent-cloud',
      ]);
      mounted = true;
      await vm(['cp', '-a', '/tmp/agent-cloud-runtime-state/.', '/var/lib/agent-cloud/']);
      const limited = await readRuntime();
      assert.equal(limited.checks.disk.kind, 'ok');
      assert.ok(limited.checks.disk.availableBytes < 1024 ** 3);
      await tick();
      assert.partialDeepStrictEqual(await operationProgress(), {
        kind: 'waiting_guest',
        stage: 'runtime',
      });
    } finally {
      if (mounted) await vm(['umount', '/var/lib/agent-cloud']);
      await vm(['rm', '-rf', '/tmp/agent-cloud-runtime-state']);
    }
    await tick();
    assert.partialDeepStrictEqual(await operationProgress(), { kind: 'succeeded' });
    progress('runtime completion requires healthy Docker, proxy and disk headroom');
    // The server leaf is trusted, but a client without a certificate must fail the handshake.
    await assert.rejects(
      new Promise<void>((resolve, reject) => {
        const check = request(
          {
            host: info.ip4,
            port: 8443,
            servername: guestName(guestSubject(proof)),
            ca: signer.trust.tlsRoot,
            timeout: 5000,
          },
          (response) => {
            response.resume();
            resolve();
          },
        );
        check.once('error', reject);
        check.once('timeout', () => check.destroy(new Error('Guest TLS timeout.')));
        check.end();
      }),
    );
    await vm([
      '/bin/sh',
      '-c',
      'test -f /etc/cloud/cloud-init.disabled && test ! -e /var/lib/agent-cloud/bootstrap.json && test ! -e /var/lib/cloud/seed',
    ]);
    // Never put the token in argv/output; remove the diagnostic copies even if scanning fails.
    let scan;
    try {
      await writeFile(join(scratch, 'needle'), fixture.bootstrap.token, { mode: 0o600 });
      await vm([
        'install',
        '-m',
        '0600',
        '/mnt/mac' + join(scratch, 'needle'),
        '/tmp/agent-cloud-token-needle',
      ]);
      await vm([
        'install',
        '-m',
        '0600',
        '/mnt/mac' + resolve('tests/fixtures/guest/scan-bootstrap.mjs'),
        '/tmp/agent-cloud-scan.mjs',
      ]);
      await vm([
        '/bin/sh',
        '-c',
        'umask 077; journalctl --no-pager --output cat > /tmp/agent-cloud-journal',
      ]);
      scan = z
        .object({
          files: z.number().positive(),
          bytes: z.number().positive(),
          matches: z.array(z.string()),
        })
        .parse(JSON.parse(await vm(['/usr/local/bin/node', '/tmp/agent-cloud-scan.mjs'])));
    } finally {
      await vm([
        'rm',
        '-f',
        '/tmp/agent-cloud-token-needle',
        '/tmp/agent-cloud-journal',
        '/tmp/agent-cloud-scan.mjs',
      ]);
    }
    process.stdout.write(JSON.stringify({ bootstrapScan: scan }) + '\n');
    assert.deepEqual(scan.matches, [], 'Bootstrap token remains in guest state.');
    // A completed provider action alone is insufficient: the old boot must remain waiting.
    const [machineRow] = await database.connection.db
      .select()
      .from(machines)
      .where(eq(machines.id, fixture.operation.machineId));
    if (!machineRow) throw new Error('Expected enrolled machine.');
    const machine = machineRecord(machineRow);
    const rebootResponse = await app.request(`/v1/machines/${machine.id}/actions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${fixture.account.token}`,
        'Idempotency-Key': randomUUID(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ kind: 'reboot', expectedVersion: machine.version }),
    });
    assert.equal(rebootResponse.status, 202);
    const reboot = operationResponseSchema.parse(await rebootResponse.json()).operation;
    for (let i = 0; i < 4; i++) await tick(reboot.id);
    assert.partialDeepStrictEqual(await operationProgress(reboot.id), {
      kind: 'waiting_guest',
      stage: 'runtime',
    });
    // Cloud-init stays disabled and installed identity survives a normal reboot.
    await command('orb', ['restart', owner.name], 120_000);
    assert.deepEqual(
      guestProofSchema.parse(
        JSON.parse(await vm(['/usr/local/bin/guestctl', 'identity', '--json'])),
      ),
      proof,
    );
    for (let i = 0; i < 15; i++) {
      await tick(reboot.id);
      if (
        z.object({ kind: z.literal('succeeded') }).safeParse(await operationProgress(reboot.id))
          .success
      )
        break;
      await setTimeout(1000);
    }
    assert.partialDeepStrictEqual(await operationProgress(reboot.id), { kind: 'succeeded' });
    assert.notEqual((await readRuntime()).bootId, firstRuntime.bootId);
    assert.equal(
      (await vm(['systemctl', 'is-active', 'agent-cloud-proxy.service'])).trim(),
      'active',
    );
    assert.deepEqual(
      await probe.readIdentity({
        subject: guestSubject(proof),
        address: info.ip4,
        credential: await signer.issueProbeCredential(guestSubject(proof)),
        trust: { kind: 'host_ca', publicKey: signer.trust.sshHostCa },
      }),
      proof,
    );
    progress('passed real Ubuntu first boot and restart; provider remains simulated');
    await vm(['/bin/sh', '-c', 'test ! -e /usr/lib/agent-cloud/image-build.json']);
    const leaf = new X509Certificate(
      await vm(['cat', '/var/lib/agent-cloud/certificates/current/guest.crt']),
    );
    process.stdout.write(
      JSON.stringify({
        result: 'guest-verified',
        machineId: (await vm(['cat', '/etc/machine-id'])).trim(),
        sshIdentity: createHash('sha256').update(proof.sshHostPublicKey).digest('hex'),
        tlsIdentity: createHash('sha256')
          .update(leaf.publicKey.export({ type: 'spki', format: 'der' }))
          .digest('hex'),
        allocationId: proof.allocationId,
      }) + '\n',
    );
  }
  await command('orb', ['delete', '--force', owner.name], 60_000);
  await rm(ownershipPath);
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server?.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
  await database.close();
  await rm(scratch, { recursive: true, force: true });
  // A failed run deliberately preserves its recorded VM for targeted inspection and explicit cleanup.
  // Successful cleanup is performed only after all checks above; see the ownership file for recovery.
}

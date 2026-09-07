import { verifyImageClone } from './support/image-verifier-clone.js';
import { prepareVmSeedFixture } from './support/vm-seed.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  imageBuildAdmissionSchema,
  imageBuildIdSchema,
  CloudError,
  imageBuilderBootSchema,
  type ImageProvider,
} from '../packages/contracts/dist/index.js';
import { connect } from '../packages/db/dist/index.js';
import { createImageBuilder } from '../packages/remote/dist/index.js';
import { createImageAccessStore } from '../apps/control/dist/image-access.js';
import { createImageRenderer } from '../apps/control/dist/image-renderer.js';
import {
  admitImageBuild,
  inspectImageBuild,
  requestImageCleanup,
} from '../apps/control/dist/image-builds.js';
import { advanceImageBuild } from '../apps/control/dist/advance-image-build.js';
import { testDatabase } from '../tests/database.js';
import { ImageProviderFixture, imagePricing } from '../tests/image-build-fixture.js';
import { readGuestBuild } from './support/guest-build.js';
import { builderPath, builderSchema } from './support/image-builder.js';

const progress = (phase: string) =>
  process.stdout.write(JSON.stringify({ phase, cloudResourcesCreated: 0 }) + '\n');
async function run(binary: string, args: string[], timeout = 30_000, env = process.env) {
  try {
    return (
      await promisify(execFile)(binary, args, {
        timeout,
        killSignal: 'SIGKILL',
        maxBuffer: 65_536,
        env,
      })
    ).stdout;
  } catch {
    throw new Error(
      `Builder smoke failed at ${binary}; inspect only its recorded VM and access directory.`,
    );
  }
}
const guestBuild = await readGuestBuild();
const { directory: sourceDirectory, ...source } = guestBuild;
const builder = builderSchema.parse({
  purpose: 'agent-cloud-local-image-builder',
  name: 'agent-cloud-builder-' + randomUUID().slice(0, 8),
  builderId: randomUUID(),
  phase: 'building',
});
await mkdir('.local', { recursive: true, mode: 0o700 });
await writeFile(builderPath, JSON.stringify(builder) + '\n', { mode: 0o600, flag: 'wx' });
const scratch = resolve('.local/image-builder-access', builder.builderId);
await mkdir(scratch, { recursive: true, mode: 0o700 });
const store = createImageAccessStore({ directory: join(scratch, 'keys') });
const database = await testDatabase();
let succeeded = false;
try {
  const id = imageBuildIdSchema.parse(builder.builderId);
  const access = await store.prepare({
    buildId: id,
    manifestDigest: source.manifestDigest,
    managementAddress: '127.0.0.1',
  });
  const pricing = imagePricing();
  const now = Date.now();
  const admission = imageBuildAdmissionSchema.parse({
    id,
    provider: 'hetzner',
    source,
    offer: pricing.catalog.items[0],
    storagePrice: pricing.storagePrice,
    baseImageId: '161547269',
    access,
    budget: {
      currency: 'USD',
      maxVmGrossMicros: 120000,
      maxSnapshotMonthlyGrossMicros: 1000000,
      maxSnapshotGb: 40,
    },
    admittedAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + 90 * 60_000).toISOString(),
    retention: { kind: 'retain', deleteAfter: new Date(now + 86_400_000).toISOString() },
  });
  const limits = {
    currency: 'USD',
    maxOpenBuilds: 1,
    maxVmGrossMicros: 120000,
    maxSnapshotMonthlyGrossMicros: 1000000,
  };
  await admitImageBuild({
    db: database.connection.db,
    admission,
    sourceDirectory,
    catalog: pricing.catalog,
    limits,
  });
  const protocol = new ImageProviderFixture();
  const renderer = createImageRenderer(database.connection.db, store);
  let rendered: { effectId: string; userData: string } | null = null;
  // SQL uses the protocol fixture; only this wrapper owns the actual local VM actions.
  // This proves native execution and controller ordering, not Hetzner boot or billing.
  const provider: ImageProvider = {
    kind: protocol.kind,
    get: protocol.get.bind(protocol),
    find: protocol.find.bind(protocol),
    getAction: protocol.getAction.bind(protocol),
    getBaseImage: protocol.getBaseImage.bind(protocol),
    submit: async (input) => {
      if (input.command.kind === 'create_server')
        rendered = {
          effectId: input.effectId,
          userData: await renderer({ effectId: input.effectId, command: input.command }),
        };
      if (input.command.kind === 'power_off') {
        assert.equal(input.command.serverId, '1004');
        assert.equal(
          (await inspectImageBuild(database.connection.db, id)).builderWork.kind,
          'recorded',
        );
        await run('orb', ['stop', builder.name], 120_000);
      }
      if (input.command.kind === 'delete' && input.command.resource.kind === 'server') {
        assert.equal(input.command.resource.id, '1004');
        assert.equal(
          builderSchema.parse(JSON.parse(await readFile(builderPath, 'utf8'))).name,
          builder.name,
        );
        await run('orb', ['delete', '--force', builder.name], 60_000);
      }
      return protocol.submit(input);
    },
  };
  const remote = createImageBuilder();
  let uploads = 0;
  let installations = 0;
  const controlledRemote: ReturnType<typeof createImageBuilder> = {
    inspect: remote.inspect,
    upload: async (input) => {
      uploads++;
      assert.deepEqual(
        (await inspectImageBuild(database.connection.db, id)).builderWork.kind,
        'recorded',
      );
      return remote.upload(input);
    },
    install: async (input) => {
      installations++;
      const results = await Promise.all([remote.install(input), remote.install(input)]);
      assert(results.some((result) => result.kind === 'installed'));
      assert.equal((await remote.inspect(input)).kind, 'installed');
      throw new CloudError(
        'guest_unreachable',
        'Fixture drops the completed installation response.',
        true,
      );
    },
    sanitize: async (input) => {
      const work = (await inspectImageBuild(database.connection.db, id)).builderWork;
      assert(work.kind === 'recorded' && work.progress.kind === 'sanitizing');
      return remote.sanitize(input);
    },
  };
  const controller = {
    connection: database.connection,
    buildId: id,
    provider,
    limits,
    pricing: () => Promise.resolve(imagePricing()),
    access: store,
    remote: controlledRemote,
    sourceDirectory,
  };
  for (let pass = 0; pass < 4; pass++)
    assert.equal((await advanceImageBuild(controller)).kind, 'provider');
  const { effectId, userData } = z
    .object({ effectId: z.uuid(), userData: z.string().min(1) })
    .parse(rendered);
  await writeFile(join(scratch, 'user-data'), userData, { flag: 'wx', mode: 0o600 });
  await writeFile(
    join(scratch, 'meta-data'),
    JSON.stringify({ 'instance-id': effectId, 'local-hostname': 'agent-cloud-builder-fixture' }),
    { flag: 'wx', mode: 0o600 },
  );
  // OrbStack owns fixture networking and disk sizing; keep both provider defaults in production.
  await writeFile(
    join(scratch, 'datasource.cfg'),
    'datasource_list: [NoCloud]\nnetwork:\n  config: disabled\ngrowpart:\n  mode: "off"\nresize_rootfs: false\n',
    { flag: 'wx', mode: 0o600 },
  );
  progress('preparing an owned Ubuntu VM for real cloud-init and first SSH');
  await run(
    'orb',
    ['create', '--arch', 'amd64', '--user', 'agent-cloud-build', 'ubuntu:noble', builder.name],
    180_000,
  );
  const vm = (args: string[], timeout?: number) =>
    run('orb', ['run', '-m', builder.name, '-u', 'root', '-w', '/tmp', ...args], timeout);
  await vm(
    [
      '/bin/sh',
      '-ec',
      'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; apt-get install -y -qq openssh-server cloud-init sudo',
    ],
    180_000,
  );
  await vm(['cloud-init', 'clean', '--logs', '--seed']);
  await vm(['install', '-d', '-m', '0700', '/var/lib/cloud/seed/nocloud']);
  for (const file of ['user-data', 'meta-data'])
    await vm([
      'install',
      '-m',
      '0600',
      '/mnt/mac' + join(scratch, file),
      '/var/lib/cloud/seed/nocloud/' + file,
    ]);
  await vm([
    'install',
    '-m',
    '0600',
    '/mnt/mac' + join(scratch, 'datasource.cfg'),
    '/etc/cloud/cloud.cfg.d/91-agent-cloud-smoke.cfg',
  ]);
  await vm(['cloud-init', 'schema', '--config-file', '/var/lib/cloud/seed/nocloud/user-data']);
  await run('orb', ['restart', builder.name], 120_000);
  await vm(['cloud-init', 'status', '--wait'], 120_000);
  const info = z
    .object({
      record: z.object({
        name: z.literal(builder.name),
        builtin: z.literal(false),
        image: z.object({
          distro: z.literal('ubuntu'),
          version: z.literal('noble'),
          arch: z.literal('amd64'),
        }),
      }),
      ip4: z.ipv4(),
    })
    .parse(JSON.parse(await run('orb', ['info', builder.name, '--format', 'json'])));
  const server = await protocol.get({ kind: 'server', id: '1004' });
  const ip = await protocol.get({ kind: 'primary_ip', id: '1003' });
  assert(server?.kind === 'server' && ip?.kind === 'primary_ip');
  protocol.add({ ...server, ipv4: info.ip4 });
  protocol.add({ ...ip, ipv4: info.ip4, serverId: server.id });
  const material = await store.recover(admission);
  const target = {
    boot: imageBuilderBootSchema.parse({
      version: 1,
      buildId: id,
      effectId,
      manifestDigest: source.manifestDigest,
    }),
    address: info.ip4,
    hostPublicKey: access.hostPublicKey,
    managementPrivateKey: material.managementPrivateKey,
    checksumDigest: source.checksumDigest,
    deadlineAt: admission.deadlineAt,
  };
  progress('checking pinned host, exact boot identity and upload refusal after expiry');
  await assert.rejects(remote.inspect({ ...target, hostPublicKey: access.publicKey }));
  await assert.rejects(
    remote.inspect({ ...target, boot: { ...target.boot, effectId: randomUUID() } }),
  );
  await assert.rejects(
    remote.upload({
      ...target,
      sourceDirectory,
      deadlineAt: new Date(Date.now() - 1000).toISOString(),
    }),
  );
  assert.equal((await remote.inspect(target)).kind, 'not_started');
  progress('uploading verified inputs through SFTP and rejecting changed uploaded code');
  await remote.upload({ ...target, sourceDirectory });
  await vm([
    '/bin/sh',
    '-ec',
    "printf '\ntouch /tmp/agent-cloud-unverified-code\n' >> /tmp/agent-cloud-input/install.sh",
  ]);
  await assert.rejects(remote.install(target));
  await vm(['test', '!', '-e', '/tmp/agent-cloud-unverified-code']);
  assert.equal((await remote.inspect(target)).kind, 'not_started');
  progress('persisting installation intent, installing once and losing the completed response');
  const firstPass = await advanceImageBuild(controller);
  assert(
    firstPass.kind === 'builder' &&
      'result' in firstPass &&
      firstPass.result.kind === 'acquired' &&
      firstPass.result.value.kind === 'waiting',
  );
  const installed = await remote.inspect(target);
  assert.equal(installed.kind, 'installed');
  await prepareVmSeedFixture(vm);
  await vm(['rm', '/tmp/agent-cloud-input/install.sh']);
  assert.deepEqual(await remote.install(target), installed);
  await assert.rejects(remote.upload({ ...target, sourceDirectory }));
  progress('recovering the durable receipt through a restarted controller without reinstalling');
  const restarted = connect(database.databaseUrl);
  try {
    await advanceImageBuild({
      ...controller,
      connection: restarted,
      access: createImageAccessStore({ directory: join(scratch, 'keys') }),
    });
  } finally {
    await restarted.pool.end();
  }
  const recovered = (await inspectImageBuild(database.connection.db, id)).builderWork;
  assert(recovered.kind === 'recorded' && recovered.progress.kind === 'installed');
  assert.equal(uploads, 1);
  assert.equal(installations, 1);
  progress('persisting sanitation intent and removing builder keys and privileges through SSH');
  await advanceImageBuild(controller);
  const sanitized = (await inspectImageBuild(database.connection.db, id)).builderWork;
  assert(sanitized.kind === 'recorded' && sanitized.progress.kind === 'sanitized');
  assert.equal(sanitized.progress.sanitation.builderId, id);
  await vm([
    '/bin/sh',
    '-ec',
    'test ! -e /etc/sudoers.d/agent-cloud-builder; test ! -e /etc/ssh/sshd_config.d/10-agent-cloud-builder.conf; test ! -e /var/lib/agent-cloud-builder; test ! -e /run/agent-cloud-builder.json',
  ]);
  await assert.rejects(remote.inspect(target));
  const keyLine = material.hostPrivateKey.trim().split('\n')[3];
  if (!keyLine || keyLine.length < 43)
    throw new Error('Expected a bounded private-key scan needle.');
  await writeFile(join(scratch, 'needle'), keyLine.slice(0, 43), { flag: 'wx', mode: 0o600 });
  let scan;
  try {
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
      '-ec',
      'install -d -m 0755 /run/cloud-init; umask 077; journalctl --no-pager --output cat > /tmp/agent-cloud-journal',
    ]);
    scan = z
      .object({
        files: z.number().positive(),
        bytes: z.number().positive(),
        matches: z.array(z.string()),
      })
      .parse(JSON.parse(await vm(['/usr/local/bin/node', '/tmp/agent-cloud-scan.mjs'])));
    assert.deepEqual(scan.matches, []);
  } finally {
    await vm([
      'rm',
      '-rf',
      '/tmp/agent-cloud-token-needle',
      '/tmp/agent-cloud-journal',
      '/tmp/agent-cloud-scan.mjs',
      '/run/cloud-init',
    ]);
  }
  process.stdout.write(JSON.stringify({ builderKeyScan: scan }) + '\n');
  assert.equal((await advanceImageBuild(controller)).kind, 'provider');
  assert.equal((await advanceImageBuild(controller)).kind, 'provider');
  assert.equal((await advanceImageBuild(controller)).kind, 'verification_required');
  await writeFile(builderPath, JSON.stringify({ ...builder, phase: 'sanitized' }) + '\n', {
    mode: 0o600,
  });
  const resultSchema = z.object({
    result: z.literal('guest-verified'),
    machineId: z.string(),
    sshIdentity: z.string(),
    tlsIdentity: z.string(),
    allocationId: z.string(),
  });
  const identities: Array<z.infer<typeof resultSchema>> = [];
  for (let clone = 1; clone <= 2; clone++) {
    progress(`verifying fresh clone ${clone} of the SSH-built image`);
    const output = await run(
      process.execPath,
      ['--import', 'tsx', 'scripts/smoke-guest.ts'],
      600_000,
      {
        ...process.env,
        AGENT_CLOUD_SANITIZED_IMAGE: '1',
        AGENT_CLOUD_INPUT_DIGEST: source.manifestDigest,
      },
    );
    const report = output
      .trim()
      .split('\n')
      .map((line) => resultSchema.safeParse(JSON.parse(line)))
      .find((result) => result.success);
    if (!report?.success) throw new Error('Clone did not report its verified identity.');
    identities.push(report.data);
    process.stdout.write(output);
  }
  for (const field of ['machineId', 'sshIdentity', 'tlsIdentity', 'allocationId'] satisfies Array<
    keyof z.infer<typeof resultSchema>
  >)
    assert.equal(new Set(identities.map((identity) => identity[field])).size, 2);
  await verifyImageClone({ controller, protocol });
  progress('confirming cancelled retained build cleanup and local key removal');
  await requestImageCleanup(database.connection.db, id);
  let cleaned = false;
  for (let pass = 0; pass < 12; pass++) {
    if ((await advanceImageBuild(controller)).kind === 'cleaned') {
      cleaned = true;
      break;
    }
  }
  assert(cleaned);
  assert.equal(protocol.resources.size, 0);
  assert.equal((await inspectImageBuild(database.connection.db, id)).state.kind, 'cleaned');
  await assert.rejects(store.recover(admission));
  await rm(builderPath);
  succeeded = true;
  progress(
    'passed durable builder recovery, sanitation, stopped snapshot ordering, distinct clone boots and terminal cleanup',
  );
} finally {
  await database.close();
  if (succeeded) await rm(scratch, { recursive: true, force: true });
  // Failed runs retain their recorded VM and private access files for targeted recovery.
}

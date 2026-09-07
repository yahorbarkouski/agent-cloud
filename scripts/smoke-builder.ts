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
  imageBuildLabels,
  imageBuilderBootSchema,
  type ImageProviderCommand,
} from '../packages/contracts/dist/index.js';
import { imageBuildEffects } from '../packages/db/dist/index.js';
import { createImageBuilder } from '../packages/remote/dist/index.js';
import { createImageAccessStore } from '../apps/control/dist/image-access.js';
import { createImageRenderer } from '../apps/control/dist/image-renderer.js';
import { admitImageBuild } from '../apps/control/dist/image-builds.js';
import { runImageEffect } from '../apps/control/dist/image-effect-journal.js';
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
    retention: { kind: 'verification_only' },
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
  const provider = new ImageProviderFixture();
  for (const command of [
    {
      kind: 'create_ssh_key',
      name: 'access',
      labels: imageBuildLabels(id, 'access_key'),
      publicKey: access.publicKey,
    },
    {
      kind: 'create_firewall',
      name: 'access',
      labels: imageBuildLabels(id, 'access_firewall'),
      managementAddress: access.managementAddress,
    },
    {
      kind: 'create_primary_ip',
      name: 'builder-ip',
      labels: imageBuildLabels(id, 'builder_ip'),
      region: 'nbg1',
    },
  ] satisfies ImageProviderCommand[])
    await runImageEffect({
      connection: database.connection,
      buildId: id,
      command,
      provider,
      limits,
      pricing: () => Promise.resolve(imagePricing()),
    });
  const effectId = randomUUID();
  const command = {
    kind: 'create_server',
    name: 'builder',
    labels: imageBuildLabels(id, 'builder'),
    serverType: 'cpx12',
    region: 'nbg1',
    imageId: admission.baseImageId,
    primaryIpId: '1003',
    sshKeyId: '1001',
    firewallId: '1002',
    bootData: { kind: 'image_build_secret', id: access.secretId, digest: source.manifestDigest },
  } satisfies Extract<ImageProviderCommand, { kind: 'create_server' }>;
  await database.connection.db
    .insert(imageBuildEffects)
    .values({ id: effectId, buildId: id, effectKey: 'create:builder', command });
  const userData = await createImageRenderer(database.connection.db, store)({ effectId, command });
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
  const remote = createImageBuilder();
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
  await remote.upload({ ...target, sourceDirectory });
  progress('installing once across concurrent SSH requests');
  const installations = await Promise.all([remote.install(target), remote.install(target)]);
  assert(installations.some((result) => result.kind === 'installed'));
  const installed = await remote.inspect(target);
  assert.equal(installed.kind, 'installed');
  // Remove the executable input: a repeated request must recover the durable receipt without reinstalling.
  await vm(['rm', '/tmp/agent-cloud-input/install.sh']);
  assert.deepEqual(await remote.install(target), installed);
  await assert.rejects(remote.upload({ ...target, sourceDirectory }));
  progress('sanitizing through SSH and checking that builder keys and privileges are removed');
  const receipt = await remote.sanitize(target);
  assert.equal(receipt.builderId, id);
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
  await run('orb', ['stop', builder.name], 120_000);
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
  assert.equal(
    builderSchema.parse(JSON.parse(await readFile(builderPath, 'utf8'))).name,
    builder.name,
  );
  await run('orb', ['delete', '--force', builder.name], 60_000);
  await rm(builderPath);
  succeeded = true;
  progress(
    'passed authenticated builder installation, sanitation, distinct clone boots and cleanup',
  );
} finally {
  await database.close();
  if (succeeded) await rm(scratch, { recursive: true, force: true });
  // Failed runs retain their recorded VM and private access files for targeted recovery.
}

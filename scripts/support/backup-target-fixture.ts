import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { allocationIdSchema, type AllocationId } from '../../packages/contracts/dist/index.js';
import { imageInstallCommand } from '../../packages/images/dist/index.js';
import { atomicWrite, syncDirectory } from '../../packages/guestctl/src/files.js';
import { readPrivateFile } from '../../apps/control/src/private-file.js';
import { imageReceiptSchema } from './image-builder.js';
import type { readGuestBuild } from './guest-build.js';
import { prepareVmSeedFixture } from './vm-seed.js';

const ownerSchema = z.strictObject({
  purpose: z.literal('agent-cloud-native-backup-target'),
  id: z.uuid(),
  allocationId: allocationIdSchema,
  name: z.string().regex(/^agent-cloud-backup-[0-9a-f-]{36}$/),
  builderId: z.uuid(),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  userDataDigest: z.string().regex(/^[a-f0-9]{64}$/),
  vmId: z.string().min(1).nullable(),
  phase: z.enum(['creating', 'installing', 'booted', 'deleted']),
});
const recordSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  builtin: z.literal(false),
  image: z.object({
    distro: z.literal('ubuntu'),
    version: z.literal('noble'),
    arch: z.literal('amd64'),
  }),
});

/** A second, exact-owned Ubuntu VM. It is created only after real restore machine admission. */
export function prepareBackupTargetFixture(input: {
  guestBuild: Awaited<ReturnType<typeof readGuestBuild>>;
  command: (binary: string, args: string[], timeout?: number) => Promise<string>;
}) {
  let owner: z.infer<typeof ownerSchema> | undefined;
  let ownershipPath: string | undefined;
  let scratch: string | undefined;
  const names = async () =>
    (await input.command('orb', ['list', '--quiet'])).trim().split('\n').filter(Boolean);
  async function persist() {
    assert.ok(owner && ownershipPath);
    await atomicWrite(ownershipPath, JSON.stringify(owner) + '\n', 0o600);
  }
  async function inspect() {
    assert.ok(owner && ownershipPath);
    assert.deepEqual(ownerSchema.parse(JSON.parse(await readPrivateFile(ownershipPath))), owner);
    const value: unknown = JSON.parse(
      await input.command('orb', ['info', owner.name, '--format', 'json']),
    );
    const info = z.object({ record: recordSchema }).parse(value);
    assert.equal(info.record.name, owner.name);
    if (owner.vmId)
      assert.equal(
        info.record.id,
        owner.vmId,
        'Backup target VM identity differs from its ownership receipt.',
      );
    return { value, record: info.record };
  }
  async function runningAddress() {
    for (let attempt = 0; attempt < 30; attempt++) {
      const info = await inspect();
      const result = z.object({ ip4: z.ipv4() }).safeParse(info.value);
      if (result.success) return result.data.ip4;
      await setTimeout(1000);
    }
    throw new Error('Owned backup target did not receive an IPv4 address before its deadline.');
  }
  async function vm(args: string[], timeout?: number) {
    assert.ok(owner?.vmId, 'Backup target has not been created and identified.');
    await inspect();
    return input.command(
      'orb',
      ['run', '-m', owner.name, '-u', 'root', '-w', '/tmp', ...args],
      timeout,
    );
  }
  async function provision(userData: string, allocationId: AllocationId) {
    allocationIdSchema.parse(allocationId);
    const userDataDigest = createHash('sha256').update(userData).digest('hex');
    if (owner) {
      assert.equal(
        owner.allocationId,
        allocationId,
        'A backup fixture owns exactly one target allocation.',
      );
      assert.equal(owner.userDataDigest, userDataDigest, 'Target bootstrap replay differs.');
      assert.equal(
        owner.phase,
        'booted',
        'Interrupted target creation requires inspection of its retained ownership record.',
      );
      return runningAddress();
    }
    const id = randomUUID();
    owner = ownerSchema.parse({
      purpose: 'agent-cloud-native-backup-target',
      id,
      allocationId,
      name: `agent-cloud-backup-${id}`,
      builderId: randomUUID(),
      manifestDigest: input.guestBuild.manifestDigest,
      userDataDigest,
      vmId: null,
      phase: 'creating',
    });
    ownershipPath = resolve(`.local/backup-target-${id}.json`);
    scratch = resolve(`.local/backup-target-${id}`);
    await mkdir(dirname(ownershipPath), { recursive: true, mode: 0o700 });
    assert.ok(
      !(await names()).includes(owner.name),
      'Refusing to reuse an existing backup target VM name.',
    );
    const record = await open(ownershipPath, 'wx', 0o600);
    try {
      await record.writeFile(JSON.stringify(owner) + '\n');
      await record.sync();
    } finally {
      await record.close();
    }
    await syncDirectory(dirname(ownershipPath));
    await input.command(
      'orb',
      ['create', '--arch', 'amd64', '--user', 'agent-cloud-build', 'ubuntu:noble', owner.name],
      180_000,
    );
    owner.vmId = (await inspect()).record.id;
    owner.phase = 'installing';
    await persist();
    await runningAddress();
    await vm([
      '/bin/sh',
      '-ec',
      'test ! -e /var/lib/agent-cloud/keys && test ! -e /var/lib/agent-cloud/bootstrap.json && test ! -e /var/lib/agent-cloud/guest.json',
    ]);
    await vm(['cp', '-R', '/mnt/mac' + input.guestBuild.directory, '/tmp/agent-cloud-input']);
    await vm(
      imageInstallCommand({
        directory: '/tmp/agent-cloud-input',
        builderId: owner.builderId,
        manifestDigest: input.guestBuild.manifestDigest,
        checksumDigest: input.guestBuild.checksumDigest,
      }),
      600_000,
    );
    await prepareVmSeedFixture(vm);
    const receipt = imageReceiptSchema.parse(
      JSON.parse(await vm(['/usr/local/bin/guestctl', 'prepare-image', '--json'], 120_000)),
    );
    assert.equal(receipt.builderId, owner.builderId);
    assert.equal(receipt.manifestDigest, owner.manifestDigest);
    await mkdir(scratch, { mode: 0o700 });
    await syncDirectory(dirname(scratch));
    await writeFile(join(scratch, 'user-data'), userData, { mode: 0o600, flag: 'wx' });
    await writeFile(
      join(scratch, 'meta-data'),
      JSON.stringify({
        'instance-id': allocationId,
        'local-hostname': 'agent-cloud-backup-target',
      }),
      { mode: 0o600, flag: 'wx' },
    );
    await writeFile(
      join(scratch, 'datasource.cfg'),
      'datasource_list: [NoCloud]\nnetwork:\n  config: disabled\ngrowpart:\n  mode: "off"\nresize_rootfs: false\n',
      { mode: 0o600, flag: 'wx' },
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
    await vm([
      'install',
      '-m',
      '0600',
      '/mnt/mac' + join(scratch, 'datasource.cfg'),
      '/etc/cloud/cloud.cfg.d/91-agent-cloud-smoke.cfg',
    ]);
    await vm(['cloud-init', 'schema', '--config-file', '/var/lib/cloud/seed/nocloud/user-data']);
    await input.command('orb', ['restart', owner.name], 120_000);
    const address = await runningAddress();
    owner.phase = 'booted';
    await persist();
    await rm(scratch, { recursive: true, force: true });
    await syncDirectory(dirname(scratch));
    return address;
  }
  async function cleanup() {
    if (!owner || !ownershipPath) return;
    assert.deepEqual(ownerSchema.parse(JSON.parse(await readPrivateFile(ownershipPath))), owner);
    if ((await names()).includes(owner.name)) {
      await inspect();
      await input.command('orb', ['delete', '--force', owner.name], 60_000);
    }
    assert.ok(!(await names()).includes(owner.name), 'Owned backup target remains after deletion.');
    owner.phase = 'deleted';
    await persist();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
  return { provision, vm, cleanup };
}

export type NativeBackupTarget = ReturnType<typeof prepareBackupTargetFixture>;

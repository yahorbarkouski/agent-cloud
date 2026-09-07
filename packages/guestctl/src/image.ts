import { copyFile, lstat, readdir, rm, symlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import {
  guestBootSpecSchema,
  guestSubject,
  sameGuestSubject,
  type GuestBootSpec,
} from '@agent-cloud/contracts';
import { atomicWrite, ensureDirectory, isMissing, readOwnedFile } from './files.js';
import { loadManifest, type GuestConfiguration } from './identity.js';
import { runTool } from './tools.js';

const fields = {
  builderId: z.uuid(),
  machineId: z.string().regex(/^[0-9a-f]{32}$/),
  manifestDigest: z.string().regex(/^[0-9a-f]{64}$/),
  homes: z
    .array(
      z.strictObject({
        path: z.string().regex(/^\/root$|^\/home\/[A-Za-z0-9_-]+$|^\/var\/lib\/agent-probe$/),
        uid: z.int().nonnegative(),
      }),
    )
    .min(1),
};
const imageRecordSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('builder'), ...fields }),
  z.strictObject({ kind: z.literal('preparing'), ...fields }),
  z.strictObject({ kind: z.literal('sanitized'), ...fields }),
]);
const recordPath = '/usr/lib/agent-cloud/image-build.json';
async function directory(path: string, uid = 0, forbiddenWriteMode = 0o022) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.uid !== uid || stat.mode & forbiddenWriteMode)
    throw new Error('Image directory ownership, type or permissions are invalid.');
  return readdir(path);
}
async function emptyDirectory(path: string) {
  try {
    return (await directory(path)).length === 0;
  } catch (error) {
    if (isMissing(error)) return true;
    throw error;
  }
}
async function clearDirectory(path: string, uid = 0, forbiddenWriteMode = 0o022) {
  for (const entry of await directory(path, uid, forbiddenWriteMode))
    await rm(join(path, entry), { recursive: true, force: true });
}

/** Builder-only operation. Its caller must stop the owned VM after the receipt and before snapshotting. */
export async function prepareImage(configuration: GuestConfiguration) {
  const { digest } = await loadManifest(configuration);
  const record = imageRecordSchema.parse(JSON.parse(await readOwnedFile(recordPath, 'private')));
  if (record.manifestDigest !== digest || (await directory(configuration.state)).length !== 0)
    throw new Error('Image preparation requires the recorded builder without allocation state.');
  const homes = await directory('/home');
  const expected = record.homes
    .filter((home) => home.path.startsWith('/home/'))
    .map((home) => basename(home.path));
  if (
    JSON.stringify(homes.sort()) !== JSON.stringify(expected.sort()) ||
    !record.homes.some((home) => home.path === '/root')
  )
    throw new Error('Builder homes changed since installation.');
  for (const home of record.homes) await directory(home.path, home.uid);
  const machineId = (await readOwnedFile('/etc/machine-id', 'public')).trim();
  if (machineId !== record.machineId && machineId !== 'uninitialized')
    throw new Error('A changed machine ID cannot resume image preparation.');
  const run = (binary: string, args: string[]) => runTool(binary, args, '/');
  if (record.kind === 'builder') {
    if (machineId !== record.machineId)
      throw new Error('This machine does not match its builder record.');
    await run('/usr/bin/cloud-init', ['status', '--wait']);
  }
  if (record.kind !== 'sanitized') {
    // Never start Docker here: doing so could execute a stopped restart-policy container.
    const dockerState = (
      await run('/usr/bin/systemctl', [
        'show',
        '--property=ActiveState',
        '--value',
        'docker.service',
      ])
    ).trim();
    if (dockerState === 'active') {
      const docker = (args: string[]) =>
        run('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', ...args]);
      const usageSchema = z.object({
        Type: z.enum(['Images', 'Containers', 'Local Volumes', 'Build Cache']),
        TotalCount: z
          .union([z.int().nonnegative(), z.string().regex(/^[0-9]+$/)])
          .transform(Number),
      });
      const usage = (await docker(['system', 'df', '--format', '{{json .}}']))
        .trim()
        .split('\n')
        .map((line) => usageSchema.parse(JSON.parse(line)));
      if (
        new Set(usage.map((row) => row.Type)).size !== 4 ||
        usage.some((row) => row.TotalCount !== 0) ||
        (await docker(['network', 'ls', '--filter', 'type=custom', '--quiet'])).trim() ||
        (await docker(['info', '--format', '{{.Swarm.LocalNodeState}}'])).trim() !== 'inactive'
      )
        throw new Error(
          'Image preparation refuses Docker workloads, cache, custom networks or swarm state.',
        );
    } else if (record.kind === 'builder' || dockerState !== 'inactive') {
      throw new Error(
        'Builder Docker must already be active; interrupted cleanup requires an inactive or inspected empty daemon.',
      );
    }
    if (record.kind === 'builder')
      await atomicWrite(recordPath, JSON.stringify({ ...record, kind: 'preparing' }) + '\n', 0o600);
  }
  if (record.kind !== 'sanitized') {
    // Keep later service/access operations from recreating persistent builder logs.
    // /run disappears on the clone's boot, so its normal logging configuration returns.
    await ensureDirectory('/run/systemd/journald.conf.d', 0o755);
    await atomicWrite(
      '/run/systemd/journald.conf.d/zz-agent-cloud-image.conf',
      '[Journal]\nStorage=volatile\n',
      0o644,
    );
    await run('/usr/bin/systemctl', ['restart', 'systemd-journald.service']);
    if (
      (
        await run('/usr/bin/systemctl', [
          'show',
          '--property=LoadState',
          '--value',
          'rsyslog.service',
        ])
      ).trim() === 'loaded'
    )
      await run('/usr/bin/systemctl', ['stop', 'rsyslog.service']);
    await run('/usr/bin/systemctl', [
      'stop',
      'docker.service',
      'docker.socket',
      'containerd.service',
    ]);
    for (const path of [
      '/var/lib/docker',
      '/var/lib/containerd',
      '/var/lib/systemd/random-seed',
      '/tmp/agent-cloud-input',
      '/tmp/agent-cloud-install.log',
    ])
      await rm(path, { recursive: true, force: true });
    await run('/usr/bin/cloud-init', [
      'clean',
      '--logs',
      '--machine-id',
      '--seed',
      '--configs',
      'network',
    ]);
    await rm('/var/lib/dbus/machine-id', { force: true });
    await symlink('/etc/machine-id', '/var/lib/dbus/machine-id');
    await rm('/etc/cloud/cloud-init.disabled', { force: true });
    await rm('/run/cloud-init', { recursive: true, force: true });
    await rm('/run/log/journal', { recursive: true, force: true });
    // Ubuntu gives syslog group write access to /var/log; its root owner and non-world-writable mode remain required.
    await clearDirectory('/var/log', 0, 0o002);
    // Access removal is last. If interrupted here, the owner can retry out of band or rebuild this disposable VM.
    await run('/usr/bin/systemctl', ['disable', 'ssh.service', 'ssh.socket']);
    // Cloud-init may enable Ubuntu SSH again. Unit conditions also prevent socket activation
    // before guestctl has published this clone's identity, even when a unit is enabled.
    for (const unit of ['ssh.service', 'ssh.socket']) {
      const directory = `/etc/systemd/system/${unit}.d`;
      await ensureDirectory(directory, 0o755);
      await atomicWrite(
        join(directory, '10-agent-cloud-identity.conf'),
        '[Unit]\nConditionPathExists=/var/lib/agent-cloud/keys/ssh_host_ed25519_key\n',
        0o644,
      );
    }
    await run('/usr/bin/systemctl', ['daemon-reload']);
    await copyFile('/usr/lib/agent-cloud/sshd_config', '/etc/ssh/sshd_config');
    for (const path of [
      '/etc/sudoers.d/agent-cloud-builder',
      '/etc/ssh/sshd_config.d/10-agent-cloud-builder.conf',
      '/var/lib/agent-cloud-builder',
      '/run/agent-cloud-builder.json',
    ])
      await rm(path, { recursive: true, force: true });
    for (const entry of await directory('/etc/ssh'))
      if (entry.startsWith('ssh_host_')) await rm(join('/etc/ssh', entry), { force: true });
    for (const home of record.homes) await clearDirectory(home.path, home.uid);
  }
  if ((await readOwnedFile('/etc/machine-id', 'public')).trim() !== 'uninitialized')
    throw new Error('Prepared image machine ID was regenerated; refuse snapshot publication.');
  for (const path of [
    '/var/lib/cloud/instances',
    '/var/lib/cloud/seed',
    '/var/lib/docker',
    '/var/lib/containerd',
  ])
    if (!(await emptyDirectory(path))) throw new Error('Prepared image retains instance state.');
  for (const home of record.homes)
    if ((await directory(home.path, home.uid)).length)
      throw new Error('Prepared image retains builder home data.');
  if ((await directory('/var/log', 0, 0o002)).length)
    throw new Error('Prepared image retains persistent builder logs.');
  if ((await directory('/etc/ssh')).some((name) => name.startsWith('ssh_host_')))
    throw new Error('Prepared image retains a system SSH identity.');
  for (const unit of ['ssh.service', 'ssh.socket'])
    if (
      (
        await run('/usr/bin/systemctl', ['show', '--property=UnitFileState', '--value', unit])
      ).trim() !== 'disabled'
    )
      throw new Error('Prepared image retains builder SSH startup.');
  await atomicWrite(recordPath, JSON.stringify({ ...record, kind: 'sanitized' }) + '\n', 0o600);
  return { kind: 'sanitized', builderId: record.builderId, manifestDigest: digest };
}

/** Runs before guest key generation. Existing guest metadata permits a lost-response retry. */
export async function validateImageBoot(configuration: GuestConfiguration, spec: GuestBootSpec) {
  let record;
  try {
    record = imageRecordSchema.parse(JSON.parse(await readOwnedFile(recordPath, 'private')));
  } catch (error) {
    if (!isMissing(error)) throw error;
    const existing = guestBootSpecSchema.parse(
      JSON.parse(await readOwnedFile(join(configuration.state, 'guest.json'), 'public')),
    );
    if (
      !sameGuestSubject(guestSubject(existing), guestSubject(spec)) ||
      existing.image.manifestDigest !== spec.image.manifestDigest
    )
      throw new Error('Image record is absent without this guest retry.', { cause: error });
    return;
  }
  const machineId = (await readOwnedFile('/etc/machine-id', 'public')).trim();
  if (
    record.kind !== 'sanitized' ||
    record.manifestDigest !== spec.image.manifestDigest ||
    !/^[0-9a-f]{32}$/.test(machineId) ||
    machineId === record.machineId
  )
    throw new Error('Enrollment requires a sanitized image booted with a fresh machine ID.');
}
export async function consumeImageRecord() {
  await rm(recordPath, { force: true });
}

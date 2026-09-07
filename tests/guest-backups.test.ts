import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  backupGuestCaptureSchema,
  composeApplySchema,
  restoreGuestRequestSchema,
} from '../packages/contracts/src/index.js';
import { createGuestBackups } from '../packages/guestctl/src/backups.js';
import {
  backupComposeSystem,
  isolatedBackupConfig,
  type BackupSystem,
} from '../packages/guestctl/src/backup-system.js';
import {
  packBackup,
  unpackBackup,
  writeBackupStream,
} from '../packages/guestctl/src/backup-archive.js';
import { composeConfigSchema } from '../packages/guestctl/src/compose-system.js';
import { createComposeDeployments } from '../packages/guestctl/src/compose.js';

const directories: string[] = [];
const containing = (value: string): unknown => expect.stringContaining(value);
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
const image = `sha256:${'a'.repeat(64)}`;
const budget = () => ({ maximum: 1_048_576, signal: AbortSignal.timeout(10_000) });

async function fixture() {
  const scratch = await mkdtemp(join(tmpdir(), 'acld-backup-'));
  directories.push(scratch);
  const directory = join(scratch, 'backups');
  const composeDirectory = join(scratch, 'compose');
  const customerDirectory = join(scratch, 'customer');
  await mkdir(customerDirectory, { mode: 0o700 });
  await mkdir(join(customerDirectory, 'uploads'));
  await writeFile(join(customerDirectory, 'uploads', 'one.txt'), 'durable customer data', {
    mode: 0o640,
  });
  const projects = new Map<string, string>();
  const applied: Array<{ project: string; config: z.infer<typeof composeConfigSchema> }> = [];
  let pgMajor = 17;
  let dump: Buffer = Buffer.from('PGDMPtest database snapshot');
  const docker = vi.fn<BackupSystem['docker']>().mockImplementation(async (args, options) => {
    options.signal.throwIfAborted();
    if (args[0] === 'compose') {
      const project = z.string().parse(args[2]);
      const file = z.string().parse(args[4]);
      const action = args[5];
      if (action === 'config') return readFile(file, 'utf8');
      if (action === 'up') {
        applied.push({
          project,
          config: composeConfigSchema.parse(JSON.parse(await readFile(file, 'utf8'))),
        });
        projects.set(createHash('sha256').update(project).digest('hex'), project);
      }
      if (action === 'ps')
        return JSON.stringify([
          {
            ID: createHash('sha256').update(project).digest('hex'),
            Service: 'db',
            State: 'running',
            ExitCode: 0,
          },
        ]);
      return '';
    }
    if (args[0] === 'inspect') {
      const id = args.at(-1);
      return JSON.stringify({
        Id: id,
        Image: image,
        Config: {
          Labels: {
            'com.docker.compose.project': projects.get(z.string().parse(id)),
            'com.docker.compose.service': 'db',
          },
        },
        State: { Running: true },
      });
    }
    if (args[0] === 'image')
      return args[3] === '{{.Id}}' ? image : JSON.stringify({ '/var/lib/postgresql/data': {} });
    if (args[0] === 'exec') {
      if (args.at(-1) === '--version') return `${args.at(-2)} (PostgreSQL) ${pgMajor}.9`;
      if (args.includes('SHOW server_version_num')) return `${pgMajor}0009`;
      if (options.outputFile) {
        await writeBackupStream(
          options.outputFile,
          Readable.from([
            args.includes('pg_dumpall') ? Buffer.from('CREATE ROLE original_owner;') : dump,
          ]),
          options,
        );
      }
      if (options.inputFile) expect((await readFile(options.inputFile)).length).toBeGreaterThan(0);
      return '';
    }
    if (args[0] === 'ps' || args[0] === 'volume' || args[0] === 'network') return '';
    throw new Error('Unexpected fixture Docker command.');
  });
  const system = { docker };
  const configuration = { directory, composeDirectory, customerDirectory, system };
  const deployment = createComposeDeployments({
    directory: composeDirectory,
    system: backupComposeSystem(system, budget()),
  });
  const command = composeApplySchema.parse({
    kind: 'apply',
    app: 'original',
    releaseId: randomUUID(),
    expectedReleaseId: null,
    files: [
      {
        path: 'compose.json',
        content: Buffer.from(
          JSON.stringify({
            services: {
              db: {
                image: 'postgres:17.9',
                environment: {
                  POSTGRES_PASSWORD: 'source-only-secret',
                  POSTGRES_USER: 'original_owner',
                  POSTGRES_DB: 'customer',
                },
                volumes: [{ type: 'volume', source: 'data', target: '/var/lib/postgresql/data' }],
                ports: [{ target: 5432, published: '5432', host_ip: '0.0.0.0' }],
              },
            },
            volumes: { data: { name: 'production-volume' } },
            networks: { default: { name: 'production-network' } },
          }),
        ).toString('base64'),
        executable: false,
      },
    ],
    file: 'compose.json',
  });
  await deployment.command(command);
  await deployment.work();
  const request = backupGuestCaptureSchema.parse({
    kind: 'capture',
    id: randomUUID(),
    recipe: {
      kind: 'compose-postgres',
      app: command.app,
      releaseId: command.releaseId,
      service: 'db',
      user: 'original_owner',
      database: 'customer',
      files: ['uploads/one.txt'],
    },
    limits: { maxBytes: 1_048_576, timeoutSeconds: 30 },
  });
  const helper = createGuestBackups(configuration);
  const capture = async () => {
    const reply = await helper.capture(request);
    expect(reply.capture.kind).toBe('captured');
    const artifact = await helper.read(request.id);
    const bytes = await readFile(artifact.path);
    const restore = restoreGuestRequestSchema.parse({
      id: randomUUID(),
      backupId: request.id,
      app: 'restored',
      limits: request.limits,
      bytes: bytes.length,
      sha256: artifact.capture.sha256,
    });
    return { artifact, bytes, restore };
  };
  return {
    ...configuration,
    helper,
    deployment,
    command,
    request,
    capture,
    docker,
    applied,
    setMajor: (value: number) => {
      pgMajor = value;
    },
    setDump: (value: Buffer) => {
      dump = value;
    },
  };
}

it('captures source secrets and data privately, restores into a new healthy project, and replays saved results', async () => {
  const f = await fixture();
  const sourceHead = await f.deployment.current('original');
  const { artifact, bytes, restore } = await f.capture();
  expect(JSON.stringify(artifact.capture)).not.toContain('source-only-secret');
  expect((await stat(artifact.path)).mode & 0o777).toBe(0o600);
  const calls = f.docker.mock.calls.length;
  expect(await f.helper.capture(f.request)).toEqual({ capture: artifact.capture });
  expect(f.docker.mock.calls).toHaveLength(calls);
  const restored = await f.helper.restore(restore, Readable.from([bytes]));
  if (restored.kind === 'failed')
    throw new Error(
      JSON.stringify(restored) + JSON.stringify(await f.deployment.current('restored')),
    );
  expect(restored).toMatchObject({
    kind: 'restored',
    app: 'restored',
    integrity: 'database-restored-services-healthy',
  });
  const target = join(f.customerDirectory, 'restores', restore.id, 'uploads/one.txt');
  expect(await readFile(target, 'utf8')).toBe('durable customer data');
  expect((await stat(target)).mode & 0o777).toBe(0o640);
  expect((await stat(f.customerDirectory)).mode & 0o777).toBe(0o700);
  expect((await stat(join(f.customerDirectory, 'restores'))).mode & 0o777).toBe(0o755);
  expect((await stat(dirname(target))).mode & 0o777).toBe(0o755);
  expect(await f.deployment.current('original')).toEqual(sourceHead);
  expect(await readFile(join(f.customerDirectory, 'uploads/one.txt'), 'utf8')).toBe(
    'durable customer data',
  );
  const applies = f.applied.filter((entry) => entry.project === 'acld-restored');
  expect(applies).toHaveLength(2);
  expect(applies[0]?.config.services['db']?.['ports']).toBeUndefined();
  expect(applies[1]?.config.services['db']?.['ports']).toEqual([
    { target: 5432, published: '5432', host_ip: '127.0.0.1' },
  ]);
  expect(applies[1]?.config['volumes']).toEqual({ data: {} });
  expect(applies[1]?.config['networks']).toEqual({ default: { internal: true } });
  expect(JSON.stringify(applies)).not.toContain('production-volume');
  const afterRestore = f.docker.mock.calls.length;
  expect(await f.helper.restore(restore, Readable.from([bytes]))).toEqual(restored);
  expect(f.docker.mock.calls).toHaveLength(afterRestore);
  expect(
    f.docker.mock.calls.some(
      ([args]) => args.includes('pg_dumpall') && args.includes('--globals-only'),
    ),
  ).toBe(true);
  expect(
    f.docker.mock.calls.some(
      ([args]) =>
        args.includes('pg_restore') &&
        args.includes('--exit-on-error') &&
        args.includes('--create'),
    ),
  ).toBe(true);
  await f.helper.remove(f.request.id);
  await expect(f.helper.read(f.request.id)).rejects.toMatchObject({
    failure: { code: 'not_found' },
  });
  expect((await f.helper.capture(f.request)).capture).toMatchObject({
    kind: 'failed',
    reason: 'Guest backup staging was removed.',
  });
});

it('never replays capture or restore after a started operation loses its result', async () => {
  const f = await fixture();
  const { bytes, restore } = await f.capture();
  await rm(join(f.directory, 'captures', f.request.id, 'result.json'));
  const calls = f.docker.mock.calls.length;
  expect((await f.helper.capture(f.request)).capture).toMatchObject({
    kind: 'failed',
    reason: containing('interrupted'),
  });
  expect(f.docker.mock.calls).toHaveLength(calls);
  expect(await f.helper.restore(restore, Readable.from([bytes]))).toMatchObject({
    kind: 'restored',
  });
  await rm(join(f.directory, 'restores', restore.id, 'result.json'));
  const next = f.docker.mock.calls.length;
  expect(await f.helper.restore(restore, Readable.from([bytes]))).toMatchObject({
    kind: 'failed',
    reason: containing('interrupted'),
  });
  expect(f.docker.mock.calls).toHaveLength(next);
});

it('rejects stale release, PostgreSQL 18, changed retry inputs, and byte overflow without exposing command output', async () => {
  const f = await fixture();
  const wrong = backupGuestCaptureSchema.parse({
    ...f.request,
    id: randomUUID(),
    recipe: { ...f.request.recipe, releaseId: randomUUID() },
  });
  expect((await f.helper.capture(wrong)).capture).toMatchObject({
    kind: 'failed',
    reason: containing('exact current'),
  });
  f.setMajor(18);
  expect((await f.helper.capture(f.request)).capture).toMatchObject({
    kind: 'failed',
    reason: containing('PostgreSQL 17'),
  });
  await expect(
    f.helper.capture({ ...f.request, limits: { ...f.request.limits, timeoutSeconds: 31 } }),
  ).rejects.toMatchObject({ failure: { code: 'idempotency_conflict' } });
  f.setMajor(17);
  f.setDump(Buffer.alloc(2_097_152, 'secret-output'));
  const reply = await f.helper.capture(
    backupGuestCaptureSchema.parse({ ...f.request, id: randomUUID() }),
  );
  expect(reply.capture).toMatchObject({
    kind: 'failed',
    reason: containing('byte limit'),
  });
  expect(JSON.stringify(reply)).not.toContain('secret-output');
});

it('rejects linked customer files and does not advance unrelated queued Compose work during restore', async () => {
  const f = await fixture();
  const { bytes, restore } = await f.capture();
  await symlink(join(f.customerDirectory, 'uploads'), join(f.customerDirectory, 'linked'));
  const linked = backupGuestCaptureSchema.parse({
    ...f.request,
    id: randomUUID(),
    recipe: { ...f.request.recipe, files: ['linked/one.txt'] },
  });
  expect((await f.helper.capture(linked)).capture).toMatchObject({
    kind: 'failed',
    reason: containing('real directories'),
  });
  const command = composeApplySchema.parse({
    ...f.command,
    app: 'queued',
    releaseId: randomUUID(),
  });
  await f.deployment.command(command);
  const calls = f.docker.mock.calls.length;
  expect(await f.helper.restore(restore, Readable.from([bytes]))).toMatchObject({
    kind: 'failed',
    reason: containing('finish first'),
  });
  expect(f.docker.mock.calls).toHaveLength(calls);
  expect(await f.deployment.current('queued')).toMatchObject({ phase: 'queued' });
});

it('verifies archive hash before creating any isolated app and rejects nonempty target apps', async () => {
  const f = await fixture();
  const { bytes, restore } = await f.capture();
  expect(
    await f.helper.restore({ ...restore, sha256: 'f'.repeat(64) }, Readable.from([bytes])),
  ).toMatchObject({ kind: 'failed', reason: containing('checksum') });
  expect(await f.deployment.current('restored')).toBeNull();
  expect(
    await f.helper.restore(
      restoreGuestRequestSchema.parse({ ...restore, id: randomUUID(), app: 'original' }),
      Readable.from([bytes]),
    ),
  ).toMatchObject({ kind: 'failed', reason: containing('empty managed app') });
});

it('bounds tar bytes, rejects duplicate or traversing entries, and returns promptly on archive failure', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'acld-archive-'));
  directories.push(scratch);
  const input = join(scratch, 'input');
  await writeFile(input, 'data', { mode: 0o600 });
  for (const names of [['../escape'], ['metadata.json', 'metadata.json']]) {
    const work = join(scratch, randomUUID());
    await mkdir(work);
    const archive = join(scratch, randomUUID());
    await packBackup(
      archive,
      names.map((name) => ({ name, path: input })),
      budget(),
    );
    await expect(unpackBackup(archive, work, budget())).rejects.toMatchObject({
      failure: { code: 'invalid_input' },
    });
  }
  await expect(
    packBackup(join(scratch, 'tiny'), [{ name: 'metadata.json', path: input }], {
      ...budget(),
      maximum: 5,
    }),
  ).rejects.toThrow();
  await writeFile(input, Buffer.alloc(100_000), { mode: 0o600 });
  const archive = join(scratch, 'large');
  await packBackup(archive, [{ name: 'file-0', path: input }], budget());
  const output = join(scratch, 'output');
  await mkdir(output);
  await expect(unpackBackup(archive, output, { ...budget(), maximum: 100 })).rejects.toMatchObject({
    failure: { code: 'quota_exceeded' },
  });
  await expect(readFile(join(dirname(scratch), 'escape'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('rebases only captured binds and refuses production volumes or host access', () => {
  const db = {
    image: 'postgres:17.9',
    volumes: [{ type: 'volume', source: 'data', target: '/var/lib/postgresql/data' }],
  };
  const input = {
    sourceRoot: '/source',
    customerRoot: '/customer',
    filesRoot: '/isolated',
    declared: ['uploads/a'],
    databaseService: 'db',
  };
  const config = {
    services: {
      db,
      app: {
        image: 'app',
        volumes: [{ type: 'bind', source: '/customer/uploads', target: '/uploads' }],
      },
    },
    volumes: { data: { name: 'production' } },
  };
  expect(isolatedBackupConfig(config, input).services['app']?.volumes?.[0]?.source).toBe(
    '/isolated/uploads',
  );
  expect(() =>
    isolatedBackupConfig({ ...config, volumes: { data: { external: true } } }, input),
  ).toThrow('project-owned');
  expect(() =>
    isolatedBackupConfig({ services: { db: { ...db, privileged: true } } }, input),
  ).toThrow('host access');
  expect(() =>
    isolatedBackupConfig(
      { services: { db, app: { volumes: [{ type: 'bind', source: '/etc', target: '/unsafe' }] } } },
      input,
    ),
  ).toThrow('outside captured');
});

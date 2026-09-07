import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  composeApplySchema,
  composeRecoverSchema,
  composeBundleSchema,
} from '../packages/contracts/src/compose.js';
import { createComposeDeployments } from '../packages/guestctl/src/compose.js';
import type { ComposeSystem } from '../packages/guestctl/src/compose-system.js';
import { readComposeBundle } from '../apps/cli/src/compose.js';
import * as files from '../packages/guestctl/src/files.js';
import { Readable } from 'node:stream';
import { readJsonInput } from '../packages/guestctl/src/input.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const image = 'sha256:' + 'a'.repeat(64);
it('retains Unicode across SSH chunk boundaries and bounds decoded request bytes', async () => {
  const value = { path: 'nested/☁️-日本語.txt' };
  const bytes = Buffer.from(JSON.stringify(value));
  const stream = () => Readable.from(Array.from(bytes, (byte) => Buffer.from([byte])));
  expect(await readJsonInput(stream(), bytes.length)).toEqual(value);
  await expect(readJsonInput(stream(), bytes.length - 1)).rejects.toMatchObject({
    failure: { code: 'invalid_input' },
  });
});
async function fixture() {
  const scratch = await mkdtemp(join(tmpdir(), 'acld-compose-'));
  directories.push(scratch);
  const directory = join(scratch, 'compose');
  const system = {
    start: vi.fn<ComposeSystem['start']>().mockResolvedValue(),
    compose: vi.fn<ComposeSystem['compose']>().mockImplementation((_project, _file, args) =>
      Promise.resolve(
        args[0] === 'config'
          ? JSON.stringify({
              services: {
                database: {
                  image: 'postgres',
                  volumes: [{ type: 'volume', source: 'acld-test-data', target: '/data' }],
                },
                backend: { build: '.' },
              },
            })
          : '',
      ),
    ),
    imageId: vi.fn<ComposeSystem['imageId']>().mockResolvedValue(image),
    imageVolumes: vi.fn<ComposeSystem['imageVolumes']>().mockResolvedValue([]),
  };
  const configuration = { directory, system };
  const command = composeApplySchema.parse({
    kind: 'apply',
    app: 'test',
    releaseId: randomUUID(),
    expectedReleaseId: null,
    files: [
      {
        path: 'compose.yaml',
        content: Buffer.from('services: {}').toString('base64'),
        executable: false,
      },
      {
        path: 'nested/deep/start.sh',
        content: Buffer.from('#!/bin/sh\n').toString('base64'),
        executable: true,
      },
    ],
  });
  return {
    ...configuration,
    configuration,
    command,
    deployment: createComposeDeployments(configuration),
    release: (id: string) => join(directory, 'test', 'releases', id),
  };
}

it('keeps admitted intent after a lost wakeup and pins built/pulled images before applying', async () => {
  const f = await fixture();
  const synced = vi.spyOn(files, 'syncDirectory');
  f.system.start.mockRejectedValueOnce(new Error('lost wakeup'));
  await expect(f.deployment.command(f.command)).rejects.toThrow('lost wakeup');
  expect(await f.deployment.current('test')).toMatchObject({ phase: 'queued' });
  const next = createComposeDeployments(f.configuration);
  await next.command(f.command);
  await next.work();
  expect(await next.current('test')).toMatchObject({
    phase: 'succeeded',
    images: { database: image, backend: image },
  });
  const runtime = await readFile(join(f.release(f.command.releaseId), 'runtime.json'), 'utf8');
  expect(runtime).not.toContain('"build"');
  expect(runtime).toContain('"pull_policy":"never"');
  expect(f.system.compose.mock.calls.at(-1)?.[2]).toEqual([
    'up',
    '--detach',
    '--wait',
    '--wait-timeout',
    '120',
    '--remove-orphans',
    '--no-build',
    '--pull',
    'never',
  ]);
  expect(
    (await stat(join(f.release(f.command.releaseId), 'source/nested/deep/start.sh'))).mode & 0o777,
  ).toBe(0o755);
  expect((await stat(join(f.release(f.command.releaseId), 'request.json'))).mode & 0o777).toBe(
    0o600,
  );
  for (const path of ['source', 'source/nested', 'source/nested/deep'])
    expect(synced).toHaveBeenCalledWith(join(f.release(f.command.releaseId), path));
  await next.command(f.command);
  await next.work();
  expect(f.system.compose.mock.calls.filter((call) => call[2][0] === 'up')).toHaveLength(1);
});

it('gives distinct case-sensitive service names distinct build tags', async () => {
  const f = await fixture();
  f.system.compose.mockImplementation((_project, _file, args) =>
    Promise.resolve(
      args[0] === 'config'
        ? JSON.stringify({ services: { api: { build: '.' }, API: { build: '.' } } })
        : '',
    ),
  );
  await f.deployment.command(f.command);
  await f.deployment.work();
  expect(f.system.imageId.mock.calls).toHaveLength(2);
  expect(f.system.imageId.mock.calls[0]?.[0]).not.toBe(f.system.imageId.mock.calls[1]?.[0]);
});

it('rejects changed retry inputs, concurrent releases and stale expected heads', async () => {
  const f = await fixture();
  await f.deployment.command(f.command);
  await expect(f.deployment.command({ ...f.command, waitSeconds: 30 })).rejects.toMatchObject({
    failure: { code: 'idempotency_conflict' },
  });
  await expect(
    f.deployment.command({
      ...f.command,
      releaseId: randomUUID(),
      expectedReleaseId: f.command.releaseId,
    }),
  ).rejects.toMatchObject({ failure: { code: 'resource_busy' } });
  await f.deployment.work();
  await expect(
    f.deployment.command({ ...f.command, releaseId: randomUUID() }),
  ).rejects.toMatchObject({ failure: { code: 'version_conflict' } });
  expect(await f.deployment.current('test')).toMatchObject({
    id: f.command.releaseId,
    phase: 'succeeded',
  });
});

it('recovers a previous runtime without pulling, rebuilding or deleting persistent volumes', async () => {
  const f = await fixture();
  await f.deployment.command(f.command);
  await f.deployment.work();
  const failed = { ...f.command, releaseId: randomUUID(), expectedReleaseId: f.command.releaseId };
  await f.deployment.command(failed);
  f.system.compose.mockRejectedValueOnce(new Error('bad source'));
  await f.deployment.work();
  expect(await f.deployment.current('test')).toMatchObject({
    phase: 'failed',
    previousSuccessfulReleaseId: f.command.releaseId,
  });
  const before = f.system.compose.mock.calls.length;
  const recovery = composeRecoverSchema.parse({
    kind: 'recover',
    app: 'test',
    releaseId: randomUUID(),
    expectedReleaseId: failed.releaseId,
    fromReleaseId: f.command.releaseId,
  });
  await f.deployment.command(recovery);
  await f.deployment.work();
  expect(await f.deployment.current('test')).toMatchObject({
    phase: 'succeeded',
    id: recovery.releaseId,
  });
  expect(f.system.compose.mock.calls.slice(before).map((call) => call[2][0])).toEqual(['up']);
  expect(await readFile(join(f.release(recovery.releaseId), 'runtime.json'), 'utf8')).toBe(
    await readFile(join(f.release(f.command.releaseId), 'runtime.json'), 'utf8'),
  );
  expect(f.system.compose.mock.calls.flatMap((call) => call[2])).not.toContain('down');
});

it('marks interrupted work without replay and refuses corrupted retained configuration', async () => {
  const f = await fixture();
  await f.deployment.command(f.command);
  const state = await f.deployment.current('test');
  await writeFile(
    join(f.release(f.command.releaseId), 'state.json'),
    JSON.stringify({ ...state, phase: 'applying' }),
    { mode: 0o600 },
  );
  await createComposeDeployments(f.configuration).work();
  expect(await f.deployment.current('test')).toMatchObject({ phase: 'interrupted' });
  expect(f.system.compose).not.toHaveBeenCalled();
  await f.deployment.command(f.command);
  expect(await f.deployment.current('test')).toMatchObject({ phase: 'interrupted' });
  const next = { ...f.command, releaseId: randomUUID(), expectedReleaseId: f.command.releaseId };
  await f.deployment.command(next);
  await f.deployment.work();
  await writeFile(join(f.release(next.releaseId), 'runtime.json'), '{}\n');
  await f.deployment.command(
    composeRecoverSchema.parse({
      kind: 'recover',
      app: 'test',
      releaseId: randomUUID(),
      expectedReleaseId: next.releaseId,
      fromReleaseId: next.releaseId,
    }),
  );
  await f.deployment.work();
  expect(await f.deployment.current('test')).toMatchObject({ phase: 'failed' });
});

it('refuses image-declared anonymous storage and writable source mounts before changing containers', async () => {
  const f = await fixture();
  f.system.imageVolumes.mockResolvedValue(['/var/lib/postgresql/data']);
  await f.deployment.command(f.command);
  await f.deployment.work();
  expect(await f.deployment.current('test')).toMatchObject({
    phase: 'failed',
  });
  expect((await f.deployment.current('test'))?.failure).toContain('image declares');
  expect(f.system.compose.mock.calls.some((call) => call[2][0] === 'up')).toBe(false);
  const next = { ...f.command, releaseId: randomUUID(), expectedReleaseId: f.command.releaseId };
  f.system.compose.mockResolvedValue(
    JSON.stringify({
      services: {
        app: {
          image: 'test',
          volumes: [
            { type: 'bind', source: join(f.release(next.releaseId), 'source'), target: '/app' },
          ],
        },
      },
    }),
  );
  await f.deployment.command(next);
  await f.deployment.work();
  expect(await f.deployment.current('test')).toMatchObject({
    phase: 'failed',
  });
  expect((await f.deployment.current('test'))?.failure).toContain('read-only');
});

it('validates source paths and local file types before an authenticated upload', async () => {
  const f = await fixture();
  expect(
    composeBundleSchema.safeParse([{ path: '../escape', content: 'YQ==', executable: false }])
      .success,
  ).toBe(false);
  expect(
    composeBundleSchema.safeParse([
      { path: 'a', content: '', executable: false },
      { path: 'a', content: '', executable: false },
    ]).success,
  ).toBe(false);
  const source = join(f.directory, 'local');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'compose.yaml'), 'services: {}');
  await writeFile(join(source, 'empty'), '');
  expect(await readComposeBundle(source)).toHaveLength(2);
  await symlink('/etc/passwd', join(source, 'link'));
  await expect(readComposeBundle(source)).rejects.toThrow('regular files only');
});

import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createReferenceDeployment } from '../packages/guestctl/src/reference.js';
import type { ReferenceCommand } from '../packages/contracts/src/index.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'acld-reference-'));
  directories.push(directory);
  const binary = join(directory, 'input.mjs');
  await writeFile(binary, '// public guest bundle\n');
  const start = vi.fn<() => Promise<void>>().mockResolvedValue();
  const compose = vi
    .fn<(directory: string, args: string[]) => Promise<string>>()
    .mockResolvedValue('');
  const configuration = { directory: join(directory, 'state'), binary, system: { start, compose } };
  return {
    configuration,
    start,
    compose,
    deployment: createReferenceDeployment(configuration),
    command: {
      kind: 'apply',
      releaseId: randomUUID(),
      expectedReleaseId: null,
      revision: '1',
      hostname: 'reference.localhost',
    } satisfies ReferenceCommand,
  };
}

it('persists pending intent before a lost start response, replays it and resumes after process replacement', async () => {
  const f = await fixture();
  f.start.mockRejectedValueOnce(new Error('lost response'));
  await expect(f.deployment.command(f.command)).rejects.toThrow('lost response');
  expect(await f.deployment.state()).toMatchObject({
    kind: 'release',
    phase: 'pending',
    release: { releaseId: f.command.releaseId },
  });
  const restarted = createReferenceDeployment(f.configuration);
  await restarted.command(f.command);
  await restarted.work();
  expect(await restarted.state()).toMatchObject({ phase: 'succeeded' });
  expect(f.compose.mock.calls.map((call) => call[1][0])).toEqual(['config', 'build', 'up']);
  await restarted.command(f.command);
  expect(f.start).toHaveBeenCalledTimes(2);
});

it('rejects competing or repurposed releases and retains database credentials and volume identity on update', async () => {
  const f = await fixture();
  await f.deployment.command(f.command);
  await expect(f.deployment.command({ ...f.command, revision: '2' })).rejects.toThrow(
    'different request',
  );
  await expect(
    f.deployment.command({
      ...f.command,
      releaseId: randomUUID(),
      expectedReleaseId: f.command.releaseId,
    }),
  ).rejects.toThrow('still active');
  await f.deployment.work();
  const secret = join(f.configuration.directory, 'database-password');
  const original = await readFile(secret, 'utf8');
  const next = {
    ...f.command,
    releaseId: randomUUID(),
    expectedReleaseId: f.command.releaseId,
    revision: '2',
  } satisfies ReferenceCommand;
  await f.deployment.command(next);
  await f.deployment.work();
  expect(await readFile(secret, 'utf8')).toBe(original);
  expect((await stat(secret)).mode & 0o777).toBe(0o444);
  expect((await stat(f.configuration.directory)).mode & 0o777).toBe(0o700);
  const recipe = await readFile(
    join(f.configuration.directory, 'releases', next.releaseId, 'compose.json'),
    'utf8',
  );
  expect(recipe).toContain('database:/var/lib/postgresql/data');
  expect(recipe).not.toContain(original.trim());
  await expect(f.deployment.command(f.command)).rejects.toThrow('Expected release');
  expect(await f.deployment.state()).toMatchObject({
    phase: 'succeeded',
    release: { releaseId: next.releaseId },
  });
});

it('records failed Compose work and supports an explicit subsequent recovery release without deleting data', async () => {
  const f = await fixture();
  await f.deployment.command(f.command);
  f.compose.mockRejectedValueOnce(new Error('engine unavailable'));
  await expect(f.deployment.work()).rejects.toThrow('Reference deployment failed');
  expect(await f.deployment.state()).toMatchObject({ phase: 'failed' });
  await f.deployment.work();
  expect(f.compose).toHaveBeenCalledTimes(1);
  const retry = { ...f.command, releaseId: randomUUID(), expectedReleaseId: f.command.releaseId };
  await f.deployment.command(retry);
  await f.deployment.work();
  expect(await f.deployment.state()).toMatchObject({ phase: 'succeeded' });
  expect(f.compose.mock.calls.flatMap((call) => call[1])).not.toContain('--volumes');
});

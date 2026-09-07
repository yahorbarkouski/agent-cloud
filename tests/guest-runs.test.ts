import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runCommandSchema, runIdSchema } from '../packages/contracts/dist/index.js';
import { createGuestRuns } from '../packages/guestctl/src/runs.js';

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture(code = "process.stdout.write('completed\\n')") {
  const directory = await mkdtemp(join(tmpdir(), 'acld-runs-'));
  directories.push(directory);
  const id = runIdSchema.parse(randomUUID());
  let bootId = randomUUID();
  const start = vi.fn<() => Promise<void>>().mockResolvedValue();
  const stop = vi.fn<() => Promise<void>>().mockResolvedValue();
  const active = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
  const activeCount = vi.fn<() => Promise<number>>().mockResolvedValue(0);
  const configuration = {
    directory,
    system: { bootId: () => Promise.resolve(bootId), start, stop, active, activeCount },
  };
  const runs = createGuestRuns(configuration);
  const command = runCommandSchema.parse({
    kind: 'submit',
    id,
    request: { argv: [process.execPath, '-e', code], cwd: directory },
  });
  return {
    directory,
    id,
    runs,
    command,
    configuration,
    start,
    stop,
    active,
    activeCount,
    reboot: () => {
      bootId = randomUUID();
    },
  };
}

it('persists intent before a lost start response and recovers one actual invocation and its output', async () => {
  const f = await fixture(
    "require('node:fs').appendFileSync('effects', 'once\\n'); process.stdout.write('saved output\\n')",
  );
  f.start.mockRejectedValueOnce(new Error('lost start response'));
  await expect(f.runs.command(f.command)).rejects.toThrow('lost start response');
  expect(JSON.parse(await readFile(join(f.directory, f.id, 'request.json'), 'utf8'))).toMatchObject(
    { id: f.id },
  );
  const restarted = createGuestRuns(f.configuration);
  await restarted.command(f.command);
  await restarted.work(f.id);
  expect((await restarted.command({ kind: 'inspect', id: f.id })).run.state).toMatchObject({
    kind: 'exited',
    code: 0,
  });
  await restarted.command(f.command);
  await restarted.work(f.id);
  expect(await readFile(join(f.directory, 'effects'), 'utf8')).toBe('once\n');
  expect((await restarted.command({ kind: 'logs', id: f.id, cursor: 0 })).logs).toEqual([
    { stream: 'stdout', text: 'saved output\n' },
  ]);
  expect((await stat(join(f.directory, f.id, 'request.json'))).mode & 0o777).toBe(0o600);
  expect((await stat(join(f.directory, f.id, 'output.jsonl'))).mode & 0o777).toBe(0o600);
});

it('refuses changed arguments for an invocation and never repeats an uncertain spawn', async () => {
  const f = await fixture();
  await f.runs.command(f.command);
  const changed = runCommandSchema.parse({ ...f.command, request: { argv: ['/bin/false'] } });
  await expect(f.runs.command(changed)).rejects.toThrow('different request');
  await writeFile(
    join(f.directory, f.id, 'started.json'),
    JSON.stringify({ startedAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
  await f.runs.work(f.id);
  const result = await f.runs.command({ kind: 'inspect', id: f.id });
  expect(result.run.state).toMatchObject({ kind: 'terminated', reason: 'interrupted' });
  await f.runs.command(f.command);
  expect(f.start).toHaveBeenCalledTimes(1);
  await expect(readFile(join(f.directory, f.id, 'output.jsonl'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('records a reboot interruption even before spawn and preserves it on replay', async () => {
  const f = await fixture();
  await f.runs.command(f.command);
  f.reboot();
  const result = await f.runs.command(f.command);
  expect(result.run.state).toMatchObject({ kind: 'terminated', reason: 'interrupted' });
  expect(f.start).toHaveBeenCalledTimes(1);
  await f.runs.work(f.id);
  await expect(readFile(join(f.directory, f.id, 'started.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('cancels pending work durably without spawning it, even after a lost stop response', async () => {
  const f = await fixture();
  await f.runs.command(f.command);
  f.stop.mockRejectedValueOnce(new Error('lost stop response'));
  await expect(f.runs.command({ kind: 'cancel', id: f.id })).rejects.toThrow('lost stop response');
  await f.runs.work(f.id);
  expect((await f.runs.command(f.command)).run.state).toMatchObject({
    kind: 'terminated',
    reason: 'cancelled',
  });
  expect(f.start).toHaveBeenCalledTimes(1);
});

it.each(['timeout', 'output_limit'])(
  'bounds actual command time and output: %s',
  async (reason) => {
    const f = await fixture(
      reason === 'timeout'
        ? 'setInterval(() => {}, 1000)'
        : "process.stdout.write('x'.repeat(100000)); setInterval(() => {}, 1000)",
    );
    const command = runCommandSchema.parse({
      ...f.command,
      request: {
        ...('request' in f.command ? f.command.request : {}),
        timeoutSeconds: 1,
        maximumOutputBytes: 1024,
      },
    });
    await f.runs.command(command);
    await f.runs.work(f.id);
    const result = await f.runs.command({ kind: 'logs', id: f.id, cursor: 0 });
    expect(result.run.state).toMatchObject({ kind: 'terminated', reason });
    expect((await stat(join(f.directory, f.id, 'output.jsonl'))).size).toBeLessThanOrEqual(1024);
  },
);

it('refuses excess concurrent work before recording new intent', async () => {
  const f = await fixture();
  f.activeCount.mockResolvedValue(4);
  await expect(f.runs.command(f.command)).rejects.toThrow('Concurrent');
  await expect(readFile(join(f.directory, f.id, 'request.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('finishes a timeout when a detached helper keeps inherited output pipes open', async () => {
  const f = await fixture(`
    const helper = require('node:child_process').spawn(
      process.execPath, ['-e', 'setTimeout(() => {}, 6500)'],
      { detached: true, stdio: ['ignore', 'inherit', 'inherit'] },
    );
    require('node:fs').writeFileSync('helper-pid', String(helper.pid));
    setInterval(() => {}, 1000);
  `);
  const command = runCommandSchema.parse({
    ...f.command,
    request: { ...('request' in f.command ? f.command.request : {}), timeoutSeconds: 1 },
  });
  await f.runs.command(command);
  const started = performance.now();
  try {
    await f.runs.work(f.id);
    expect(performance.now() - started).toBeLessThan(5500);
    expect((await f.runs.command({ kind: 'inspect', id: f.id })).run.state).toMatchObject({
      kind: 'terminated',
      reason: 'timeout',
    });
  } finally {
    // Production systemd reaps the cgroup. This host fixture owns only this exact helper PID.
    const pid = Number(await readFile(join(f.directory, 'helper-pid'), 'utf8'));
    expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      expect(error).toMatchObject({ code: 'ESRCH' });
    }
  }
});

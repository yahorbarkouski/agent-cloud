import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { open, readFile, readdir, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  runIdSchema,
  runRequestSchema,
  runResultSchema,
  runSummarySchema,
  runLogEntrySchema,
  runResponseSchema,
  type RunCommand,
  type RunRequest,
  type RunResult,
  type RunId,
  CloudError,
} from '@agent-cloud/contracts';
import { atomicWrite, ensureDirectory, isMissing, readOwnedFile, syncDirectory } from './files.js';

const savedRequestSchema = z.strictObject({
  id: runIdSchema,
  request: runRequestSchema,
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  bootId: z.uuid(),
  submittedAt: z.iso.datetime(),
});
const startSchema = z.strictObject({ startedAt: z.iso.datetime() });
const cancelledSchema = z.strictObject({ requestedAt: z.iso.datetime() });
type Termination = Extract<RunResult, { kind: 'terminated' }>['reason'];
type RunSystem = {
  bootId: () => Promise<string>;
  start: (id: string) => Promise<void>;
  stop: (id: string) => Promise<void>;
  active: (id: string) => Promise<boolean>;
  activeCount: () => Promise<number>;
};
const unit = (id: string) => `agent-cloud-run@${runIdSchema.parse(id)}.service`;
async function systemctl(args: string[]) {
  try {
    return (
      await promisify(execFile)('/usr/bin/systemctl', args, {
        timeout: 15_000,
        maxBuffer: 65_536,
        env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      })
    ).stdout;
  } catch {
    throw new Error('Durable command service is unavailable.');
  }
}
export const runSystem: RunSystem = {
  bootId: async () =>
    z.uuid().parse((await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()),
  start: async (id) => {
    await systemctl(['start', '--no-block', unit(id)]);
  },
  stop: async (id) => {
    await systemctl(['stop', unit(id)]);
  },
  active: async (id) =>
    ['active', 'activating', 'deactivating', 'reloading'].includes(
      (await systemctl(['show', '--property=ActiveState', '--value', unit(id)])).trim(),
    ),
  activeCount: async () =>
    (
      await systemctl([
        'list-units',
        '--plain',
        '--no-legend',
        '--state=active,activating,deactivating,reloading',
        'agent-cloud-run@*.service',
      ])
    )
      .trim()
      .split('\n')
      .filter(Boolean).length,
};

/** Guest records are customer diagnostics. Root can change them; never use them as billing evidence. */
export function createGuestRuns(input: { directory: string; system: RunSystem }) {
  const path = (id: string, file: string) => join(input.directory, runIdSchema.parse(id), file);
  async function optional<T>(id: string, file: string, schema: z.ZodType<T>) {
    try {
      return schema.parse(JSON.parse(await readOwnedFile(path(id, file), 'private', 524_288)));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }
  async function saved(id: string) {
    const value = await optional(id, 'request.json', savedRequestSchema);
    if (!value || value.id !== id)
      throw new CloudError('not_found', 'Durable command does not exist.');
    return value;
  }
  const save = (id: string, file: string, value: unknown) =>
    atomicWrite(path(id, file), JSON.stringify(value) + '\n', 0o600);
  const terminated = (reason: Termination): RunResult => ({
    kind: 'terminated',
    reason,
    finishedAt: new Date().toISOString(),
  });
  async function summary(id: string) {
    const request = await saved(id);
    let result = await optional(id, 'result.json', runResultSchema);
    const started = await optional(id, 'started.json', startSchema);
    const cancelled = await optional(id, 'cancelled.json', cancelledSchema);
    const sameBoot = request.bootId === (await input.system.bootId());
    const active = sameBoot && (await input.system.active(id));
    if (!result && (!sameBoot || (!active && (started || cancelled)))) {
      result = terminated(cancelled ? 'cancelled' : 'interrupted');
      // Admission/cancel/inspection share the wrapper lock. An inactive or old-boot
      // worker cannot still publish a result; persist its observed terminal outcome.
      await save(id, 'result.json', result);
    }
    return runSummarySchema.parse({
      id,
      requestDigest: request.requestDigest,
      submittedAt: request.submittedAt,
      state:
        result ??
        (cancelled
          ? { kind: 'cancelling' }
          : started
            ? { kind: 'running', startedAt: started.startedAt }
            : { kind: 'queued' }),
    });
  }
  async function command(command: RunCommand) {
    await ensureDirectory(input.directory, 0o700);
    // Enrollment already owns the parent. Preserve the first runs-directory entry
    // before admitting anything whose execution could outlive a host crash.
    await syncDirectory(dirname(input.directory));
    if (command.kind === 'submit') {
      const request = {
        ...command.request,
        env: Object.fromEntries(
          Object.entries(command.request.env).sort(([a], [b]) => a.localeCompare(b)),
        ),
      };
      const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
      const existing = await optional(command.id, 'request.json', savedRequestSchema);
      if (existing && existing.requestDigest !== digest)
        throw new CloudError(
          'idempotency_conflict',
          'Invocation ID belongs to a different request.',
        );
      if (!existing) {
        if ((await readdir(input.directory)).length >= 1024)
          throw new CloudError('quota_exceeded', 'Retained invocation limit reached.');
        const disk = await statfs(input.directory);
        if (disk.bavail * disk.bsize < 268_435_456)
          throw new CloudError(
            'quota_exceeded',
            'Insufficient free disk for durable command records.',
          );
        if ((await input.system.activeCount()) >= 4)
          throw new CloudError('resource_busy', 'Concurrent command limit reached.', true);
        await ensureDirectory(join(input.directory, command.id), 0o700);
        await syncDirectory(input.directory);
        await save(command.id, 'request.json', {
          id: command.id,
          request,
          requestDigest: digest,
          bootId: await input.system.bootId(),
          submittedAt: new Date().toISOString(),
        });
      }
      const current = await summary(command.id);
      if (current.state.kind === 'queued') {
        if ((await input.system.activeCount()) >= 4)
          throw new CloudError(
            'resource_busy',
            'Concurrent command limit reached; retain this invocation ID.',
            true,
          );
        await input.system.start(command.id);
      }
    } else if (command.kind === 'cancel') {
      const current = await summary(command.id);
      if (['queued', 'running', 'cancelling'].includes(current.state.kind)) {
        if (!(await optional(command.id, 'cancelled.json', cancelledSchema)))
          await save(command.id, 'cancelled.json', { requestedAt: new Date().toISOString() });
        await input.system.stop(command.id);
      }
    }
    const run = await summary(command.id);
    let entries: z.infer<typeof runLogEntrySchema>[] = [];
    if (command.kind === 'logs') {
      try {
        const bytes = await readOwnedFile(path(command.id, 'output.jsonl'), 'private', 1_048_576);
        // A power loss may leave the last record incomplete. Never invent the missing bytes.
        entries = bytes
          .slice(0, bytes.lastIndexOf('\n') + 1)
          .split('\n')
          .filter(Boolean)
          .map((line) => runLogEntrySchema.parse(JSON.parse(line)));
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    const cursor = command.kind === 'logs' ? command.cursor : 0;
    if (cursor > entries.length)
      throw new CloudError('invalid_input', 'Log cursor is beyond retained output.');
    // Bound a reply by both entries and serialized bytes, even for a verbose command.
    const logs: typeof entries = [];
    let size = 0;
    for (const entry of entries.slice(cursor, cursor + 64)) {
      const bytes = Buffer.byteLength(JSON.stringify(entry));
      if (logs.length && size + bytes > 65_536) break;
      logs.push(entry);
      size += bytes;
    }
    return runResponseSchema.parse({
      run,
      logs,
      nextCursor: cursor + logs.length,
      complete:
        !['queued', 'running', 'cancelling'].includes(run.state.kind) &&
        cursor + logs.length === entries.length,
    });
  }

  /** The systemd worker holds a per-invocation flock for its entire lifetime. */
  async function work(id: RunId) {
    const value = await saved(id);
    if (
      (await optional(id, 'started.json', startSchema)) ||
      (await optional(id, 'result.json', runResultSchema))
    )
      return;
    if (
      value.bootId !== (await input.system.bootId()) ||
      (await optional(id, 'cancelled.json', cancelledSchema))
    )
      return;
    // This receipt precedes spawn and never disappears. A lost outcome is interrupted,
    // even if the crash happened just before spawn; arbitrary commands never replay.
    await save(id, 'started.json', { startedAt: new Date().toISOString() });
    let result = await execute(value.request, path(id, 'output.jsonl'));
    if (
      result.kind === 'terminated' &&
      result.reason === 'interrupted' &&
      (await optional(id, 'cancelled.json', cancelledSchema))
    )
      result = { ...result, reason: 'cancelled' };
    await save(id, 'result.json', result);
  }
  return { command, work };
}

async function execute(request: RunRequest, outputPath: string): Promise<RunResult> {
  const output = await open(outputPath, 'wx', 0o600);
  let reason: Termination | undefined;
  let hardKill: ReturnType<typeof setTimeout> | undefined;
  let queued = Promise.resolve();
  let bytes = 0;
  const child = spawn(request.argv[0], request.argv.slice(1), {
    cwd: request.cwd,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/root', LANG: 'C.UTF-8', ...request.env },
  });
  const kill = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
  };
  const stop = (why: Termination) => {
    if (reason) return;
    reason = why;
    kill('SIGTERM');
    hardKill = setTimeout(() => {
      kill('SIGKILL');
      // A detached descendant may retain the pipe write ends. Finish this worker
      // so systemd can reap the entire cgroup, including other process groups.
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }, 3000);
  };
  const interrupted = () => {
    stop('interrupted');
  };
  process.once('SIGTERM', interrupted);
  process.once('SIGINT', interrupted);
  const timeout = setTimeout(() => {
    stop('timeout');
  }, request.timeoutSeconds * 1000);
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  function append(stream: 'stdout' | 'stderr', text: string) {
    if (!text || reason === 'output_limit') return;
    // Bound JSON records, including worst-case escaping, without splitting a surrogate pair.
    if (text.length > 8192) {
      let cut = 8192;
      if (text.charCodeAt(cut - 1) >= 0xd800 && text.charCodeAt(cut - 1) <= 0xdbff) cut--;
      append(stream, text.slice(0, cut));
      append(stream, text.slice(cut));
      return;
    }
    const line = JSON.stringify({ stream, text }) + '\n';
    bytes += Buffer.byteLength(line);
    if (bytes > request.maximumOutputBytes) {
      stop('output_limit');
      return;
    }
    queued = queued
      .then(async () => {
        await output.writeFile(line);
        await output.sync();
      })
      .catch(() => {
        stop('interrupted');
      });
  }
  child.stdout.on('data', (chunk: Buffer) => {
    append('stdout', decoders.stdout.write(chunk));
  });
  child.stderr.on('data', (chunk: Buffer) => {
    append('stderr', decoders.stderr.write(chunk));
  });
  child.stdin.on('error', () => {});
  child.stdin.end(request.stdin);
  try {
    const code = await new Promise<number | null>((resolve) => {
      child.once('error', () => {
        reason = 'start_failed';
      });
      child.once('close', resolve);
    });
    append('stdout', decoders.stdout.end());
    append('stderr', decoders.stderr.end());
    await queued;
    await output.sync();
    const finishedAt = new Date().toISOString();
    return reason || code === null
      ? { kind: 'terminated', reason: reason ?? 'interrupted', finishedAt }
      : { kind: 'exited', code, finishedAt };
  } finally {
    clearTimeout(timeout);
    clearTimeout(hardKill);
    process.removeListener('SIGTERM', interrupted);
    process.removeListener('SIGINT', interrupted);
    await output.close();
  }
}

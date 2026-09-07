import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { Command } from 'commander';
import { z } from 'zod';
import {
  CloudError,
  machineIdSchema,
  runCommandSchema,
  runRequestSchema,
  runReplySchema,
  runIdSchema,
} from '@agent-cloud/contracts';
import type { CloudClient } from '@agent-cloud/sdk';
import { invokeGuest } from './guest-command.js';

async function readRequest(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.size > 262_144 ||
      info.mode & 0o077 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new CloudError('permission_denied', 'Command request must be a small owner-only file.');
    return runRequestSchema.parse(JSON.parse(await file.readFile('utf8')));
  } finally {
    await file.close();
  }
}

export function registerRuns(input: {
  program: Command;
  client: () => Promise<CloudClient>;
  output: (value: unknown) => void;
}) {
  async function invoke(machine: string, value: unknown) {
    const request = JSON.stringify(runCommandSchema.parse(value));
    if (Buffer.byteLength(request) > 262_144)
      throw new CloudError('invalid_input', 'Command request exceeds its size limit.');
    const result = await invokeGuest({
      client: await input.client(),
      machine: machineIdSchema.parse(machine),
      command: 'run',
      request,
    });
    const reply = runReplySchema.parse(JSON.parse(result));
    if ('error' in reply)
      throw new CloudError(reply.error.code, reply.error.message, reply.error.retryable);
    input.output(reply);
  }
  const run = input.program
    .command('run')
    .description('Submit and inspect commands that survive a CLI disconnect.');
  run
    .command('submit <machine>')
    .requiredOption('--id <uuid>', 'Stable invocation ID; keep it after a lost response')
    .requiredOption(
      '--request <path>',
      'Owner-only JSON file with argv, cwd, env and optional limits',
    )
    .action(async (machine: string, raw: unknown) => {
      const args = z.object({ id: runIdSchema, request: z.string() }).parse(raw);
      await invoke(machine, {
        kind: 'submit',
        id: args.id,
        request: await readRequest(args.request),
      });
    });
  for (const kind of ['inspect', 'cancel'] satisfies Array<'inspect' | 'cancel'>)
    run.command(`${kind} <machine> <id>`).action(async (machine: string, id: string) => {
      await invoke(machine, { kind, id });
    });
  run
    .command('logs <machine> <id>')
    .option('--after <cursor>', 'Saved output cursor', '0')
    .action(async (machine: string, id: string, raw: unknown) => {
      const { after } = z.object({ after: z.coerce.number().int().nonnegative() }).parse(raw);
      await invoke(machine, { kind: 'logs', id, cursor: after });
    });
}

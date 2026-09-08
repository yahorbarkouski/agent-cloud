import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { Command } from 'commander';
import type { CloudClient } from '@agent-cloud/sdk';
import {
  CloudError,
  composeAppSchema,
  composeReleaseIdSchema,
  composeBundleSchema,
  composeCommandSchema,
  composeReplySchema,
  machineIdSchema,
  composePathSchema,
} from '@agent-cloud/contracts';
import { invokeGuest } from './guest-command.js';

/** Explicit deployment context, like Docker's context. No implicit ignores or symlink traversal. */
export async function readComposeBundle(directory: string) {
  const files: z.infer<typeof composeBundleSchema> = [];
  let bytes = 0;
  async function walk(path: string, prefix: string) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new CloudError(
        'invalid_input',
        'Deployment source must be a regular directory without symlinks.',
      );
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const relative = composePathSchema.parse(prefix ? `${prefix}/${entry.name}` : entry.name);
      const source = join(path, entry.name);
      if (entry.isDirectory()) {
        await walk(source, relative);
        continue;
      }
      if (!entry.isFile())
        throw new CloudError(
          'invalid_input',
          'Deployment context supports regular files only; remove links, sockets and device files.',
        );
      const handle = await open(
        source,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 8_388_608 - bytes || files.length >= 1024)
          throw new CloudError(
            'quota_exceeded',
            'Deployment context exceeds 8 MiB or 1024 files. Prepare a small context without dependencies or repository history.',
          );
        // Read only the inspected length plus one byte. A growing file cannot turn
        // a bounded source upload into an unbounded allocation or a mixed snapshot.
        const buffer = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const result = await handle.read(buffer, length, buffer.length - length, null);
          if (result.bytesRead === 0) break;
          length += result.bytesRead;
        }
        if (length !== stat.size)
          throw new CloudError(
            'invalid_input',
            'Deployment source changed while being read. Retry after preparing a stable context.',
          );
        const content = buffer.subarray(0, length);
        bytes += length;
        if (bytes > 8_388_608)
          throw new CloudError('quota_exceeded', 'Deployment context grew beyond 8 MiB.');
        files.push({
          path: relative,
          content: content.toString('base64'),
          executable: Boolean(stat.mode & 0o111),
        });
      } finally {
        await handle.close();
      }
    }
  }
  await walk(resolve(directory), '');
  return composeBundleSchema.parse(files.sort((a, b) => a.path.localeCompare(b.path)));
}

export function registerCompose(input: {
  program: Command;
  client: () => Promise<CloudClient>;
  output: (value: unknown) => void;
}) {
  const compose = input.program
    .command('compose')
    .description('Apply ordinary Compose source files and recover a retained release.');
  async function invoke(machine: string, value: unknown) {
    const request = JSON.stringify(composeCommandSchema.parse(value));
    if (Buffer.byteLength(request) > 16_777_216)
      throw new CloudError('invalid_input', 'Deployment request exceeds 16 MiB.');
    const reply = composeReplySchema.parse(
      JSON.parse(
        await invokeGuest({
          client: await input.client(),
          machine: machineIdSchema.parse(machine),
          command: 'compose',
          request,
        }),
      ),
    );
    if ('error' in reply)
      throw new CloudError(reply.error.code, reply.error.message, reply.error.retryable);
    input.output(reply);
  }
  const options = z.object({
    release: composeReleaseIdSchema,
    expectedRelease: composeReleaseIdSchema.optional(),
    waitSeconds: z.coerce.number().int().min(5).max(300),
  });
  compose
    .command('apply <machine> <app>')
    .requiredOption(
      '--source <directory>',
      'Local deployment context; all regular files are included',
    )
    .option('--file <path>', 'Compose file relative to source', 'compose.yaml')
    .requiredOption('--release <uuid>', 'Stable release ID; retain it after a lost reply')
    .option('--expected-release <uuid>', 'Current release; omit only for the first deployment')
    .option('--wait-seconds <seconds>', 'Guest service health deadline', '120')
    .action(async (machine: string, app: string, raw: unknown) => {
      const args = options.extend({ source: z.string(), file: composePathSchema }).parse(raw);
      await invoke(machine, {
        kind: 'apply',
        app,
        releaseId: args.release,
        expectedReleaseId: args.expectedRelease ?? null,
        waitSeconds: args.waitSeconds,
        file: args.file,
        files: await readComposeBundle(args.source),
      });
    });
  compose
    .command('promote <machine> <app>')
    .description(
      'Enable egress and loopback ports for the current isolated restore; routes are unchanged.',
    )
    .requiredOption('--release <uuid>', 'New promotion release ID; retain it after a lost reply')
    .requiredOption('--expected-release <uuid>', 'Current verified isolated release')
    .option('--wait-seconds <seconds>', 'Guest service health deadline', '120')
    .action(async (machine: string, app: string, raw: unknown) => {
      const args = options.extend({ expectedRelease: composeReleaseIdSchema }).parse(raw);
      await invoke(machine, {
        kind: 'promote',
        app,
        releaseId: args.release,
        expectedReleaseId: args.expectedRelease,
        fromReleaseId: args.expectedRelease,
        waitSeconds: args.waitSeconds,
      });
    });
  compose
    .command('recover <machine> <app>')
    .requiredOption(
      '--from <uuid>',
      'Previously succeeded release; database changes are not reversed',
    )
    .requiredOption('--release <uuid>', 'New recovery release ID')
    .requiredOption('--expected-release <uuid>', 'Current release, including a failed attempt')
    .option('--wait-seconds <seconds>', 'Guest service health deadline', '120')
    .action(async (machine: string, app: string, raw: unknown) => {
      const args = options
        .extend({ from: composeReleaseIdSchema, expectedRelease: composeReleaseIdSchema })
        .parse(raw);
      await invoke(machine, {
        kind: 'recover',
        app,
        releaseId: args.release,
        expectedReleaseId: args.expectedRelease,
        fromReleaseId: args.from,
        waitSeconds: args.waitSeconds,
      });
    });
  compose.command('inspect <machine> <app>').action(async (machine: string, app: string) => {
    await invoke(machine, { kind: 'inspect', app });
  });
  compose
    .command('logs <machine> <app>')
    .option('--service <name>', 'Only this service')
    .action(async (machine: string, app: string, raw: unknown) => {
      const { service } = z.object({ service: z.string().optional() }).parse(raw);
      await invoke(machine, { kind: 'logs', app, ...(service ? { service } : {}) });
    });
  compose
    .command('wait <machine> <app>')
    .description('Wait up to five minutes in one authenticated connection.')
    .action(async (machine: string, app: string) => {
      const reply = composeReplySchema.parse(
        JSON.parse(
          await invokeGuest({
            client: await input.client(),
            machine: machineIdSchema.parse(machine),
            command: 'compose-wait',
            app: composeAppSchema.parse(app),
            request: '',
          }),
        ),
      );
      if ('error' in reply)
        throw new CloudError(reply.error.code, reply.error.message, reply.error.retryable);
      input.output(reply);
      if (reply.release?.phase !== 'succeeded') process.exitCode = 1;
    });
}

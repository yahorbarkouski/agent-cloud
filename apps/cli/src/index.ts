#!/usr/bin/env node
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Command, CommanderError } from 'commander';
import { z } from 'zod';
import {
  CloudError,
  credentialsSchema,
  apiUrlSchema,
  projectIdSchema,
  machineIdSchema,
  operationIdSchema,
  sizeSchema,
  regionSchema,
  machineActionSchema,
} from '@agent-cloud/contracts';
import { CloudClient } from '@agent-cloud/sdk';

const program = new Command()
  .name('acld')
  .description('Operate agent-cloud with structured JSON results.')
  .version('0.1.0');
program.exitOverride();
const credentialsPath = () =>
  resolve(
    process.env.ACLD_CREDENTIALS ?? join(homedir(), '.config', 'agent-cloud', 'credentials.json'),
  );
async function client() {
  const data: unknown = JSON.parse(await readFile(credentialsPath(), 'utf8'));
  return new CloudClient(credentialsSchema.parse(data));
}
function output(value: unknown) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

program
  .command('login')
  .description('Validate a token from stdin and save it with owner-only permissions.')
  .requiredOption('--server <url>')
  .requiredOption('--token-stdin')
  .action(async (raw: unknown) => {
    const options = z.object({ server: apiUrlSchema, tokenStdin: z.literal(true) }).parse(raw);
    let token = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      token += z.string().parse(chunk);
      if (token.length > 512) throw new CloudError('invalid_input', 'Token input is too long.');
    }
    const credentials = credentialsSchema.parse({ server: options.server, token: token.trim() });
    const result = await new CloudClient(credentials).whoami();
    const path = credentialsPath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(credentials) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
    output({ principal: result.principal, credentialsFile: path });
  });
program.command('whoami').action(async () => {
  output(await (await client()).whoami());
});
program.command('catalog').action(async () => {
  output(await (await client()).catalog());
});
program.command('usage').action(async () => {
  output(await (await client()).usage());
});
const project = program.command('project');
project.command('list').action(async () => {
  output(await (await client()).projects());
});
project.command('create <name>').action(async (name: string) => {
  output(await (await client()).createProject(name));
});
const machine = program.command('machine');
machine
  .command('list')
  .requiredOption('--project <id>')
  .action(async (raw: unknown) => {
    const options = z.object({ project: projectIdSchema }).parse(raw);
    output(await (await client()).machines(options.project));
  });
machine.command('inspect <id>').action(async (id: string) => {
  output(await (await client()).machine(machineIdSchema.parse(id)));
});
machine
  .command('create <name>')
  .requiredOption('--project <id>')
  .option('--size <size>', 'small, medium, or large', 'small')
  .option('--region <region>', 'nbg1, fsn1, or hel1', 'nbg1')
  .requiredOption('--key <key>', 'Reuse this key when retrying the same request')
  .action(async (name: string, raw: unknown) => {
    const options = z
      .object({ project: projectIdSchema, size: sizeSchema, region: regionSchema, key: z.string() })
      .parse(raw);
    output(
      await (
        await client()
      ).createMachine({
        projectId: options.project,
        spec: { name, size: options.size, region: options.region },
        idempotencyKey: options.key,
      }),
    );
  });

for (const kind of ['reboot', 'power_off', 'power_on', 'resize', 'destroy']) {
  const command = machine
    .command(`${kind.replaceAll('_', '-')} <id>`)
    .requiredOption('--expected-version <number>', 'Version returned by machine inspect')
    .requiredOption('--key <key>', 'Reuse this key when retrying the same request');
  if (kind === 'resize') command.requiredOption('--size <size>');
  if (kind === 'destroy') command.requiredOption('--allow-data-loss');
  command.action(async (id: string, raw: unknown) => {
    const options = z
      .looseObject({ expectedVersion: z.coerce.number().int().positive(), key: z.string() })
      .parse(raw);
    const action = machineActionSchema.parse({
      kind,
      expectedVersion: options.expectedVersion,
      ...(kind === 'resize' ? { size: options.size } : {}),
      ...(kind === 'destroy' ? { allowDataLoss: options.allowDataLoss === true } : {}),
    });
    output(
      await (
        await client()
      ).act({ machineId: machineIdSchema.parse(id), command: action, idempotencyKey: options.key }),
    );
  });
}

const operation = program.command('operation');
operation.command('inspect <id>').action(async (id: string) => {
  output(await (await client()).operation(operationIdSchema.parse(id)));
});
operation
  .command('wait <id>')
  .option('--timeout <seconds>', 'Maximum wait in seconds', '300')
  .action(async (id: string, raw: unknown) => {
    const options = z.object({ timeout: z.coerce.number().positive().max(3600) }).parse(raw);
    const result = await (
      await client()
    ).waitOperation({
      operationId: operationIdSchema.parse(id),
      timeoutMs: options.timeout * 1_000,
    });
    output(result);
    if (result.operation.progress.kind === 'failed') process.exitCode = 1;
    if (result.operation.progress.kind === 'blocked') process.exitCode = 2;
  });

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0) process.exitCode = 0;
  else {
    const failure =
      error instanceof CloudError
        ? error.failure
        : {
            code: error instanceof z.ZodError ? 'invalid_input' : 'client_error',
            message:
              error instanceof z.ZodError
                ? 'Arguments or server response do not match the schema.'
                : 'Command failed. Check credentials, connection, and arguments; inspect the operation before retrying a mutation.',
            retryable: false,
          };
    process.stderr.write(JSON.stringify({ error: failure }) + '\n');
    process.exitCode = 1;
  }
}

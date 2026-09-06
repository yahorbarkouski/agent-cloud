import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { z } from 'zod';
import {
  catalogResponseSchema,
  projectsResponseSchema,
  operationResponseSchema,
  machineResponseSchema,
} from '../packages/contracts/src/index.js';

const execute = promisify(execFile);
async function cli<T>(args: string[], schema: z.ZodType<T>): Promise<T> {
  const { stdout } = await execute(process.execPath, ['apps/cli/dist/index.js', ...args], {
    env: { ...process.env, ACLD_CREDENTIALS: resolve('.local/admin.credentials.json') },
    timeout: 30_000,
  });
  return schema.parse(JSON.parse(stdout));
}

const catalog = await cli(['catalog'], catalogResponseSchema);
if (catalog.provider !== 'simulated')
  throw new Error('This smoke test must use the simulated provider.');
const { projects } = await cli(['project', 'list'], projectsResponseSchema);
const project = projects[0];
if (!project) throw new Error('Bootstrap a project before running the smoke test.');
const { operation } = await cli(
  ['machine', 'create', `smoke-${randomUUID()}`, '--project', project.id, '--key', randomUUID()],
  operationResponseSchema,
);
let verificationError: Error | undefined;
try {
  const created = await cli(
    ['operation', 'wait', operation.id, '--timeout', '20'],
    operationResponseSchema,
  );
  if (created.operation.progress.kind !== 'succeeded') throw new Error('Create did not succeed.');
  const { machine } = await cli(['machine', 'inspect', operation.machineId], machineResponseSchema);
  if (machine.state.kind !== 'allocated' || machine.state.guest.kind !== 'simulated') {
    throw new Error('Machine did not report simulated guest readiness.');
  }
} catch (error) {
  verificationError =
    error instanceof Error ? error : new Error('Smoke verification failed.', { cause: error });
}
try {
  const { machine } = await cli(['machine', 'inspect', operation.machineId], machineResponseSchema);
  if (machine.state.kind === 'allocated') {
    const deletion = await cli(
      [
        'machine',
        'destroy',
        machine.id,
        '--expected-version',
        String(machine.version),
        '--allow-data-loss',
        '--key',
        randomUUID(),
      ],
      operationResponseSchema,
    );
    await cli(
      ['operation', 'wait', deletion.operation.id, '--timeout', '20'],
      operationResponseSchema,
    );
    const final = await cli(['machine', 'inspect', machine.id], machineResponseSchema);
    if (final.machine.state.kind !== 'destroyed') throw new Error('Cleanup did not finish.');
  }
} catch (cleanupError) {
  throw new AggregateError(
    verificationError ? [verificationError, cleanupError] : [cleanupError],
    'Smoke test cleanup failed.',
    { cause: cleanupError },
  );
}
if (verificationError) throw verificationError;
process.stdout.write(
  JSON.stringify({
    result: 'passed',
    provider: 'simulated',
    machineId: operation.machineId,
    verified: [
      'CLI',
      'HTTP API',
      'PostgreSQL',
      'Graphile worker',
      'create',
      'inspect',
      'destroy',
      'cleanup',
    ],
  }) + '\n',
);

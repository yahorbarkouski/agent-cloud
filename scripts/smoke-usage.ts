import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { serve } from '@hono/node-server';
import { run, Logger } from 'graphile-worker';
import type { z } from 'zod';
import {
  simulatedCatalog,
  operationResponseSchema,
  machineResponseSchema,
  usageResponseSchema,
  reservationHistoryResponseSchema,
} from '../packages/contracts/dist/index.js';
import { createApp } from '../apps/control/src/app.js';
import { createTasks } from '../apps/control/src/tasks.js';
import { SimulatedProvider } from '../apps/control/src/simulated-provider.js';
import { testDatabase, seedAccount } from '../tests/database.js';

const fixture = await testDatabase();
const scratch = await mkdtemp(join(tmpdir(), 'acld-usage-cli-'));
const limits = { maxMachines: 2, currency: 'EUR', maxHourlyMicros: 30_000 };
let server: ReturnType<typeof serve> | undefined;
let runner: Awaited<ReturnType<typeof run>> | undefined;
try {
  const owner = await seedAccount(fixture.connection.db);
  const app = createApp({
    db: fixture.connection.db,
    provider: 'simulated',
    catalog: simulatedCatalog,
    limits,
  });
  server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const credentials = join(scratch, 'owner.json');
  await writeFile(
    credentials,
    JSON.stringify({ server: `http://127.0.0.1:${address.port}`, token: owner.token }),
    { mode: 0o600 },
  );
  runner = await run({
    pgPool: fixture.connection.pool,
    pollInterval: 50,
    concurrency: 2,
    taskList: createTasks({
      connection: fixture.connection,
      provider: new SimulatedProvider({ db: fixture.connection.db }),
      limits,
    }),
    logger: new Logger(() => () => {}),
  });
  async function cli<T>(args: string[], schema: z.ZodType<T>) {
    try {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ['apps/cli/dist/index.js', ...args],
        {
          env: { ACLD_CREDENTIALS: credentials },
          timeout: 30_000,
          maxBuffer: 262144,
        },
      );
      return schema.parse(JSON.parse(stdout));
    } catch {
      throw new Error(`Usage CLI failed for ${args[0]}`);
    }
  }
  async function wait(id: string) {
    const { operation } = await cli(
      ['operation', 'wait', id, '--timeout', '20'],
      operationResponseSchema,
    );
    assert.equal(operation.progress.kind, 'succeeded');
  }
  const { operation } = await cli(
    ['machine', 'create', 'usage-smoke', '--project', owner.projectId, '--key', randomUUID()],
    operationResponseSchema,
  );
  await wait(operation.id);
  const inspect = () => cli(['machine', 'inspect', operation.machineId], machineResponseSchema);
  let { machine } = await inspect();
  const created = (await cli(['usage'], usageResponseSchema)).usage;
  assert.equal(created.activeReservations, 1);
  assert.equal(created.hourlyMicros, 9600);
  // Each CLI invocation exits; the API/worker and persisted reservation remain independent.
  let action = await cli(
    [
      'machine',
      'power-off',
      machine.id,
      '--expected-version',
      String(machine.version),
      '--key',
      randomUUID(),
    ],
    operationResponseSchema,
  );
  await wait(action.operation.id);
  assert.equal(
    (await cli(['usage'], usageResponseSchema)).usage.hourlyMicros,
    created.hourlyMicros,
  );
  ({ machine } = await inspect());
  action = await cli(
    [
      'machine',
      'resize',
      machine.id,
      '--size',
      'medium',
      '--expected-version',
      String(machine.version),
      '--key',
      randomUUID(),
    ],
    operationResponseSchema,
  );
  await wait(action.operation.id);
  assert.equal((await cli(['usage'], usageResponseSchema)).usage.hourlyMicros, 14400);
  ({ machine } = await inspect());
  action = await cli(
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
  await wait(action.operation.id);
  const final = (await cli(['usage'], usageResponseSchema)).usage;
  assert.equal(final.activeReservations, 0);
  assert.equal(final.hourlyMicros, 0);
  assert.equal((await inspect()).machine.state.kind, 'destroyed');
  const history = await cli(['usage', 'history'], reservationHistoryResponseSchema);
  assert.deepEqual(
    history.history.map(({ kind, hourlyMicros }) => ({ kind, hourlyMicros })),
    [
      { kind: 'released', hourlyMicros: 0 },
      { kind: 'changed', hourlyMicros: 14400 },
      { kind: 'admitted', hourlyMicros: 9600 },
    ],
  );
  console.log(
    JSON.stringify({
      result: 'passed',
      provider: 'simulated',
      verified: [
        'CLI/API/Graphile worker',
        'limits',
        'disconnected power-off remains reserved',
        'resize history',
        'verified destruction releases reservation',
        'exact fixture cleanup',
      ],
    }),
  );
} finally {
  await runner?.stop();
  const startedServer = server;
  if (startedServer)
    await new Promise<void>((resolve, reject) => {
      startedServer.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  await fixture.close();
  await rm(scratch, { recursive: true, force: true });
}

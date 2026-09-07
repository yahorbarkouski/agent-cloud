import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { serve } from '@hono/node-server';
import { run } from 'graphile-worker';
import { eq, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import {
  operationResponseSchema,
  machineResponseSchema,
  simulatedCatalog,
  providerCommandSchema,
} from '../packages/contracts/src/index.js';
import {
  connect,
  attempts,
  operations,
  allocations,
  providerResources,
  simulatedServers,
  simulatedPrimaryIps,
} from '../packages/db/src/index.js';
import { createApp, advanceOperation, SimulatedProvider } from '../apps/control/src/index.js';
import { createTasks } from '../apps/control/src/tasks.js';
import { testDatabase, seedAccount } from '../tests/database.js';

const execute = promisify(execFile);
const fixture = await testDatabase();
let directory: string | undefined;
const failures: unknown[] = [];
const limits = { currency: 'EUR', maxMachines: 2, maxHourlyMicros: 100_000 };
let runner: Awaited<ReturnType<typeof run>> | undefined;
let worker: ReturnType<typeof connect> | undefined;
let server: ReturnType<typeof serve> | undefined;
let evidence: unknown;
try {
  directory = await mkdtemp(join(tmpdir(), 'agent-cloud-cleanup-smoke-'));
  const account = await seedAccount(fixture.connection.db);
  const app = createApp({
    db: fixture.connection.db,
    provider: 'simulated',
    catalog: simulatedCatalog,
    limits,
  });
  server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP fixture has no bound port.');
  const credentials = join(directory, 'credentials.json');
  await writeFile(
    credentials,
    JSON.stringify({ server: `http://127.0.0.1:${address.port}`, token: account.token }),
    { mode: 0o600 },
  );
  async function cli<T>(args: string[], schema: z.ZodType<T>): Promise<T> {
    const result = await execute(process.execPath, ['apps/cli/dist/index.js', ...args], {
      env: { ...process.env, ACLD_CREDENTIALS: credentials },
      timeout: 30_000,
    });
    return schema.parse(JSON.parse(result.stdout));
  }
  const { operation } = await cli(
    [
      'machine',
      'create',
      `cleanup-${randomUUID()}`,
      '--project',
      account.projectId,
      '--key',
      randomUUID(),
    ],
    operationResponseSchema,
  );
  // Establish a real journaled lost-response fixture before starting the ordinary worker.
  const hidden = new SimulatedProvider({
    db: fixture.connection.db,
    fault: { kind: 'lose_response', visibilityDelayMs: 3_600_000 },
  });
  for (let step = 0; step < 6; step++)
    await advanceOperation({
      connection: fixture.connection,
      operationId: operation.id,
      provider: hidden,
      limits,
    });
  const blocked = await cli(['operation', 'inspect', operation.id], operationResponseSchema);
  if (
    blocked.operation.progress.kind !== 'blocked' ||
    blocked.operation.progress.reason !== 'provider_outcome_unknown'
  )
    throw new Error('The lost create response did not remain blocked.');
  const { machine } = await cli(['machine', 'inspect', operation.machineId], machineResponseSchema);
  const cleanup = await cli(
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
  if (cleanup.operation.id !== operation.id || cleanup.operation.intent.kind !== 'cleanup')
    throw new Error('Destroy did not retain the source operation as cleanup owner.');
  const [visible] = await fixture.connection.db.select().from(simulatedServers);
  if (!visible) throw new Error('Missing delayed provider server.');
  await fixture.connection.db
    .update(simulatedServers)
    .set({ visibleAt: new Date() })
    .where(eq(simulatedServers.id, visible.id));
  worker = connect(fixture.databaseUrl);
  runner = await run({
    pgPool: worker.pool,
    concurrency: 2,
    pollInterval: 100,
    noHandleSignals: true,
    taskList: createTasks({
      connection: worker,
      provider: new SimulatedProvider({ db: worker.db }),
      limits,
    }),
  });
  const finished = await cli(
    ['operation', 'wait', operation.id, '--timeout', '20'],
    operationResponseSchema,
  );
  if (finished.operation.progress.kind !== 'cancelled')
    throw new Error('Cleanup did not finish as cancelled.');
  const final = await cli(['machine', 'inspect', machine.id], machineResponseSchema);
  if (final.machine.state.kind !== 'destroyed')
    throw new Error('The cancelled machine is not destroyed.');
  const history = await fixture.connection.db.select().from(attempts);
  if (
    history.filter((row) => providerCommandSchema.parse(row.command).kind === 'create').length !== 1
  )
    throw new Error('Cleanup resubmitted VM creation.');
  const remaining = await Promise.all([
    fixture.connection.db.select().from(allocations).where(isNull(allocations.retiredAt)),
    fixture.connection.db
      .select()
      .from(providerResources)
      .where(isNull(providerResources.absentAt)),
    fixture.connection.db.select().from(simulatedServers),
    fixture.connection.db.select().from(simulatedPrimaryIps),
  ]);
  if (remaining.some((rows) => rows.length))
    throw new Error('Cleanup left a resource or reservation.');
  const [saved] = await fixture.connection.db
    .select()
    .from(operations)
    .where(eq(operations.id, operation.id));
  evidence = {
    result: 'passed',
    provider: 'simulated',
    operationId: operation.id,
    machineId: machine.id,
    progress: saved?.progress,
    verified: [
      'real CLI',
      'HTTP API',
      'PostgreSQL',
      'Graphile worker',
      'blocked lost response',
      'destroy admission',
      'single source create',
      'complete VM/IP cleanup',
    ],
    fixture: 'Delayed provider visibility released after cancellation; no live cloud claim.',
  };
} catch (error) {
  failures.push(error);
} finally {
  async function cleanup(work: () => Promise<unknown>) {
    try {
      await work();
    } catch (error) {
      failures.push(error);
    }
  }
  const activeRunner = runner;
  if (activeRunner) {
    await cleanup(() => activeRunner.stop());
    await cleanup(() => activeRunner.promise);
  }
  const activeWorker = worker;
  if (activeWorker) await cleanup(() => activeWorker.pool.end());
  const activeServer = server;
  if (activeServer)
    await cleanup(
      () =>
        new Promise<void>((resolve, reject) => {
          activeServer.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
    );
  await cleanup(() => fixture.close());
  const fixtureDirectory = directory;
  if (fixtureDirectory) await cleanup(() => rm(fixtureDirectory, { recursive: true, force: true }));
}
if (failures.length)
  throw new AggregateError(failures, 'Cleanup smoke failed.', { cause: failures[0] });
process.stdout.write(JSON.stringify(evidence) + '\n');

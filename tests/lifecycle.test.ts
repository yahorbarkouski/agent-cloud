import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  operationResponseSchema,
  machineResponseSchema,
  operationSchema,
  newId,
  attemptOutcomeSchema,
  type Operation,
  type MachineAction,
} from '../packages/contracts/src/index.js';
import {
  allocations,
  attempts,
  grants,
  machines,
  operations,
  simulatedServers,
} from '../packages/db/src/index.js';
import { createApp, SimulatedProvider, advanceOperation } from '../apps/control/src/index.js';
import { testDatabase, seedAccount } from './database.js';

const limits = { maxMachines: 100, maxHourlyMicroEur: 10_000_000 };
let fixture: Awaited<ReturnType<typeof testDatabase>>;
let account: Awaited<ReturnType<typeof seedAccount>>;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  fixture = await testDatabase();
});
afterAll(async () => {
  await fixture.close();
});
beforeEach(async () => {
  await fixture.reset();
  account = await seedAccount(fixture.connection.db);
  app = createApp({ db: fixture.connection.db, provider: 'simulated', limits });
});

async function request(path: string, body?: unknown, token = account.token, key = randomUUID()) {
  return app.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function create(name = 'example') {
  const response = await request(`/v1/projects/${account.projectId}/machines`, {
    name,
    size: 'small',
    region: 'nbg1',
  });
  expect(response.status).toBe(202);
  return operationResponseSchema.parse(await response.json()).operation;
}

async function tick(
  operation: Operation,
  provider = new SimulatedProvider({ db: fixture.connection.db }),
) {
  await advanceOperation({ connection: fixture.connection, operationId: operation.id, provider });
}

async function readOperation(operation: Operation) {
  const [row] = await fixture.connection.db
    .select()
    .from(operations)
    .where(eq(operations.id, operation.id));
  return operationSchema.parse({ ...row, createdAt: row?.createdAt.toISOString() });
}

async function readMachine(operation: Operation) {
  const response = await request(`/v1/machines/${operation.machineId}`);
  expect(response.status).toBe(200);
  return machineResponseSchema.parse(await response.json()).machine;
}

async function act(operation: Operation, command: MachineAction) {
  const response = await request(`/v1/machines/${operation.machineId}/actions`, command);
  expect(response.status).toBe(202);
  const action = operationResponseSchema.parse(await response.json()).operation;
  await tick(action);
  await tick(action);
  expect((await readOperation(action)).progress.kind).toBe('succeeded');
  return action;
}

describe('durable admission and API isolation', () => {
  it('deduplicates concurrent reordered bodies and rejects reuse with a different body', async () => {
    const path = `/v1/projects/${account.projectId}/machines`;
    const key = randomUUID();
    const responses = await Promise.all([
      request(path, { name: 'example', size: 'small', region: 'nbg1' }, account.token, key),
      request(path, { region: 'nbg1', size: 'small', name: 'example' }, account.token, key),
    ]);
    const bodies = await Promise.all(
      responses.map(async (response) => {
        expect(response.status).toBe(202);
        return operationResponseSchema.parse(await response.json());
      }),
    );
    expect(bodies[0]?.operation.id).toBe(bodies[1]?.operation.id);
    expect(await fixture.connection.db.select().from(allocations)).toHaveLength(1);
    expect(await fixture.connection.db.select().from(operations)).toHaveLength(1);
    expect(
      (
        await request(
          path,
          { name: 'different', size: 'small', region: 'nbg1' },
          account.token,
          key,
        )
      ).status,
    ).toBe(409);
  });

  it('serializes simultaneous admission against the account quota', async () => {
    account = await seedAccount(fixture.connection.db, { maxMachines: 1 });
    const statuses = await Promise.all(
      ['first', 'second', 'third'].map(
        async (name) =>
          (
            await request(`/v1/projects/${account.projectId}/machines`, {
              name,
              size: 'small',
              region: 'nbg1',
            })
          ).status,
      ),
    );
    expect(statuses.sort()).toEqual([202, 429, 429]);
    expect(await fixture.connection.db.select().from(allocations)).toHaveLength(1);
  });

  it('hides another account machines, operations and mutation targets', async () => {
    const operation = await create();
    const other = await seedAccount(fixture.connection.db);
    expect(
      (await request(`/v1/machines/${operation.machineId}`, undefined, other.token)).status,
    ).toBe(404);
    expect((await request(`/v1/operations/${operation.id}`, undefined, other.token)).status).toBe(
      404,
    );
    expect(
      (
        await request(
          `/v1/machines/${operation.machineId}/actions`,
          { kind: 'reboot', expectedVersion: 1 },
          other.token,
        )
      ).status,
    ).toBe(404);
    await expect(
      fixture.connection.db.insert(machines).values({
        id: newId.machine(),
        accountId: other.principal.accountId,
        projectId: account.projectId,
        name: 'cross-tenant',
        spec: {},
        provider: 'simulated',
        state: { kind: 'pending' },
      }),
    ).rejects.toThrow();
  });

  it('fails before admission when budget, authentication, or input is invalid', async () => {
    app = createApp({
      db: fixture.connection.db,
      provider: 'simulated',
      limits: { ...limits, maxHourlyMicroEur: 0 },
    });
    const path = `/v1/projects/${account.projectId}/machines`;
    const body = { name: 'example', size: 'small', region: 'nbg1' };
    expect((await request(path, body)).status).toBe(409);
    expect((await request(path, body, 'invalid')).status).toBe(401);
    expect((await request(path, { ...body, privileged: true })).status).toBe(400);
    expect(await fixture.connection.db.select().from(operations)).toHaveLength(0);
  });
});

describe('provider uncertainty and recovery', () => {
  it('recovers a lost create response after restart and grant revocation without resubmitting', async () => {
    const operation = await create();
    await tick(
      operation,
      new SimulatedProvider({
        db: fixture.connection.db,
        fault: { kind: 'lose_response', visibilityDelayMs: 0 },
      }),
    );
    await fixture.connection.db
      .update(grants)
      .set({ revokedAt: new Date() })
      .where(eq(grants.id, account.principal.grantId));
    await tick(operation);
    expect((await readOperation(operation)).progress.kind).toBe('succeeded');
    expect(await fixture.connection.db.select().from(attempts)).toHaveLength(1);
    expect(await fixture.connection.db.select().from(simulatedServers)).toHaveLength(1);
  });

  it('retains the reservation while a created server is temporarily invisible', async () => {
    const operation = await create();
    await tick(
      operation,
      new SimulatedProvider({
        db: fixture.connection.db,
        fault: { kind: 'lose_response', visibilityDelayMs: 60_000 },
      }),
    );
    await tick(operation);
    expect((await readOperation(operation)).progress).toEqual({
      kind: 'blocked',
      reason: 'provider_outcome_unknown',
    });
    expect(
      await fixture.connection.db.select().from(allocations).where(isNull(allocations.retiredAt)),
    ).toHaveLength(1);
    await fixture.connection.db.update(simulatedServers).set({ visibleAt: new Date() });
    await tick(operation);
    expect((await readOperation(operation)).progress.kind).toBe('succeeded');
    expect(await fixture.connection.db.select().from(attempts)).toHaveLength(1);
  });

  it('never treats an empty inventory as permission for another paid create', async () => {
    const operation = await create();
    await tick(
      operation,
      new SimulatedProvider({
        db: fixture.connection.db,
        fault: { kind: 'timeout_before_submit' },
      }),
    );
    for (let i = 0; i < 5; i++) await tick(operation);
    expect((await readOperation(operation)).progress.kind).toBe('blocked');
    expect(await fixture.connection.db.select().from(attempts)).toHaveLength(1);
    expect(await fixture.connection.db.select().from(simulatedServers)).toHaveLength(0);
    expect(
      await fixture.connection.db.select().from(allocations).where(isNull(allocations.retiredAt)),
    ).toHaveLength(1);
  });

  it('surfaces duplicate owned resources without choosing or deleting one', async () => {
    const operation = await create();
    await tick(
      operation,
      new SimulatedProvider({ db: fixture.connection.db, fault: { kind: 'duplicate_create' } }),
    );
    await tick(operation);
    expect((await readOperation(operation)).progress).toEqual({
      kind: 'blocked',
      reason: 'duplicate_provider_resources',
    });
    expect(await fixture.connection.db.select().from(simulatedServers)).toHaveLength(2);
    expect(await fixture.connection.db.select().from(attempts)).toHaveLength(1);
  });

  it('recovers a crash after submission but before recording its response', async () => {
    const operation = await create();
    await expect(
      promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', 'tests/fixtures/crash-after-submit.ts'],
        {
          env: {
            ...process.env,
            CRASH_TEST_DATABASE_URL: fixture.databaseUrl,
            CRASH_TEST_OPERATION_ID: operation.id,
          },
          timeout: 10_000,
        },
      ),
    ).rejects.toMatchObject({ code: 86 });
    const [attempt] = await fixture.connection.db.select().from(attempts);
    const outcome = attemptOutcomeSchema.parse(attempt?.outcome);
    expect(outcome.kind).toBe('prepared');
    await expect
      .poll(async () => {
        await tick(operation);
        return (await readOperation(operation)).progress.kind;
      })
      .toBe('succeeded');
    expect(await fixture.connection.db.select().from(attempts)).toHaveLength(1);
    expect(await fixture.connection.db.select().from(simulatedServers)).toHaveLength(1);
  });

  it('prevents unknown outcomes, commands and attempt history from being overwritten', async () => {
    const operation = await create();
    await tick(
      operation,
      new SimulatedProvider({
        db: fixture.connection.db,
        fault: { kind: 'timeout_before_submit' },
      }),
    );
    await expect(
      fixture.connection.db.update(attempts).set({ outcome: { kind: 'prepared' } }),
    ).rejects.toThrow();
    await expect(
      fixture.connection.db
        .update(attempts)
        .set({ command: { kind: 'destroy', serverId: 'different' } }),
    ).rejects.toThrow();
    await expect(fixture.connection.db.delete(attempts)).rejects.toThrow();
    expect(await fixture.connection.db.select().from(attempts)).toHaveLength(1);
  });

  it('stops revoked queued work before submission and releases its unused reservation', async () => {
    const operation = await create();
    await fixture.connection.db
      .update(grants)
      .set({ revokedAt: new Date() })
      .where(eq(grants.id, account.principal.grantId));
    await tick(operation);
    expect((await readOperation(operation)).progress.kind).toBe('failed');
    expect(await fixture.connection.db.select().from(attempts)).toHaveLength(0);
    expect(
      await fixture.connection.db.select().from(allocations).where(isNull(allocations.retiredAt)),
    ).toHaveLength(0);
  });

  it('allows only one worker to submit an operation', async () => {
    const operation = await create();
    await Promise.all(Array.from({ length: 8 }, () => tick(operation)));
    await tick(operation);
    expect(await fixture.connection.db.select().from(attempts)).toHaveLength(1);
    expect(await fixture.connection.db.select().from(simulatedServers)).toHaveLength(1);
    expect((await readOperation(operation)).progress.kind).toBe('succeeded');
  });
});

describe('observable machine lifecycle', () => {
  it('creates, powers off, resizes, powers on, reboots and deletes with explicit versions', async () => {
    const operation = await create();
    await tick(operation);
    await tick(operation);
    let machine = await readMachine(operation);
    expect(machine.state).toMatchObject({
      kind: 'allocated',
      power: 'running',
      guest: { kind: 'simulated' },
    });
    expect(
      (await request(`/v1/machines/${machine.id}/actions`, { kind: 'reboot', expectedVersion: 1 }))
        .status,
    ).toBe(409);
    await act(operation, { kind: 'power_off', expectedVersion: machine.version });
    machine = await readMachine(operation);
    expect(machine.state).toMatchObject({ power: 'off' });
    const usage = z
      .object({ usage: z.object({ activeReservations: z.number() }) })
      .parse(await (await request('/v1/usage')).json());
    expect(usage.usage.activeReservations).toBe(1);
    await act(operation, { kind: 'resize', size: 'medium', expectedVersion: machine.version });
    machine = await readMachine(operation);
    expect(machine.spec.size).toBe('medium');
    await act(operation, { kind: 'power_on', expectedVersion: machine.version });
    machine = await readMachine(operation);
    await act(operation, { kind: 'reboot', expectedVersion: machine.version });
    machine = await readMachine(operation);
    expect(
      (
        await request(`/v1/machines/${machine.id}/actions`, {
          kind: 'destroy',
          expectedVersion: machine.version,
          allowDataLoss: false,
        })
      ).status,
    ).toBe(403);
    await act(operation, {
      kind: 'destroy',
      expectedVersion: machine.version,
      allowDataLoss: true,
    });
    expect((await readMachine(operation)).state.kind).toBe('destroyed');
    expect(
      await fixture.connection.db.select().from(allocations).where(isNull(allocations.retiredAt)),
    ).toHaveLength(0);
    expect(await fixture.connection.db.select().from(simulatedServers)).toHaveLength(0);
  });

  it('keeps a failed creation allocation visible to explicit cleanup', async () => {
    const operation = await create();
    const provider = new SimulatedProvider({
      db: fixture.connection.db,
      fault: { kind: 'action_failure' },
    });
    await tick(operation, provider);
    await tick(operation, provider);
    expect((await readOperation(operation)).progress.kind).toBe('failed');
    expect(
      await fixture.connection.db.select().from(allocations).where(isNull(allocations.retiredAt)),
    ).toHaveLength(1);
    const machine = await readMachine(operation);
    await act(operation, {
      kind: 'destroy',
      expectedVersion: machine.version,
      allowDataLoss: true,
    });
    expect(await fixture.connection.db.select().from(simulatedServers)).toHaveLength(0);
  });
});

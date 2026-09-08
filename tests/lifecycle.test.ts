import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  operationResponseSchema,
  reservationHistoryResponseSchema,
  usageResponseSchema,
  machineResponseSchema,
  operationSchema,
  newId,
  simulatedCatalog,
  catalogResponseSchema,
  providerCommandSchema,
  providerServerSchema,
  attemptOutcomeSchema,
  type Operation,
  type MachineAction,
  type MachineProvider,
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

const limits = { maxMachines: 100, currency: 'EUR', maxHourlyMicros: 10_000_000 };
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
  app = createApp({
    db: fixture.connection.db,
    provider: 'simulated',
    catalog: simulatedCatalog,
    limits,
  });
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
  await advanceOperation({
    limits: { currency: 'EUR', maxMachines: 100, maxHourlyMicros: 10000000 },
    connection: fixture.connection,
    operationId: operation.id,
    provider,
  });
}

async function serverAttempts() {
  return fixture.connection.db
    .select()
    .from(attempts)
    .where(sql`${attempts.command}->>'kind' = 'create'`);
}
async function submitVm(
  operation: Operation,
  provider = new SimulatedProvider({ db: fixture.connection.db }),
) {
  await expect
    .poll(
      async () => {
        await tick(operation, provider);
        return (await serverAttempts()).length;
      },
      { timeout: 5000, interval: 20 },
    )
    .toBe(1);
}
async function settle(
  operation: Operation,
  provider = new SimulatedProvider({ db: fixture.connection.db }),
  expected = 'succeeded',
) {
  await expect
    .poll(
      async () => {
        await tick(operation, provider);
        return (await readOperation(operation)).progress.kind;
      },
      { timeout: 5000, interval: 20 },
    )
    .toBe(expected);
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
  await settle(action);
  expect((await readOperation(action)).progress.kind).toBe('succeeded');
  return action;
}

describe('provider automatic backup admission and recovery', () => {
  const backedCatalog = () => {
    const base = simulatedCatalog();
    return catalogResponseSchema.parse({
      ...base,
      items: base.items.map((item) => ({
        ...item,
        providerBackups: { kind: 'daily', hourlyMicros: 1680 },
        hourlyMicros: item.hourlyMicros + 1680,
      })),
    });
  };
  beforeEach(() => {
    app = createApp({
      db: fixture.connection.db,
      provider: 'simulated',
      catalog: backedCatalog,
      limits,
    });
  });

  it('reserves backup cost before allocation and resolves a lost enable response without resubmission', async () => {
    class LostBackupReply extends SimulatedProvider {
      override submit(input: Parameters<MachineProvider['submit']>[0]) {
        return input.command.kind === 'enable_backup'
          ? new SimulatedProvider({
              db: this.db,
              catalog: this.catalog,
              fault: { kind: 'lose_response', visibilityDelayMs: 0 },
            }).submit(input)
          : super.submit(input);
      }
    }
    const provider = new LostBackupReply({ db: fixture.connection.db, catalog: backedCatalog });
    const operation = await create();
    const [reserved] = await fixture.connection.db.select().from(allocations);
    expect(reserved?.hourlyMicros).toBe(11280);
    await settle(operation, provider);
    expect((await readMachine(operation)).state).toMatchObject({
      kind: 'allocated',
      backupStatus: 'enabled',
    });
    const history = await fixture.connection.db.select().from(attempts);
    expect(
      history.filter((row) => providerCommandSchema.parse(row.command).kind === 'enable_backup'),
    ).toHaveLength(1);
    const enabled = history.find(
      (row) => providerCommandSchema.parse(row.command).kind === 'enable_backup',
    );
    expect(enabled?.outcome).toMatchObject({ kind: 'unknown' });
    expect(enabled?.resolution).toMatchObject({ kind: 'confirmed' });
    await tick(operation, provider);
    const machine = await readMachine(operation);
    await act(operation, {
      kind: 'destroy',
      expectedVersion: machine.version,
      allowDataLoss: true,
    });
    expect(
      usageResponseSchema.parse(await (await request('/v1/usage')).json()).usage.hourlyMicros,
    ).toBe(0);
    expect(await provider.findServers({ labels: {} })).toHaveLength(0);
    expect(await provider.findPrimaryIps({ labels: {} })).toHaveLength(0);
  });

  it('refuses a grant limit that covers the VM and IP but not the backup surcharge', async () => {
    await fixture.connection.db
      .update(grants)
      .set({ policy: { ...account.principal.policy, maxHourlyMicros: 10000 } })
      .where(eq(grants.id, account.principal.grantId));
    const response = await request(`/v1/projects/${account.projectId}/machines`, {
      name: 'over-budget',
      size: 'small',
      region: 'nbg1',
    });
    expect(response.status).toBe(409);
    expect(await fixture.connection.db.select().from(allocations)).toHaveLength(0);
    expect(await fixture.connection.db.select().from(attempts)).toHaveLength(0);
  });

  it('rechecks revocation before enabling backups on the new owned server', async () => {
    const provider = new SimulatedProvider({ db: fixture.connection.db, catalog: backedCatalog });
    const operation = await create();
    await submitVm(operation, provider);
    await tick(operation, provider); // Confirm the create without submitting its next effect.
    await fixture.connection.db
      .update(grants)
      .set({ revokedAt: new Date() })
      .where(eq(grants.id, account.principal.grantId));
    for (let i = 0; i < 10; i++) await tick(operation, provider);
    const history = await fixture.connection.db.select().from(attempts);
    expect(
      history.filter((row) => providerCommandSchema.parse(row.command).kind === 'enable_backup'),
    ).toHaveLength(0);
    expect((await readOperation(operation)).progress.kind).toBe('failed');
    expect(await provider.findServers({ labels: {} })).toHaveLength(1);
    expect((await fixture.connection.db.select().from(allocations))[0]?.retiredAt).toBeNull();
  });

  it('refuses a higher backup quote after VM creation without increasing the reservation', async () => {
    let increased = false;
    const provider = new SimulatedProvider({
      db: fixture.connection.db,
      catalog: () => {
        const original = backedCatalog();
        return increased
          ? catalogResponseSchema.parse({
              ...original,
              items: original.items.map((item) => ({
                ...item,
                providerBackups: { kind: 'daily', hourlyMicros: 2680 },
                hourlyMicros: item.hourlyMicros + 1000,
              })),
            })
          : original;
      },
    });
    const operation = await create();
    await submitVm(operation, provider);
    await tick(operation, provider);
    increased = true;
    await tick(operation, provider);
    expect((await readOperation(operation)).progress).toMatchObject({
      kind: 'failed',
      error: { code: 'budget_exceeded' },
    });
    const history = await fixture.connection.db.select().from(attempts);
    expect(
      history.filter((row) => providerCommandSchema.parse(row.command).kind === 'enable_backup'),
    ).toHaveLength(0);
    expect((await fixture.connection.db.select().from(allocations))[0]?.hourlyMicros).toBe(11280);
  });

  it.each(['unknown-status', 'foreign-labels'])(
    'refuses backup enablement for %s',
    async (fault) => {
      const provider = new SimulatedProvider({ db: fixture.connection.db, catalog: backedCatalog });
      const operation = await create();
      await submitVm(operation, provider);
      await tick(operation, provider);
      const [row] = await fixture.connection.db.select().from(simulatedServers);
      if (!row) throw new Error('Missing fixture server.');
      const server = providerServerSchema.parse(row.value);
      await fixture.connection.db
        .update(simulatedServers)
        .set({
          value: {
            ...server,
            ...(fault === 'unknown-status'
              ? { backupStatus: 'unknown' }
              : { labels: { managed_by: 'another-account' } }),
          },
        })
        .where(eq(simulatedServers.id, row.id));
      await tick(operation, provider);
      expect((await readOperation(operation)).progress).toMatchObject({
        kind: 'blocked',
        reason: 'provider_resource_mismatch',
      });
      const history = await fixture.connection.db.select().from(attempts);
      expect(
        history.filter((row) => providerCommandSchema.parse(row.command).kind === 'enable_backup'),
      ).toHaveLength(0);
    },
  );

  it('enables backups during a newly priced resize of a historical machine', async () => {
    let daily = false;
    const catalog = () => (daily ? backedCatalog() : simulatedCatalog());
    app = createApp({ db: fixture.connection.db, provider: 'simulated', catalog, limits });
    const provider = new SimulatedProvider({ db: fixture.connection.db, catalog });
    const operation = await create();
    await settle(operation, provider);
    expect((await readMachine(operation)).state).toMatchObject({ backupStatus: 'disabled' });
    const created = await readMachine(operation);
    await act(operation, { kind: 'power_off', expectedVersion: created.version });
    const poweredOff = await readMachine(operation);
    daily = true;
    const response = await request(`/v1/machines/${operation.machineId}/actions`, {
      kind: 'resize',
      size: 'medium',
      expectedVersion: poweredOff.version,
    });
    expect(response.status).toBe(202);
    await settle(operationResponseSchema.parse(await response.json()).operation, provider);
    expect((await readMachine(operation)).state).toMatchObject({
      kind: 'allocated',
      backupStatus: 'enabled',
    });
    expect((await fixture.connection.db.select().from(allocations))[0]?.hourlyMicros).toBe(16080);
  });

  it('does not enable backups on a costlier old VM when a cheaper equal-disk resize fails', async () => {
    let daily = false;
    const catalog = () => {
      const base = simulatedCatalog();
      return catalogResponseSchema.parse({
        ...base,
        items: base.items.map((item) => {
          const serverHourlyMicros = item.size === 'small' ? 9000 : 8000;
          const backup = daily ? serverHourlyMicros / 5 : 0;
          return {
            ...item,
            diskGb: 40,
            serverHourlyMicros,
            ipv4HourlyMicros: 1000,
            hourlyMicros: serverHourlyMicros + 1000 + backup,
            providerBackups: daily ? { kind: 'daily', hourlyMicros: backup } : { kind: 'disabled' },
          };
        }),
      });
    };
    await fixture.connection.db
      .update(grants)
      .set({ policy: { ...account.principal.policy, maxHourlyMicros: 11000 } })
      .where(eq(grants.id, account.principal.grantId));
    app = createApp({ db: fixture.connection.db, provider: 'simulated', catalog, limits });
    class RefusedResize extends SimulatedProvider {
      override submit(input: Parameters<MachineProvider['submit']>[0]) {
        return input.command.kind === 'resize'
          ? Promise.resolve({
              kind: 'rejected',
              error: {
                code: 'provider_rejected',
                message: 'Target type refused.',
                retryable: false,
              },
            } satisfies Awaited<ReturnType<MachineProvider['submit']>>)
          : super.submit(input);
      }
    }
    const provider = new RefusedResize({ db: fixture.connection.db, catalog });
    const operation = await create();
    await settle(operation, provider);
    const created = await readMachine(operation);
    await act(operation, { kind: 'power_off', expectedVersion: created.version });
    const poweredOff = await readMachine(operation);
    daily = true;
    const response = await request(`/v1/machines/${operation.machineId}/actions`, {
      kind: 'resize',
      size: 'medium',
      expectedVersion: poweredOff.version,
    });
    expect(response.status).toBe(202);
    await settle(
      operationResponseSchema.parse(await response.json()).operation,
      provider,
      'failed',
    );
    const history = await fixture.connection.db.select().from(attempts);
    expect(
      history.filter((row) => providerCommandSchema.parse(row.command).kind === 'enable_backup'),
    ).toHaveLength(0);
    const [server] = await provider.findServers({ labels: {} });
    expect(server).toMatchObject({ serverType: 'cx23', backupStatus: 'disabled' });
    expect((await fixture.connection.db.select().from(allocations))[0]?.hourlyMicros).toBe(10600);
  });

  it('retains the full reservation when backup enablement is uncertain and permits owned destruction', async () => {
    class UnknownBackup extends SimulatedProvider {
      override submit(input: Parameters<MachineProvider['submit']>[0]) {
        return input.command.kind === 'enable_backup'
          ? Promise.resolve({
              kind: 'unknown',
              reason: 'Backup request reply unavailable.',
            } satisfies Awaited<ReturnType<MachineProvider['submit']>>)
          : super.submit(input);
      }
    }
    const provider = new UnknownBackup({ db: fixture.connection.db, catalog: backedCatalog });
    const operation = await create();
    for (let i = 0; i < 12; i++) await tick(operation, provider);
    const history = await fixture.connection.db.select().from(attempts);
    expect(
      history.filter((row) => providerCommandSchema.parse(row.command).kind === 'enable_backup'),
    ).toHaveLength(1);
    expect((await readOperation(operation)).progress.kind).not.toBe('succeeded');
    expect(
      usageResponseSchema.parse(await (await request('/v1/usage')).json()).usage.hourlyMicros,
    ).toBe(11280);
    const machine = await readMachine(operation);
    const response = await request(`/v1/machines/${machine.id}/actions`, {
      kind: 'destroy',
      expectedVersion: machine.version,
      allowDataLoss: true,
    });
    expect(response.status).toBe(202);
    await settle(operation, provider, 'cancelled');
    expect(await provider.findServers({ labels: {} })).toHaveLength(0);
    expect(await provider.findPrimaryIps({ labels: {} })).toHaveLength(0);
    expect(
      usageResponseSchema.parse(await (await request('/v1/usage')).json()).usage.hourlyMicros,
    ).toBe(0);
  });
});

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
      catalog: simulatedCatalog,
      limits: { ...limits, currency: 'EUR', maxHourlyMicros: 0 },
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
    await submitVm(
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
    await settle(operation);
    expect((await readOperation(operation)).progress.kind).toBe('succeeded');
    expect(await serverAttempts()).toHaveLength(1);
    expect(await fixture.connection.db.select().from(simulatedServers)).toHaveLength(1);
  });

  it('retains the reservation while a created server is temporarily invisible', async () => {
    const operation = await create();
    await submitVm(
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
    await settle(operation);
    expect((await readOperation(operation)).progress.kind).toBe('succeeded');
    expect(await serverAttempts()).toHaveLength(1);
  });

  it('never treats an empty inventory as permission for another paid create', async () => {
    const operation = await create();
    await submitVm(
      operation,
      new SimulatedProvider({
        db: fixture.connection.db,
        fault: { kind: 'timeout_before_submit' },
      }),
    );
    for (let i = 0; i < 5; i++) await tick(operation);
    expect((await readOperation(operation)).progress.kind).toBe('blocked');
    expect(await serverAttempts()).toHaveLength(1);
    expect(await fixture.connection.db.select().from(simulatedServers)).toHaveLength(0);
    expect(
      await fixture.connection.db.select().from(allocations).where(isNull(allocations.retiredAt)),
    ).toHaveLength(1);
  });

  it('surfaces duplicate owned resources without choosing or deleting one', async () => {
    const operation = await create();
    await submitVm(
      operation,
      new SimulatedProvider({ db: fixture.connection.db, fault: { kind: 'duplicate_create' } }),
    );
    await tick(operation);
    expect((await readOperation(operation)).progress).toEqual({
      kind: 'blocked',
      reason: 'duplicate_provider_resources',
    });
    expect(await fixture.connection.db.select().from(simulatedServers)).toHaveLength(2);
    expect(await serverAttempts()).toHaveLength(1);
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
    const [attempt] = await serverAttempts();
    const outcome = attemptOutcomeSchema.parse(attempt?.outcome);
    expect(outcome.kind).toBe('prepared');
    await expect
      .poll(
        async () => {
          await tick(operation);
          return (await readOperation(operation)).progress.kind;
        },
        { timeout: 5000, interval: 20 },
      )
      .toBe('succeeded');
    expect(await serverAttempts()).toHaveLength(1);
    expect(await fixture.connection.db.select().from(simulatedServers)).toHaveLength(1);
  });

  it('prevents unknown outcomes, commands and attempt history from being overwritten', async () => {
    const operation = await create();
    await submitVm(
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
    expect(await serverAttempts()).toHaveLength(1);
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
    await settle(operation);
    expect(await serverAttempts()).toHaveLength(1);
    expect(await fixture.connection.db.select().from(simulatedServers)).toHaveLength(1);
    expect((await readOperation(operation)).progress.kind).toBe('succeeded');
  });
});

describe('observable machine lifecycle', () => {
  it('creates, powers off, resizes, powers on, reboots and deletes with explicit versions', async () => {
    const operation = await create();
    await settle(operation);
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
    const history = reservationHistoryResponseSchema.parse(
      await (await request('/v1/usage/history')).json(),
    );
    expect(history.history.map(({ kind, hourlyMicros }) => ({ kind, hourlyMicros }))).toEqual([
      { kind: 'released', hourlyMicros: 0 },
      { kind: 'changed', hourlyMicros: 14400 },
      { kind: 'admitted', hourlyMicros: 9600 },
    ]);
    expect(
      usageResponseSchema.parse(await (await request('/v1/usage')).json()).usage,
    ).toMatchObject({
      activeReservations: 0,
      hourlyMicros: 0,
      limits: { remainingMachines: 20 },
    });
  });

  it('keeps a failed creation allocation visible to explicit cleanup', async () => {
    const operation = await create();
    const provider = new SimulatedProvider({
      db: fixture.connection.db,
      fault: { kind: 'action_failure' },
    });
    await settle(operation, provider, 'failed');
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

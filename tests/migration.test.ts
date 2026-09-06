import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { migrate as migrateDrizzle } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  newId,
  simulatedCatalog,
  operationProgressSchema,
  catalogItemSchema,
  capabilitySchema,
} from '../packages/contracts/src/index.js';
import {
  migrate,
  allocations,
  attempts,
  operations,
  grants,
  accounts,
  simulatedServers,
} from '../packages/db/src/index.js';
import { advanceOperation, SimulatedProvider } from '../apps/control/src/index.js';
import { authenticate, generateToken, hashToken } from '../apps/control/src/auth.js';
import { testDatabase } from './database.js';

it.each(['queued', 'prepared'])(
  'upgrades an M0 %s create without changing its price or repeating its provider effect',
  async (stage) => {
    const folder = await mkdtemp(join(tmpdir(), 'agent-cloud-migration-'));
    const source = resolve('packages/db/migrations');
    await mkdir(join(folder, 'meta'));
    const journal = z
      .object({
        version: z.string(),
        dialect: z.string(),
        entries: z.array(z.looseObject({ idx: z.int() })),
      })
      .parse(JSON.parse(await readFile(join(source, 'meta/_journal.json'), 'utf8')));
    await writeFile(
      join(folder, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx < 2) }),
    );
    for (const name of ['0000_initial.sql', '0001_provider_attempt_guards.sql'])
      await copyFile(join(source, name), join(folder, name));
    const fixture = await testDatabase(async (connection) => {
      await migrateDrizzle(connection.db, { migrationsFolder: folder });
    });
    try {
      const id = {
        account: newId.account(),
        project: newId.project(),
        grant: newId.grant(),
        machine: newId.machine(),
        allocation: newId.allocation(),
        operation: newId.operation(),
        attempt: newId.attempt(),
      };
      const policy = {
        capabilities: capabilitySchema.options,
        projects: { kind: 'all' },
        sizes: ['small', 'medium', 'large'],
        regions: ['nbg1', 'fsn1', 'hel1'],
        maxMachines: 2,
        maxHourlyMicroEur: 20000,
      };
      const spec = { name: 'migrated', size: 'small', region: 'nbg1' };
      const labels = {
        managed_by: 'agent-cloud',
        account_id: id.account,
        machine_id: id.machine,
        operation_id: id.operation,
      };
      const command = {
        kind: 'create',
        name: id.machine.replaceAll('_', '-'),
        serverType: 'cx23',
        region: 'nbg1',
        labels,
      };
      const token = generateToken();
      const pool = fixture.connection.pool;
      await pool.query(
        'INSERT INTO accounts (id,name,max_machines,max_hourly_micro_eur) VALUES ($1,$2,2,20000)',
        [id.account, 'legacy'],
      );
      await pool.query('INSERT INTO projects (id,account_id,name) VALUES ($1,$2,$3)', [
        id.project,
        id.account,
        'legacy',
      ]);
      await pool.query(
        "INSERT INTO grants (id,account_id,name,token_hash,policy,expires_at) VALUES ($1,$2,$3,$4,$5,now()+interval '1 day')",
        [id.grant, id.account, 'legacy', hashToken(token), policy],
      );
      await pool.query(
        'INSERT INTO machines (id,account_id,project_id,name,spec,provider,state) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [
          id.machine,
          id.account,
          id.project,
          'migrated',
          spec,
          'simulated',
          { kind: 'provisioning', allocationId: id.allocation },
        ],
      );
      await pool.query(
        'INSERT INTO allocations (id,account_id,machine_id,provider,hourly_micro_eur) VALUES ($1,$2,$3,$4,9600)',
        [id.allocation, id.account, id.machine, 'simulated'],
      );
      await pool.query(
        'INSERT INTO operations (id,account_id,project_id,machine_id,grant_id,kind,command,progress) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          id.operation,
          id.account,
          id.project,
          id.machine,
          id.grant,
          'machine.create',
          { kind: 'create', spec },
          { kind: 'queued' },
        ],
      );
      if (stage === 'prepared') {
        await fixture.connection.db.insert(attempts).values({
          id: id.attempt,
          accountId: id.account,
          operationId: id.operation,
          sequence: 1,
          command,
          outcome: { kind: 'prepared' },
        });
        await fixture.connection.db.insert(simulatedServers).values({
          id: 'legacy-server',
          visibleAt: new Date(),
          value: {
            id: 'legacy-server',
            name: command.name,
            serverType: command.serverType,
            region: command.region,
            labels,
            power: 'running',
            ipv4: null,
          },
        });
      }
      await migrate(fixture.connection);
      const principal = await authenticate(fixture.connection.db, `Bearer ${token}`);
      expect(principal.policy).toMatchObject({ currency: 'EUR', maxHourlyMicros: 20000 });
      const [account] = await fixture.connection.db.select().from(accounts);
      expect(account).toMatchObject({ currency: 'EUR', maxHourlyMicros: 20000 });
      const [stored] = await fixture.connection.db.select().from(operations);
      expect(catalogItemSchema.parse(stored?.offer)).toEqual({
        ...simulatedCatalog().items.find((item) => item.size === 'small' && item.region === 'nbg1'),
        priceBasis: 'legacy_estimate',
      });
      const provider = new SimulatedProvider({ db: fixture.connection.db });
      await expect
        .poll(async () => {
          await advanceOperation({
            limits: { currency: 'EUR', maxMachines: 100, maxHourlyMicros: 10000000 },
            connection: fixture.connection,
            operationId: id.operation,
            provider,
          });
          const [row] = await fixture.connection.db
            .select()
            .from(operations)
            .where(eq(operations.id, id.operation));
          return operationProgressSchema.parse(row?.progress).kind;
        })
        .toBe('succeeded');
      const [allocation] = await fixture.connection.db.select().from(allocations);
      expect(allocation).toMatchObject({ currency: 'EUR', hourlyMicros: 9600 });
      expect(await fixture.connection.db.select().from(attempts)).toHaveLength(1);
      expect(await fixture.connection.db.select().from(simulatedServers)).toHaveLength(1);
      expect(
        JSON.stringify((await fixture.connection.db.select().from(grants))[0]?.policy),
      ).not.toContain('maxHourlyMicroEur');
    } finally {
      await fixture.close();
      await rm(folder, { recursive: true, force: true });
    }
  },
);

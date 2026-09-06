import { randomUUID } from 'node:crypto';
import {
  capabilitySchema,
  grantPolicySchema,
  newId,
  principalSchema,
  regionSchema,
  sizeSchema,
  type GrantPolicy,
} from '../packages/contracts/src/index.js';
import {
  connect,
  migrate,
  accounts,
  grants,
  projects,
  type Database,
  type Connection,
} from '../packages/db/src/index.js';
import { generateToken, hashToken } from '../apps/control/src/auth.js';

export async function testDatabase(initialize?: (connection: Connection) => Promise<void>) {
  const sourceUrl =
    process.env.TEST_DATABASE_URL ??
    'postgresql://agentcloud:local-development-only@127.0.0.1:55439/agentcloud';
  const admin = connect(sourceUrl, 2);
  // This identifier comes only from a generated UUID, never from an environment value.
  const name = `agentcloud_test_${randomUUID().replaceAll('-', '')}`;
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  const url = new URL(sourceUrl);
  url.pathname = `/${name}`;
  const connection = connect(url.toString());
  try {
    if (initialize) await initialize(connection);
    else await migrate(connection);
  } catch (error) {
    await connection.pool.end();
    await admin.pool.query(`DROP DATABASE "${name}"`);
    await admin.pool.end();
    throw error;
  }
  return {
    connection,
    databaseUrl: url.toString(),
    async reset() {
      await connection.pool.query(
        'TRUNCATE accounts, simulated_servers, simulated_actions, simulated_primary_ips RESTART IDENTITY CASCADE',
      );
    },
    async close() {
      await connection.pool.end();
      await admin.pool.query(`DROP DATABASE "${name}"`);
      await admin.pool.end();
    },
  };
}

export async function seedAccount(
  db: Database,
  options: { maxMachines?: number; currency?: string; policy?: GrantPolicy } = {},
) {
  const accountId = newId.account();
  const projectId = newId.project();
  const grantId = newId.grant();
  const token = generateToken();
  const policy =
    options.policy ??
    grantPolicySchema.parse({
      capabilities: capabilitySchema.options,
      projects: { kind: 'all' },
      sizes: sizeSchema.options,
      regions: regionSchema.options,
      maxMachines: options.maxMachines ?? 20,
      currency: options.currency ?? 'EUR',
      maxHourlyMicros: 1_000_000,
    });
  await db.transaction(async (tx) => {
    await tx.insert(accounts).values({
      id: accountId,
      name: 'test',
      maxMachines: options.maxMachines ?? 20,
      currency: options.currency ?? 'EUR',
      maxHourlyMicros: 1_000_000,
    });
    await tx.insert(projects).values({ id: projectId, accountId, name: 'default' });
    await tx.insert(grants).values({
      id: grantId,
      accountId,
      name: 'test',
      tokenHash: hashToken(token),
      policy,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
  });
  return { principal: principalSchema.parse({ accountId, grantId, policy }), projectId, token };
}

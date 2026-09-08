import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from './schema.js';

export function connect(connectionString: string, max = 12) {
  const pool = new pg.Pool({ connectionString, max, connectionTimeoutMillis: 5_000 });
  pool.on('error', () => {
    process.emitWarning('An idle PostgreSQL connection failed and was removed from the pool.', {
      code: 'DATABASE_CONNECTION',
    });
  });
  pool.on('connect', (client) => {
    client.on('error', () => {
      process.emitWarning(
        'An active PostgreSQL connection failed; its operation will be reconciled.',
        {
          code: 'DATABASE_CONNECTION',
        },
      );
    });
  });
  return { pool, db: drizzle(pool, { schema }) };
}
export type Connection = ReturnType<typeof connect>;

/** Use the database clock when a SQL guard enforces the same instant or lifetime. */
export async function databaseTime(db: Executor): Promise<Date> {
  // Drizzle returns raw timestamp columns as strings; request numeric milliseconds explicitly.
  const result = await db.execute<{ now: number }>(
    sql`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::float8 AS now`,
  );
  const row = result.rows[0];
  if (!row || !Number.isFinite(row.now))
    throw new Error('Database clock returned no valid instant.');
  return new Date(row.now);
}
export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Executor = Database | Transaction;

export async function withMachineLock<T>(input: {
  pool: pg.Pool;
  machineId: string;
  work: (db: Database) => Promise<T>;
}): Promise<{ kind: 'acquired'; value: T } | { kind: 'busy' }> {
  return withResourceLock({ ...input, key: `machine:${input.machineId}` });
}

export async function withImageBuildLock<T>(input: {
  pool: pg.Pool;
  buildId: string;
  work: (db: Database) => Promise<T>;
}): Promise<{ kind: 'acquired'; value: T } | { kind: 'busy' }> {
  return withResourceLock({ ...input, key: `image-build:${input.buildId}` });
}

/** Offline recovery writes use the same connection that owns exclusivity. */
export async function withControlRecoveryLock<T>(input: {
  pool: pg.Pool;
  work: (db: Database) => Promise<T>;
}) {
  return withResourceLock({ ...input, key: 'control-recovery' });
}

export async function withAccessSessionLock<T>(input: {
  pool: pg.Pool;
  sessionId: string;
  work: (db: Database) => Promise<T>;
}): Promise<{ kind: 'acquired'; value: T } | { kind: 'busy' }> {
  return withResourceLock({ ...input, key: `access-session:${input.sessionId}` });
}

/** A single backup worker bounds plaintext/ciphertext scratch across all accounts and processes. */
export async function withBackupWorkerLock<T>(input: {
  pool: pg.Pool;
  work: (db: Database) => Promise<T>;
}) {
  return withResourceLock({ ...input, key: 'backup-worker' });
}

async function withResourceLock<T>(input: {
  pool: pg.Pool;
  key: string;
  work: (db: Database) => Promise<T>;
}): Promise<{ kind: 'acquired'; value: T } | { kind: 'busy' }> {
  const client = await input.pool.connect();
  let acquired = false;
  try {
    const result = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
      [input.key],
    );
    acquired = result.rows[0]?.acquired === true;
    if (!acquired) return { kind: 'busy' };
    return { kind: 'acquired', value: await input.work(drizzle(client, { schema })) };
  } finally {
    let discard = false;
    if (acquired) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [input.key]);
      } catch {
        // A connection with uncertain lock state must never return to the pool.
        discard = true;
      }
    }
    client.release(discard);
  }
}

export async function enqueueOperation(db: Executor, operationId: string): Promise<void> {
  await db.execute(sql`SELECT graphile_worker.add_job(
    'advance_operation', ${JSON.stringify({ operationId })}::json,
    max_attempts := 25, job_key := ${operationId}
  )`);
}

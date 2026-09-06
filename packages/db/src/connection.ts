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
export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Executor = Database | Transaction;

export async function withMachineLock<T>(input: {
  pool: pg.Pool;
  machineId: string;
  work: (db: Database) => Promise<T>;
}): Promise<{ kind: 'acquired'; value: T } | { kind: 'busy' }> {
  const client = await input.pool.connect();
  let acquired = false;
  try {
    const result = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
      [`machine:${input.machineId}`],
    );
    acquired = result.rows[0]?.acquired === true;
    if (!acquired) return { kind: 'busy' };
    return { kind: 'acquired', value: await input.work(drizzle(client, { schema })) };
  } finally {
    let discard = false;
    if (acquired) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
          `machine:${input.machineId}`,
        ]);
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

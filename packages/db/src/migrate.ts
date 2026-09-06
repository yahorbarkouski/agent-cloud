import { fileURLToPath } from 'node:url';
import { migrate as migrateDrizzle } from 'drizzle-orm/node-postgres/migrator';
import { runMigrations } from 'graphile-worker';
import { connect, type Connection } from './connection.js';

export async function migrate(connection: Connection): Promise<void> {
  const client = await connection.pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(78131024)');
    await migrateDrizzle(connection.db, {
      migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
    });
    await runMigrations({ pgPool: connection.pool });
  } finally {
    // Discarding the migration connection also guarantees its session lock is released.
    client.release(true);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required; load .env before migrating.');
  const connection = connect(url);
  try {
    await migrate(connection);
    process.stdout.write('Database and worker migrations applied.\n');
  } finally {
    await connection.pool.end();
  }
}

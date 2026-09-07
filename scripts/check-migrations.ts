import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { connect } from '../packages/db/dist/index.js';

const directory = new URL('../packages/db/migrations/', import.meta.url);
const journal = z
  .object({
    entries: z.array(z.object({ tag: z.string().regex(/^[a-z0-9_]+$/), when: z.int().positive() })),
  })
  .parse(JSON.parse(await readFile(new URL('meta/_journal.json', directory), 'utf8')));
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required.');
const connection = connect(url);
try {
  const applied = await connection.pool.query<{ hash: string; created_at: string }>(
    'SELECT hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id',
  );
  const migrations = await Promise.all(
    journal.entries.map(async (entry, index) => {
      const hash = createHash('sha256')
        .update(await readFile(new URL(entry.tag + '.sql', directory)))
        .digest('hex');
      const row = applied.rows[index];
      return {
        name: entry.tag,
        hash,
        matches: row?.hash === hash && row.created_at === String(entry.when),
      };
    }),
  );
  const matches =
    applied.rows.length === migrations.length && migrations.every((migration) => migration.matches);
  process.stdout.write(
    JSON.stringify({
      directory: fileURLToPath(directory),
      applied: applied.rows.length,
      expected: migrations.length,
      matches,
      migrations,
    }) + '\n',
  );
  if (!matches) process.exitCode = 1;
} finally {
  await connection.pool.end();
}

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { z } from 'zod';

/** Small real application used to verify hosting, updates and database recovery. */
async function startReferenceApp() {
  const revision = z.enum(['1', '2']).parse(process.env.APP_REVISION);
  const password = (await readFile('/run/secrets/database_password', 'utf8')).trim();
  const pool = new pg.Pool({
    host: 'database',
    user: 'reference',
    database: 'reference',
    password,
    max: 4,
  });
  pool.on('error', () => process.stderr.write('database_connection_failed\n'));
  await pool.query(
    'CREATE TABLE IF NOT EXISTS visits (id integer PRIMARY KEY, count bigint NOT NULL)',
  );
  await pool.query('INSERT INTO visits (id, count) VALUES (1, 0) ON CONFLICT DO NOTHING');
  const server = createServer((request, response) => {
    const run = async () => {
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('Cache-Control', 'no-store');
      if (request.method === 'GET' && request.url === '/api/health') {
        await pool.query('SELECT 1');
        response.end(JSON.stringify({ status: 'ok', revision }));
      } else if (request.method === 'GET' && request.url === '/api/visits') {
        const result = await pool.query('SELECT count::text FROM visits WHERE id = 1');
        const rows = z
          .array(z.object({ count: z.string().regex(/^\d+$/) }))
          .length(1)
          .parse(result.rows);
        response.end(JSON.stringify({ revision, count: rows[0]?.count }));
      } else if (request.method === 'POST' && request.url === '/api/visits') {
        // No cookies or ambient authority. Only the same-origin frontend may mutate the counter.
        if (request.headers.origin !== `https://${process.env.APP_HOSTNAME}`) {
          response.writeHead(403).end();
          return;
        }
        const result = await pool.query(
          'UPDATE visits SET count = count + 1 WHERE id = 1 RETURNING count::text',
        );
        const rows = z
          .array(z.object({ count: z.string().regex(/^\d+$/) }))
          .length(1)
          .parse(result.rows);
        response.end(JSON.stringify({ revision, count: rows[0]?.count }));
        process.stdout.write('visit_recorded\n');
      } else response.writeHead(404).end(JSON.stringify({ error: 'not_found' }));
    };
    void run().catch(() => {
      process.stderr.write('request_failed\n');
      if (!response.headersSent) response.writeHead(503);
      response.end(JSON.stringify({ error: 'unavailable' }));
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 32;
  server.listen(3000, '0.0.0.0', () =>
    process.stdout.write(`reference_ready revision=${revision}\n`),
  );
  process.once('SIGTERM', () =>
    server.close(() => {
      void pool.end();
    }),
  );
}

startReferenceApp().catch(() => {
  process.stderr.write('application_start_failed\n');
  process.exitCode = 1;
});

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { testDatabase } from './database.js';

let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  fixture = await testDatabase();
});
afterAll(async () => {
  await fixture.close();
});

async function unusedPort() {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Expected temporary local port.');
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => {
      if (error) reject(error);
      else resolve();
    }),
  );
  return address.port;
}

for (const entry of ['api', 'worker'])
  it(`terminates the actual ${entry} when its execution lease is lost`, async () => {
    const path = await fixture.controlIdentity();
    const url = new URL(fixture.databaseUrl);
    const name = `fence-${randomUUID()}`;
    url.searchParams.set('application_name', name);
    const child = spawn(process.execPath, [`apps/control/dist/${entry}.js`], {
      env: {
        DATABASE_URL: url.toString(),
        PROVIDER: 'simulated',
        ACLD_CONTROL_GENERATION_FILE: path,
        HOST: '127.0.0.1',
        PORT: String(await unusedPort()),
      },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const exited = once(child, 'exit');
    try {
      await new Promise<void>((resolve, reject) => {
        let text = '';
        const timeout = setTimeout(() => {
          done(new Error('Control process did not become ready.'));
        }, 10_000);
        const output = (chunk: Buffer) => {
          text += chunk.toString('utf8');
          if (text.includes(`"event":"${entry === 'api' ? 'api.listening' : 'worker.started'}"`))
            done();
          else if (text.length > 16_384) done(new Error('Unexpected process output size.'));
        };
        const early = () => {
          done(new Error('Control process exited before readiness.'));
        };
        function done(error?: Error) {
          clearTimeout(timeout);
          child.stdout.off('data', output);
          child.off('exit', early);
          if (error) reject(error);
          else resolve();
        }
        child.stdout.on('data', output);
        child.once('exit', early);
      });
      const sessions = await fixture.connection.pool.query<{ pid: number }>(
        "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND query='SELECT state FROM control_state WHERE id = 1'",
        [name],
      );
      expect(sessions.rows).toHaveLength(1);
      const pid = sessions.rows[0]?.pid;
      if (!pid) throw new Error('Missing exact execution lease backend.');
      await fixture.connection.pool.query('SELECT pg_terminate_backend($1)', [pid]);
      const result = await Promise.race([
        exited,
        new Promise<never>((_resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Mutator survived loss of its execution lease.'));
          }, 5000);
          void exited.finally(() => {
            clearTimeout(timeout);
          });
        }),
      ]);
      expect(result[0]).toBe(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  });

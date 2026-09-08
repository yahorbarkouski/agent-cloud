import { z } from 'zod';
import { CloudError } from '@agent-cloud/contracts';
import type { Connection } from '@agent-cloud/db';
import { readPrivateFile } from './private-file.js';

export const controlGenerationSchema = z.strictObject({
  version: z.literal(1),
  generation: z.uuidv4(),
});
export const controlStateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ready'), generation: z.uuidv4() }),
  z.strictObject({
    kind: z.literal('recovering'),
    generation: z.uuidv4(),
    recoveryId: z.uuidv4(),
  }),
]);

const unavailable = () =>
  new CloudError(
    'provider_unavailable',
    'Control execution is fenced until recovery is ready.',
    true,
  );
type FenceOptions = { onLost?: () => void };

/** One held session excludes recovery for this process lifetime, without borrowing per request. */
export async function openControlFence(
  connection: Connection,
  path?: string,
  options: FenceOptions = {},
) {
  if (path === undefined) return undefined;
  return openFence(connection, path, 'ready', options);
}

/** Offline repair holds exclusive authority, preventing execution and concurrent recovery/resume. */
export function openControlRecoveryFence(
  connection: Connection,
  path: string,
  options: FenceOptions = {},
) {
  return openFence(connection, path, 'recovering', options);
}

async function openFence(
  connection: Connection,
  path: string,
  mode: 'ready' | 'recovering',
  options: FenceOptions,
) {
  const acquire =
    mode === 'ready'
      ? "SELECT pg_try_advisory_lock_shared(hashtextextended('control-recovery', 0)) AS acquired"
      : "SELECT pg_try_advisory_lock(hashtextextended('control-recovery', 0)) AS acquired";
  const release =
    mode === 'ready'
      ? "SELECT pg_advisory_unlock_shared(hashtextextended('control-recovery', 0)) AS released"
      : "SELECT pg_advisory_unlock(hashtextextended('control-recovery', 0)) AS released";
  const client = await connection.pool.connect().catch(() => {
    throw unavailable();
  });
  let acquired = false;
  let failed = false;
  let closed = false;
  let tail = Promise.resolve();
  let closing: Promise<void> | undefined;
  const lost = () => {
    if (failed) return;
    failed = true;
    options.onLost?.();
  };
  client.on('error', lost);
  client.on('end', lost);

  function assertActive() {
    if (failed || closed) throw unavailable();
  }

  async function inspect() {
    assertActive();
    const external = controlGenerationSchema.parse(JSON.parse(await readPrivateFile(path)));
    assertActive();
    const result = await client
      .query<{ state: unknown }>('SELECT state FROM control_state WHERE id = 1')
      .catch(() => {
        lost();
        throw unavailable();
      });
    assertActive();
    const state = controlStateSchema.parse(result.rows[0]?.state);
    if (state.kind !== mode || state.generation !== external.generation) throw unavailable();
    return external.generation;
  }

  function close() {
    if (closing) return closing;
    closed = true;
    closing = tail.then(async () => {
      try {
        if (acquired && !failed) {
          const result = await client.query<{ released: boolean }>(release);
          if (result.rows[0]?.released !== true) lost();
        }
      } catch {
        lost();
      } finally {
        // Never return a session whose connection or lock ownership became uncertain.
        client.release(failed);
        client.off('error', lost);
        client.off('end', lost);
      }
    });
    return closing;
  }

  try {
    const result = await client.query<{ acquired: boolean }>(acquire).catch(() => {
      lost();
      throw unavailable();
    });
    acquired = result.rows[0]?.acquired === true;
    if (!acquired) throw unavailable();
    const generation = await inspect();
    return {
      check: () => {
        const check = tail.then(async () => {
          try {
            if ((await inspect()) !== generation) throw unavailable();
          } catch {
            throw unavailable();
          }
        });
        tail = check.catch(() => undefined);
        return check;
      },
      close,
    };
  } catch {
    await close();
    throw unavailable();
  }
}

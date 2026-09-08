import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { connect } from '../packages/db/src/index.js';
import {
  controlGenerationSchema,
  controlStateSchema,
  openControlFence,
  openControlRecoveryFence,
} from '../apps/control/src/control-fence.js';
import { testDatabase } from './database.js';

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'acld-control-fence-'));
  fixture = await testDatabase();
});
afterAll(async () => {
  try {
    await fixture.close();
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});
beforeEach(async () => {
  await fixture.connection.pool.query('DELETE FROM control_state');
});

async function generationFile(generation = randomUUID()) {
  const path = join(directory, randomUUID());
  await writeFile(path, JSON.stringify({ version: 1, generation }), { mode: 0o600, flag: 'wx' });
  return { path, generation };
}
async function setState(state: unknown) {
  await fixture.connection.pool.query(
    'INSERT INTO control_state (id, state) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state',
    [JSON.stringify(state)],
  );
}
async function ready() {
  const identity = await generationFile();
  await setState({ kind: 'ready', generation: identity.generation });
  return identity;
}
async function refuse(work: Promise<unknown>) {
  await expect(work).rejects.toMatchObject({
    name: 'CloudError',
    message: 'Control execution is fenced until recovery is ready.',
    failure: {
      code: 'provider_unavailable',
      message: 'Control execution is fenced until recovery is ready.',
      retryable: true,
    },
  });
}
async function exclusiveAvailable() {
  const client = await fixture.connection.pool.connect();
  try {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended('control-recovery', 0)) AS acquired",
    );
    return result.rows[0]?.acquired === true;
  } finally {
    // The exact observer session is discarded, releasing any acquired exclusive lock.
    client.release(true);
  }
}

it('requires exact versioned UUIDv4 records and leaves an unconfigured development process unchanged', async () => {
  const generation = randomUUID();
  expect(controlGenerationSchema.parse({ version: 1, generation })).toEqual({
    version: 1,
    generation,
  });
  expect(
    controlStateSchema.parse({ kind: 'recovering', generation, recoveryId: randomUUID() }).kind,
  ).toBe('recovering');
  expect(controlGenerationSchema.safeParse({ version: 2, generation }).success).toBe(false);
  expect(
    controlGenerationSchema.safeParse({
      version: 1,
      generation: '00000000-0000-0000-0000-000000000000',
    }).success,
  ).toBe(false);
  expect(controlStateSchema.safeParse({ kind: 'recovering', generation }).success).toBe(false);
  const connected = vi.spyOn(fixture.connection.pool, 'connect');
  try {
    expect(await openControlFence(fixture.connection)).toBeUndefined();
    expect(connected).not.toHaveBeenCalled();
  } finally {
    connected.mockRestore();
  }
});

it('holds one session through concurrent checks, shares it with other fences and releases it exactly once', async () => {
  const { path } = await ready();
  const single = connect(fixture.databaseUrl, 1);
  const fence = await openControlFence(single, path);
  const other = await openControlFence(fixture.connection, path);
  if (!fence || !other) throw new Error('Expected configured fences.');
  try {
    await Promise.all(Array.from({ length: 24 }, () => fence.check()));
    expect(single.pool.totalCount).toBe(1);
    expect(single.pool.idleCount).toBe(0);
    expect(single.pool.waitingCount).toBe(0);
    expect(await exclusiveAvailable()).toBe(false);
    await other.close();
    expect(await exclusiveAvailable()).toBe(false);
    const firstClose = fence.close();
    expect(fence.close()).toBe(firstClose);
    await firstClose;
    await refuse(fence.check());
    expect(single.pool.idleCount).toBe(1);
    expect(await exclusiveAvailable()).toBe(true);
  } finally {
    await other.close();
    await fence.close();
    await single.pool.end();
  }
});

it('refuses missing, malformed, linked and permissive private files without leaking a shared lock', async () => {
  const { path } = await ready();
  const missing = join(directory, randomUUID());
  await refuse(openControlFence(fixture.connection, missing));
  const link = join(directory, randomUUID());
  await symlink(path, link);
  await refuse(openControlFence(fixture.connection, link));
  await chmod(path, 0o644);
  await refuse(openControlFence(fixture.connection, path));
  await chmod(path, 0o600);
  await writeFile(path, '{"secret":"fixture-private-malformed"');
  await refuse(openControlFence(fixture.connection, path));
  expect(await exclusiveAvailable()).toBe(true);
});

it('refuses missing, malformed, recovering and mismatched database state', async () => {
  const { path } = await generationFile();
  await refuse(openControlFence(fixture.connection, path));
  for (const state of [
    { kind: 'ready' },
    { kind: 'ready', generation: randomUUID() },
    { kind: 'recovering', generation: randomUUID(), recoveryId: randomUUID() },
  ]) {
    await setState(state);
    await refuse(openControlFence(fixture.connection, path));
  }
  expect(await exclusiveAvailable()).toBe(true);
});

it('refuses admission while an exclusive recovery session holds the lock', async () => {
  const { path } = await ready();
  const recovery = await fixture.connection.pool.connect();
  try {
    await recovery.query("SELECT pg_advisory_lock(hashtextextended('control-recovery', 0))");
    await refuse(openControlFence(fixture.connection, path));
  } finally {
    recovery.release(true);
  }
  const fence = await openControlFence(fixture.connection, path);
  if (!fence) throw new Error('Expected a configured fence.');
  await fence.close();
  expect(await exclusiveAvailable()).toBe(true);
});

it('rechecks ready state and the private file, and never adopts a replacement generation', async () => {
  const { path, generation } = await ready();
  const fence = await openControlFence(fixture.connection, path);
  if (!fence) throw new Error('Expected a configured fence.');
  try {
    await setState({ kind: 'recovering', generation, recoveryId: randomUUID() });
    await refuse(fence.check());
    await setState({ kind: 'ready', generation });
    await fence.check();
    await chmod(path, 0o644);
    await refuse(fence.check());
    await chmod(path, 0o600);
    const replacement = randomUUID();
    await writeFile(path, JSON.stringify({ version: 1, generation: replacement }));
    await refuse(fence.check());
    await setState({ kind: 'ready', generation: replacement });
    await refuse(fence.check());
    await rm(path);
    await refuse(fence.check());
  } finally {
    await fence.close();
  }
});

it('permanently refuses after losing the exact held PostgreSQL connection and discards it on close', async () => {
  const { path } = await ready();
  const single = connect(fixture.databaseUrl, 1);
  const onLost = vi.fn();
  const fence = await openControlFence(single, path, { onLost });
  if (!fence) throw new Error('Expected a configured fence.');
  try {
    const locks = await fixture.connection.pool.query<{ pid: number }>(
      "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND mode = 'ShareLock' AND granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
    );
    expect(locks.rows).toHaveLength(1);
    const lock = locks.rows[0];
    if (!lock) throw new Error('Expected the fixture shared lock.');
    await fixture.connection.pool.query('SELECT pg_terminate_backend($1)', [lock.pid]);
    await refuse(fence.check());
    await refuse(fence.check());
    await fence.close();
    await fence.close();
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(single.pool.totalCount).toBe(0);
    expect(await exclusiveAvailable()).toBe(true);
  } finally {
    await fence.close();
    await single.pool.end();
  }
});

it('closes safely with queued checks and never borrows the released client again', async () => {
  const { path } = await ready();
  const fence = await openControlFence(fixture.connection, path);
  if (!fence) throw new Error('Expected a configured fence.');
  try {
    const checks = Promise.allSettled(Array.from({ length: 12 }, () => fence.check()));
    await fence.close();
    expect((await checks).every((result) => result.status === 'rejected')).toBe(true);
    await refuse(fence.check());
    expect(await exclusiveAvailable()).toBe(true);
  } finally {
    await fence.close();
  }
});

it('holds an exclusive recovery lease against normal execution and another recovery', async () => {
  const { path, generation } = await generationFile();
  const state = { kind: 'recovering', generation, recoveryId: randomUUID() };
  await setState(state);
  const recovery = await openControlRecoveryFence(fixture.connection, path);
  try {
    await recovery.check();
    await refuse(openControlRecoveryFence(fixture.connection, path));
    // Even a ready row cannot admit execution while the offline repair session still holds its lock.
    await setState({ kind: 'ready', generation });
    await refuse(openControlFence(fixture.connection, path));
    await refuse(recovery.check());
    await setState(state);
    await recovery.check();
  } finally {
    await recovery.close();
    await recovery.close();
  }
  expect(await exclusiveAvailable()).toBe(true);
  await setState({ kind: 'ready', generation });
  const execution = await openControlFence(fixture.connection, path);
  if (!execution) throw new Error('Expected a configured fence.');
  await execution.close();
});

it('refuses a recovery lease in ready state and preserves the existing execution contract', async () => {
  const { path } = await ready();
  await refuse(openControlRecoveryFence(fixture.connection, path));
  expect(await exclusiveAvailable()).toBe(true);
  const execution = await openControlFence(fixture.connection, path);
  if (!execution) throw new Error('Expected a configured fence.');
  try {
    await execution.check();
  } finally {
    await execution.close();
  }
});

it('notifies once on connection loss before a check, but never on generation mismatch or ordinary close', async () => {
  const { path, generation } = await ready();
  const single = connect(fixture.databaseUrl, 1);
  const onLost = vi.fn();
  try {
    const client = await single.pool.connect();
    client.release();
    const execution = await openControlFence(single, path, { onLost });
    if (!execution) throw new Error('Expected a configured fence.');
    try {
      await setState({ kind: 'ready', generation: randomUUID() });
      await refuse(execution.check());
      expect(onLost).not.toHaveBeenCalled();
    } finally {
      await execution.close();
    }
    expect(onLost).not.toHaveBeenCalled();

    await setState({ kind: 'recovering', generation, recoveryId: randomUUID() });
    const recovery = await openControlRecoveryFence(single, path, { onLost });
    try {
      // The max-one pool reuses this exact client. Loss must notify without awaiting check().
      client.emit('error', new Error('Fixture connection loss.'));
      expect(onLost).toHaveBeenCalledTimes(1);
      client.emit('end');
      client.emit('error', new Error('Repeated fixture connection loss.'));
      await refuse(recovery.check());
      expect(onLost).toHaveBeenCalledTimes(1);
    } finally {
      await recovery.close();
      await recovery.close();
    }
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(single.pool.totalCount).toBe(0);
  } finally {
    await single.pool.end();
  }
});

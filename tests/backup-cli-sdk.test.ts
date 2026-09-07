import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  backupCaptureRequestSchema,
  backupResponseSchema,
  newId,
  restoreRequestSchema,
  restoreResponseSchema,
} from '../packages/contracts/src/index.js';
import { CloudClient } from '../packages/sdk/src/index.js';

const machineId = newId.machine();
const backupId = randomUUID();
const restoreId = randomUUID();
const releaseId = randomUUID();
const request = backupCaptureRequestSchema.parse({
  id: backupId,
  recipe: {
    kind: 'compose-postgres',
    app: 'counter',
    releaseId,
    service: 'database',
    database: 'counter',
    user: 'counter',
    files: ['counter/config.json'],
  },
});
const backup = backupResponseSchema.parse({
  backup: {
    id: backupId,
    accountId: newId.account(),
    projectId: newId.project(),
    machineId,
    allocationId: newId.allocation(),
    createdAt: new Date().toISOString(),
    retainUntil: new Date(Date.now() + 86_400_000).toISOString(),
    state: { kind: 'pending' },
  },
});
const restoreRequest = restoreRequestSchema.parse({
  id: restoreId,
  backupId,
  app: 'restored-counter',
  machine: { name: 'counter-restored', size: 'small', region: 'nbg1' },
});
const restore = restoreResponseSchema.parse({
  restore: {
    id: restoreId,
    backupId,
    accountId: backup.backup.accountId,
    projectId: backup.backup.projectId,
    machineId: newId.machine(),
    operationId: newId.operation(),
    createdAt: new Date().toISOString(),
    state: { kind: 'pending' },
  },
});
const captured = backupResponseSchema.parse({
  backup: {
    ...backup.backup,
    state: {
      kind: 'captured',
      bytes: 1024,
      capturedAt: new Date().toISOString(),
      validation: 'captured',
      manifest: {
        version: 1,
        recipe: request.recipe,
        capturedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        postgresVersion: 'PostgreSQL 16',
        sourceFiles: 3,
        declaredFiles: request.recipe.files,
        consistency: 'database-consistent-files-best-effort',
        exclusions: ['Other files and services are excluded.'],
      },
    },
  },
});
const restored = restoreResponseSchema.parse({
  restore: {
    ...restore.restore,
    state: {
      kind: 'restored',
      result: {
        kind: 'restored',
        id: restoreId,
        app: restoreRequest.app,
        releaseId: randomUUID(),
        postgresVersion: 'PostgreSQL 16',
        integrity: 'database-restored-services-healthy',
      },
    },
  },
});
const token = 'acld_' + 'a'.repeat(43);
let transport: ReturnType<typeof vi.fn<typeof fetch>>;
let client: CloudClient;
let directory: string;
let credentialsFile: string;
let server: ReturnType<typeof createServer>;
const originalExitCode = process.exitCode;
beforeEach(async () => {
  transport = vi.fn<typeof fetch>((url) => {
    const path = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    return Promise.resolve(
      Response.json(
        path.endsWith('/restores') || path.includes('/restores/')
          ? restore
          : path.endsWith(`/machines/${machineId}/backups`)
            ? { backups: [backup.backup] }
            : backup,
      ),
    );
  });
  client = new CloudClient({ server: 'http://127.0.0.1:18080', token, transport });
  directory = await mkdtemp('/tmp/acld-backup-cli-');
  server = createServer((request, response) => {
    void (async () => {
      let body = '';
      for await (const chunk of request) {
        const value: unknown = chunk;
        if (!Buffer.isBuffer(value)) throw new Error('Invalid fixture request.');
        body += value.toString('utf8');
        if (body.length > 65_536) throw new Error('Fixture request exceeds its limit.');
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers))
        if (typeof value === 'string') headers.set(key, value);
      const result = await transport(`http://127.0.0.1:18080${request.url ?? '/'}`, {
        method: request.method ?? 'GET',
        headers,
        ...(body ? { body } : {}),
      });
      response.writeHead(result.status, { 'Content-Type': 'application/json' });
      response.end(await result.text());
    })().catch(() => {
      response.writeHead(502, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          error: { code: 'provider_unavailable', message: 'Lost response.', retryable: true },
          requestId: randomUUID(),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local API address.');
  credentialsFile = join(directory, 'credentials.json');
  await writeFile(
    credentialsFile,
    JSON.stringify({ server: `http://127.0.0.1:${address.port}`, token }),
    { mode: 0o600 },
  );
});
afterEach(async () => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    }),
  );
  await rm(directory, { recursive: true, force: true });
});

async function cli(args: string[]) {
  const output = vi.fn<(value: unknown) => void>();
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', 'apps/cli/src/index.ts', ...args],
      {
        env: { ...process.env, ACLD_CREDENTIALS: credentialsFile },
        timeout: 10_000,
        maxBuffer: 65_536,
      },
      (error, stdout, stderr) => {
        resolve({ code: error ? 1 : 0, stdout, stderr });
      },
    );
  });
  expect(result.stdout + result.stderr).not.toContain(token);
  if (result.code !== 0 && !result.stdout) throw new Error(result.stderr);
  if (result.stdout) output(JSON.parse(result.stdout));
  if (result.code) process.exitCode = result.code;
  return output;
}
const captureArgs = [
  'backup',
  'capture',
  machineId,
  'counter',
  '--id',
  backupId,
  '--release',
  releaseId,
  '--service',
  'database',
  '--database',
  'counter',
  '--user',
  'counter',
];
const restoreArgs = [
  'backup',
  'restore',
  backupId,
  'restored-counter',
  '--id',
  restoreId,
  '--name',
  'counter-restored',
];

it('submits a typed backup capture once with the supplied identity and recipe', async () => {
  transport.mockResolvedValueOnce(Response.json(backup));
  expect(await client.captureBackup({ machineId, request })).toEqual(backup);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(transport.mock.calls[0]?.[0]).toBe(
    `http://127.0.0.1:18080/v1/machines/${machineId}/backups`,
  );
  const call = transport.mock.calls[0]?.[1];
  expect(call?.method).toBe('POST');
  expect(call?.body).toBe(JSON.stringify(request));
  expect(call?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
  expect(call?.redirect).toBe('error');
});

it('never retries a lost capture or restore reply and permits inspection by the original ID', async () => {
  transport.mockRejectedValueOnce(new Error('Connection disappeared after acceptance.'));
  await expect(client.captureBackup({ machineId, request })).rejects.toThrow(
    'Connection disappeared',
  );
  expect(transport).toHaveBeenCalledTimes(1);
  await client.backup(backupId);
  expect(transport.mock.calls[1]?.[0]).toBe(`http://127.0.0.1:18080/v1/backups/${backupId}`);
  transport.mockRejectedValueOnce(new Error('Connection disappeared after acceptance.'));
  await expect(client.restoreBackup(restoreRequest)).rejects.toThrow('Connection disappeared');
  expect(transport).toHaveBeenCalledTimes(3);
  await client.restore(restoreId);
  expect(transport.mock.calls[3]?.[0]).toBe(`http://127.0.0.1:18080/v1/restores/${restoreId}`);
});

it('validates list, inspect and isolated restore responses', async () => {
  expect(await client.backups(machineId)).toEqual({ backups: [backup.backup] });
  expect(await client.backup(backupId)).toEqual(backup);
  expect(await client.restoreBackup(restoreRequest)).toEqual(restore);
  expect(transport.mock.calls[2]?.[1]?.body).toBe(JSON.stringify(restoreRequest));
  expect(restore.restore.machineId).not.toBe(machineId);
  expect(restore.restore.operationId).toMatch(/^op_/);
  transport.mockResolvedValueOnce(Response.json({ backup: { id: backupId } }));
  await expect(client.backup(backupId)).rejects.toThrow();
});

it('rejects invalid identifiers and an existing restore target before transport', () => {
  expect(() => client.backup('../../unrelated')).toThrow();
  expect(() => client.restore('../../unrelated')).toThrow();
  const existingTarget = {
    ...restoreRequest,
    machine: { ...restoreRequest.machine, machineId },
  };
  expect(() => client.restoreBackup(existingTarget)).toThrow();
  expect(transport).not.toHaveBeenCalled();
});

it('waits by reading the stable ID and returns captured, restored and blocked states', async () => {
  transport.mockResolvedValueOnce(Response.json(captured));
  expect(await client.waitBackup({ backupId })).toEqual(captured);
  transport.mockResolvedValueOnce(Response.json(restored));
  expect(await client.waitRestore({ restoreId })).toEqual(restored);
  const blocked = {
    backup: {
      ...backup.backup,
      state: { kind: 'blocked', reason: 'Storage verification unavailable.' },
    },
  };
  transport.mockResolvedValueOnce(Response.json(blocked));
  expect(await client.waitBackup({ backupId })).toEqual(blocked);
  expect(transport.mock.calls.every((call) => call[1]?.method === 'GET')).toBe(true);
});

it.each(['backup', 'restore'])(
  'bounds local %s waits without submitting new work',
  async (kind) => {
    const wait =
      kind === 'backup'
        ? client.waitBackup({ backupId, timeoutMs: 25 })
        : client.waitRestore({ restoreId, timeoutMs: 25 });
    await expect(wait).rejects.toMatchObject({
      failure: { code: 'provider_unavailable', retryable: true },
    });
    expect(transport.mock.calls.every((call) => call[1]?.method === 'GET')).toBe(true);
    expect(transport.mock.calls.length).toBeGreaterThan(0);
  },
);

it('can abort a pending wait before the first request', async () => {
  const abort = new AbortController();
  abort.abort(new Error('Cancelled local wait.'));
  await expect(client.waitBackup({ backupId, signal: abort.signal })).rejects.toThrow(
    'Cancelled local wait',
  );
  await expect(client.waitRestore({ restoreId, signal: abort.signal })).rejects.toThrow(
    'Cancelled local wait',
  );
  expect(transport).not.toHaveBeenCalled();
});

it('turns CLI capture arguments into the exact declared recipe and stable ID', async () => {
  transport.mockResolvedValueOnce(Response.json(backup));
  const output = await cli([...captureArgs, '--files', 'counter/config.json']);
  expect(transport.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(request));
  expect(output).toHaveBeenCalledWith(backup);
});

it('requires explicit mutation IDs and has no purge or existing-machine restore option', async () => {
  await expect(
    cli(captureArgs.filter((value) => value !== '--id' && value !== backupId)),
  ).rejects.toThrow();
  await expect(
    cli(restoreArgs.filter((value) => value !== '--id' && value !== restoreId)),
  ).rejects.toThrow();
  await expect(cli([...restoreArgs, '--machine', machineId])).rejects.toThrow();
  await expect(cli(['backup', 'purge', backupId])).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
});

it('keeps a lost CLI mutation tied to the caller ID across inspection and explicit replay', async () => {
  transport.mockRejectedValueOnce(new Error('Lost response.'));
  await expect(cli(captureArgs)).rejects.toThrow('Lost response');
  expect(transport).toHaveBeenCalledTimes(1);
  await cli(['backup', 'inspect', backupId]);
  transport.mockResolvedValueOnce(Response.json(backup));
  await cli(captureArgs);
  const posts = transport.mock.calls.filter((call) => call[1]?.method === 'POST');
  expect(posts).toHaveLength(2);
  expect(posts[0]?.[1]?.body).toBe(posts[1]?.[1]?.body);
});

it('creates an isolated restore and exposes its machine and operation in CLI output', async () => {
  const output = await cli(restoreArgs);
  expect(transport.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(restoreRequest));
  expect(output).toHaveBeenCalledWith(restore);
  expect(transport.mock.calls[0]?.[1]?.body).not.toContain(machineId);
});

it('prints list and inspect results and marks blocked CLI waits unsuccessful', async () => {
  expect(await cli(['backup', 'list', machineId])).toHaveBeenCalledWith({
    backups: [backup.backup],
  });
  expect(await cli(['backup', 'restore-inspect', restoreId])).toHaveBeenCalledWith(restore);
  const blocked = {
    restore: { ...restore.restore, state: { kind: 'blocked', reason: 'Budget exhausted.' } },
  };
  transport.mockResolvedValueOnce(Response.json(blocked));
  expect(await cli(['backup', 'restore-wait', restoreId, '--timeout', '1'])).toHaveBeenCalledWith(
    blocked,
  );
  expect(process.exitCode).toBe(1);
  process.exitCode = originalExitCode;
  transport.mockResolvedValueOnce(Response.json(captured));
  expect(await cli(['backup', 'wait', backupId, '--timeout', '1'])).toHaveBeenCalledWith(captured);
});

it('registers backup commands in the actual CLI entry point', async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', 'apps/cli/src/index.ts', 'backup', '--help'],
    { timeout: 10_000, maxBuffer: 65_536 },
  );
  expect(stdout).toContain('capture');
  expect(stdout).toContain('restore-wait');
  expect(stdout).not.toContain('purge');
  expect(stdout).not.toContain(token);
});

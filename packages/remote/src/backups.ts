import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import {
  backupGuestCommandSchema,
  backupGuestReplySchema,
  backupIdSchema,
  CloudError,
  restoreGuestRequestSchema,
  restoreGuestStateSchema,
  restoreIdSchema,
  sameGuestSubject,
  type BackupGuestCommand,
  type GuestSubject,
  type RestoreGuestRequest,
} from '@agent-cloud/contracts';
import { guestName, type ProbeCredential } from '@agent-cloud/pki';
import { withSshFiles } from './ssh-files.js';

type BackupCredential = ProbeCredential<'backup'>;
type BackupTarget = {
  subject: GuestSubject;
  address: string;
  port?: number;
  hostCa: string;
  credential: BackupCredential;
  signal?: AbortSignal;
};

function validateTarget(input: BackupTarget) {
  const address = z
    .string()
    .refine((value) => isIP(value) !== 0)
    .parse(input.address);
  const port = z
    .int()
    .min(1)
    .max(65535)
    .parse(input.port ?? 22);
  if (
    input.subject.kind !== 'allocation' ||
    !sameGuestSubject(input.subject, input.credential.subject) ||
    Date.parse(input.credential.expiresAt) <= Date.now() + 35_000
  )
    throw new CloudError(
      'permission_denied',
      'Backup credential is expired or belongs to another allocation.',
    );
  return { address, port };
}

function transportFailure() {
  return new CloudError(
    'guest_unreachable',
    'Backup transport response is unavailable. Inspect the durable guest operation before continuing.',
    true,
  );
}

async function withBackupSsh<T>(
  input: BackupTarget & { timeoutSeconds: number },
  work: (context: { options: string[]; directory: string; address: string }) => Promise<T>,
) {
  const { address, port } = validateTarget(input);
  return withSshFiles({
    user: 'agent-backup',
    alias: guestName(input.subject),
    port,
    trust: { kind: 'host_ca', publicKey: input.hostCa },
    credential: {
      kind: 'certificate',
      privateKey: input.credential.privateKey,
      certificate: input.credential.certificate,
    },
    work: ({ directory, options }) => work({ directory, options, address }),
  });
}

function startSsh(input: {
  options: string[];
  directory: string;
  address: string;
  action: string;
  timeoutSeconds: number;
  signal: AbortSignal | undefined;
}) {
  const child = spawn(
    '/usr/bin/ssh',
    [...input.options, '-T', input.address, `backup ${input.action}`],
    {
      cwd: input.directory,
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: (input.timeoutSeconds + 10) * 1000,
      killSignal: 'SIGKILL',
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
  let diagnosticBytes = 0;
  child.stderr.on('data', (chunk: Buffer) => {
    diagnosticBytes += chunk.length;
    if (diagnosticBytes > 65_536) child.kill('SIGKILL');
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', () => {
      reject(transportFailure());
    });
    child.once('close', (code) => {
      if (code === 0 && diagnosticBytes <= 65_536) resolve();
      else reject(transportFailure());
    });
  });
  child.stdin.on('error', () => {
    /* The close result owns transport failure without exposing SSH diagnostics. */
  });
  return { child, closed };
}

async function collect(stream: Readable, maximum: number) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of stream) {
    if (!Buffer.isBuffer(value) || (bytes += value.length) > maximum) {
      stream.destroy();
      throw transportFailure();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Capture/inspect/remove use a bounded JSON reply. Read has a separate binary API. */
export async function runBackupCommand(
  input: BackupTarget & {
    command: Exclude<BackupGuestCommand, { kind: 'read' }>;
  },
) {
  const command = backupGuestCommandSchema.parse(input.command);
  if (command.kind === 'read')
    throw new CloudError('invalid_input', 'Use the backup stream transport to read archives.');
  const timeoutSeconds = command.kind === 'capture' ? command.limits.timeoutSeconds : 30;
  return withBackupSsh({ ...input, timeoutSeconds }, async (context) => {
    const { child, closed } = startSsh({
      ...context,
      action: command.kind,
      timeoutSeconds,
      signal: input.signal,
    });
    child.stdin.end(JSON.stringify(command) + '\n');
    try {
      const output = await collect(child.stdout, 1_048_576);
      await closed;
      return backupGuestReplySchema.parse(JSON.parse(output));
    } catch {
      child.kill('SIGKILL');
      await Promise.allSettled([closed]);
      throw transportFailure();
    }
  });
}

/** Keep the owner-only SSH workspace alive until the archive consumer finishes. */
export async function withBackupStream<T>(
  input: BackupTarget & { id: string; maximumBytes: number },
  work: (stream: Readable) => Promise<T>,
): Promise<T> {
  const id = backupIdSchema.parse(input.id);
  const maximum = z.int().positive().max(1_073_741_824).parse(input.maximumBytes);
  return withBackupSsh({ ...input, timeoutSeconds: 900 }, async (context) => {
    const { child, closed } = startSsh({
      ...context,
      action: 'read',
      timeoutSeconds: 900,
      signal: input.signal,
    });
    child.stdin.end(JSON.stringify({ kind: 'read', id }) + '\n');
    let bytes = 0;
    const bounded = child.stdout.pipe(
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          callback(bytes <= maximum ? null : transportFailure(), chunk);
        },
      }),
    );
    try {
      const value = await work(bounded);
      bounded.resume();
      await closed;
      if (bytes < 1) throw transportFailure();
      return value;
    } catch {
      child.kill('SIGKILL');
      bounded.destroy();
      await Promise.allSettled([closed]);
      throw transportFailure();
    }
  });
}

export async function runRestoreCommand(
  input: BackupTarget & {
    request: RestoreGuestRequest;
    archive: Readable;
    beforeSubmit?: () => Promise<void>;
  },
) {
  const request = restoreGuestRequestSchema.parse(input.request);
  return withBackupSsh(
    { ...input, timeoutSeconds: request.limits.timeoutSeconds },
    async (context) => {
      const { child, closed } = startSsh({
        ...context,
        action: 'restore',
        timeoutSeconds: request.limits.timeoutSeconds,
        signal: input.signal,
      });
      let bytes = 0;
      const hash = createHash('sha256');
      const bounded = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          hash.update(chunk);
          callback(bytes <= request.bytes ? null : transportFailure(), chunk);
        },
      });
      const upload = (async () => {
        // Local credential/trust/files/spawn failures happen before the durable remote intent.
        // Once stdin can reach SSH, every lost outcome is conservatively submitted/unknown.
        await once(child, 'spawn');
        await input.beforeSubmit?.();
        child.stdin.write(JSON.stringify(request) + '\n');
        await pipeline(input.archive, bounded, child.stdin);
      })();
      try {
        const [output] = await Promise.all([collect(child.stdout, 1_048_576), closed, upload]);
        if (bytes !== request.bytes || hash.digest('hex') !== request.sha256)
          throw transportFailure();
        return restoreGuestStateSchema.parse(JSON.parse(output));
      } catch {
        child.kill('SIGKILL');
        input.archive.destroy();
        await Promise.allSettled([closed, upload]);
        throw transportFailure();
      }
    },
  );
}

export async function inspectRestore(input: BackupTarget & { id: string }) {
  const id = restoreIdSchema.parse(input.id);
  return withBackupSsh({ ...input, timeoutSeconds: 30 }, async (context) => {
    const { child, closed } = startSsh({
      ...context,
      action: 'inspect-restore',
      timeoutSeconds: 30,
      signal: input.signal,
    });
    child.stdin.end(JSON.stringify({ id }) + '\n');
    try {
      const output = await collect(child.stdout, 1_048_576);
      await closed;
      const value: unknown = JSON.parse(output);
      return value === null ? null : restoreGuestStateSchema.parse(value);
    } catch {
      child.kill('SIGKILL');
      await Promise.allSettled([closed]);
      throw transportFailure();
    }
  });
}

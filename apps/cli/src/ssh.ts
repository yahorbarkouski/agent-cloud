import { constants } from 'node:fs';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocket, createWebSocketStream } from 'ws';
import { z } from 'zod';
import type { Command } from 'commander';
import {
  CloudError,
  machineIdSchema,
  accessGatewaySchema,
  accessTicketSchema,
  customerPublicKeySchema,
  accessSessionIdSchema,
  type MachineId,
} from '@agent-cloud/contracts';
import type { CloudClient } from '@agent-cloud/sdk';

const profileSchema = z.strictObject({ gateway: accessGatewaySchema, ticket: accessTicketSchema });
const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const sshQuote = (text: string) => `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
const sftpQuote = (text: string) => {
  if (/[\r\n\0]/.test(text))
    throw new CloudError('invalid_input', 'File paths cannot contain NUL or newlines.');
  return sshQuote(text);
};

async function proxy(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let profile: z.infer<typeof profileSchema>;
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.size > 16_384 ||
      info.mode & 0o077 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new CloudError(
        'permission_denied',
        'Proxy profile must be an owner-only regular file.',
      );
    profile = profileSchema.parse(JSON.parse(await file.readFile('utf8')));
  } finally {
    await file.close();
  }
  const ws = new WebSocket(`${profile.gateway.origin}/v1/ssh`, {
    headers: { Authorization: `Bearer ${profile.ticket}` },
    followRedirects: false,
    handshakeTimeout: 10_000,
    maxPayload: 65_536,
    perMessageDeflate: false,
  });
  ws.on('message', (_data, binary) => {
    if (!binary) ws.terminate();
  });
  const stream = createWebSocketStream(ws, { highWaterMark: 65_536 });
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = () => {
        reject(new CloudError('guest_unreachable', 'SSH transport closed or authority was lost.'));
      };
      ws.once('error', fail);
      // SSH keeps proxy stdin open while waiting for stdout EOF. Waiting for both
      // duplex halves here delays authority loss until SSH's keepalive timeout.
      ws.once('close', resolve);
      stream.once('error', fail);
      stream.once('close', resolve);
      process.stdin.pipe(stream).pipe(process.stdout, { end: false });
    });
  } finally {
    process.stdin.unpipe(stream);
    process.stdin.pause();
    stream.destroy();
    ws.terminate();
  }
}

async function withCustomerSession<T>(
  client: CloudClient,
  machineId: MachineId,
  work: (options: string[], host: string) => Promise<T>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'acld-access-'));
  const key = join(directory, 'identity');
  const knownHosts = join(directory, 'known_hosts');
  const profilePath = join(directory, 'proxy.json');
  try {
    await promisify(execFile)(
      '/usr/bin/ssh-keygen',
      ['-q', '-t', 'ed25519', '-N', '', '-C', '', '-f', key],
      {
        env: { PATH: '/usr/bin:/bin', LANG: 'C' },
        timeout: 5000,
        maxBuffer: 4096,
      },
    );
    const ticket = `aclt_${randomBytes(32).toString('base64url')}`;
    const request = {
      machineId,
      key: randomUUID(),
      request: {
        publicKey: customerPublicKeySchema.parse((await readFile(key + '.pub', 'utf8')).trim()),
        ticketHash: createHash('sha256').update(ticket).digest('hex'),
      },
    };
    // One retry can recover a lost response, using exactly the same persisted identity and key.
    await writeFile(join(directory, 'request.json'), JSON.stringify(request) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    let accepted;
    try {
      accepted = await client.createAccessSession(request);
    } catch (error) {
      if (error instanceof CloudError && !error.failure.retryable) throw error;
      accepted = await client.createAccessSession(request);
    }
    process.stderr.write(JSON.stringify({ accessSessionId: accepted.session.id }) + '\n');
    const { session } = await client.waitAccessSession(accepted.session.id);
    if (session.issuance.kind !== 'issued')
      throw new CloudError('guest_unreachable', 'SSH certificate was not issued.');
    const host = session.identityPin.hostAlias;
    await writeFile(key + '-cert.pub', session.issuance.certificate + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    await writeFile(knownHosts, `@cert-authority ${host} ${session.identityPin.sshHostCa}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await writeFile(profilePath, JSON.stringify({ gateway: session.gateway, ticket }) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    const entry = join(dirname(fileURLToPath(import.meta.url)), 'index.js');
    const proxyCommand = [
      'exec',
      ...[process.execPath, entry, 'access-proxy', '--profile', profilePath].map(shellQuote),
    ]
      .join(' ')
      .replaceAll('%', '%%');
    const options = ['-F', '/dev/null', '-i', key];
    for (const option of [
      'User=agent-customer',
      'Port=22',
      `HostKeyAlias=${host}`,
      `CertificateFile=${sshQuote(key + '-cert.pub')}`,
      `UserKnownHostsFile=${sshQuote(knownHosts)}`,
      'GlobalKnownHostsFile=/dev/null',
      'HostKeyAlgorithms=ssh-ed25519-cert-v01@openssh.com',
      'StrictHostKeyChecking=yes',
      'UpdateHostKeys=no',
      'BatchMode=yes',
      'IdentitiesOnly=yes',
      'IdentityAgent=none',
      'ForwardAgent=no',
      'ClearAllForwardings=yes',
      'PermitLocalCommand=no',
      `ProxyCommand=${proxyCommand}`,
      'ProxyJump=none',
      'PasswordAuthentication=no',
      'KbdInteractiveAuthentication=no',
      'PreferredAuthentications=publickey',
      'ConnectTimeout=15',
      'ConnectionAttempts=1',
      'ServerAliveInterval=10',
      'ServerAliveCountMax=2',
      'LogLevel=ERROR',
    ])
      options.push('-o', option);
    return await work(options, host);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function native(binary: string, args: string[], stdin?: string) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: [stdin === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
    });
    const interrupted = () => {
      child.kill('SIGTERM');
    };
    process.once('SIGINT', interrupted);
    process.once('SIGTERM', interrupted);
    const remove = () => {
      process.removeListener('SIGINT', interrupted);
      process.removeListener('SIGTERM', interrupted);
    };
    child.once('error', () => {
      remove();
      reject(new CloudError('guest_unreachable', 'Native SSH tool could not start.'));
    });
    child.once('close', (code) => {
      remove();
      resolve(code ?? 1);
    });
    if (stdin !== undefined) {
      child.stdin?.on('error', () => {});
      child.stdin?.end(stdin);
    }
  });
}

export function registerSsh(input: {
  program: Command;
  client: () => Promise<CloudClient>;
  output: (value: unknown) => void;
}) {
  input.program
    .command('access-proxy', { hidden: true })
    .requiredOption('--profile <path>')
    .action(async (raw: unknown) => {
      const { profile } = z.object({ profile: z.string() }).parse(raw);
      await proxy(profile);
    });
  input.program
    .command('ssh <machine> [command...]')
    .description('Open native SSH; use -- before remote command arguments. Streams remote output.')
    .action(async (machine: string, command: string[]) => {
      process.exitCode = await withCustomerSession(
        await input.client(),
        machineIdSchema.parse(machine),
        async (options, host) =>
          native('/usr/bin/ssh', customerSshArguments({ options, host, command })),
      );
    });
  const access = input.program.command('access');
  access.command('inspect <id>').action(async (id: string) => {
    input.output(await (await input.client()).accessSession(accessSessionIdSchema.parse(id)));
  });
  const file = input.program.command('file');
  for (const direction of ['put', 'get'] satisfies Array<'put' | 'get'>) {
    file
      .command(`${direction} <machine> <source> <destination>`)
      .description('Transfer one file through authenticated SFTP.')
      .action(async (machine: string, source: string, destination: string) => {
        const from = direction === 'put' ? resolve(source) : source;
        const to = direction === 'get' ? resolve(destination) : destination;
        const batch = `${direction} ${sftpQuote(from)} ${sftpQuote(to)}\n`;
        process.exitCode = await withCustomerSession(
          await input.client(),
          machineIdSchema.parse(machine),
          async (options, host) => native('/usr/bin/sftp', [...options, '-b', '-', host], batch),
        );
      });
  }
}

/** OpenSSH also parses options after the hostname unless its option boundary is explicit. */
export function customerSshArguments(input: {
  options: string[];
  host: string;
  command: string[];
}) {
  return [...input.options, input.command.length ? '-T' : '-t', '--', input.host, ...input.command];
}

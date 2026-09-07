import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';

async function listening(port: number) {
  for (let count = 0; count < 30; count++) {
    const ready = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: '127.0.0.1', port });
      const finish = (ready: boolean) => {
        socket.destroy();
        resolve(ready);
      };
      socket.setTimeout(500);
      socket.once('connect', () => {
        finish(true);
      });
      socket.once('error', () => {
        finish(false);
      });
      socket.once('timeout', () => {
        finish(false);
      });
    });
    if (ready) return;
    await setTimeout(100);
  }
  throw new Error('Disposable SSH server did not listen.');
}

/** Own exactly one disposable container and key directory, including uncertain docker-run outcomes. */
export async function withSshFixture<T>(
  work: (input: {
    scratch: string;
    fixture: string;
    run: (binary: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
    start: (profile?: 'customer') => Promise<number>;
    installHostCertificate: () => Promise<void>;
  }) => Promise<T>,
) {
  const scratch = await mkdtemp(resolve('.local/ssh-smoke-'));
  const fixture = join(scratch, 'fixture');
  const containerName = `agent-cloud-ssh-${randomUUID()}`;
  const run = async (binary: string, args: string[]) => {
    try {
      return await promisify(execFile)(binary, args, {
        env: { ...process.env, STEPPATH: scratch },
        timeout: 20_000,
        maxBuffer: 32768,
      });
    } catch {
      throw new Error('SSH smoke subprocess failed.');
    }
  };
  async function cleanup() {
    try {
      await promisify(execFile)('docker', ['rm', '-f', containerName], {
        timeout: 20_000,
        maxBuffer: 4096,
      });
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          'stderr' in error &&
          typeof error.stderr === 'string' &&
          error.stderr.includes(`No such container: ${containerName}`)
        )
      )
        throw new Error(`Could not confirm cleanup of SSH fixture ${containerName}.`, {
          cause: error,
        });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  try {
    await mkdir(fixture, { mode: 0o755 });
    return await work({
      scratch,
      fixture,
      run,
      installHostCertificate: async () => {
        await run('docker', [
          'exec',
          containerName,
          '/bin/sh',
          '-ec',
          'cp /fixture/host_key-cert.pub /run/agent-cloud/host_key-cert.pub; chmod 644 /run/agent-cloud/host_key-cert.pub; sed -i "/^HostCertificate /d" /etc/ssh/sshd_config; echo "HostCertificate /run/agent-cloud/host_key-cert.pub" >> /etc/ssh/sshd_config; /usr/sbin/sshd -t; kill -HUP 1',
        ]);
        await setTimeout(100);
      },
      start: async (profile) => {
        await run('docker', [
          'run',
          '--detach',
          '--rm',
          '--name',
          containerName,
          '--label',
          'agent-cloud.test=ssh-proof',
          ...(profile ? ['--env', 'ACLD_SSH_FIXTURE_PROFILE=customer'] : []),
          '--publish',
          '127.0.0.1::2222',
          '--mount',
          `type=bind,source=${fixture},target=/fixture,readonly`,
          '--memory',
          '64m',
          '--cpus',
          '0.25',
          '--security-opt',
          'no-new-privileges:true',
          'agent-cloud-ssh-fixture:development',
        ]);
        const published = (await run('docker', ['port', containerName, '2222/tcp'])).stdout.trim();
        const match = /^127\.0\.0\.1:(\d+)$/.exec(published);
        if (!match?.[1]) throw new Error('Expected a loopback-only SSH port.');
        const port = Number(match[1]);
        await listening(port);
        return port;
      },
    });
  } finally {
    await cleanup();
  }
}

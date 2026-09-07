import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { CloudError, guestImageSchema } from '@agent-cloud/contracts';

export interface SignerConfiguration {
  binary: string;
  caUrl: string;
  tlsRoot: string;
  provisioner: string;
  provisionerPassword: string;
  sshHostCa: string;
  sshUserCa: string;
  keygenBinary?: string;
}
export function createStepTooling(configuration: SignerConfiguration) {
  const binary = resolve(configuration.binary);
  const caUrl = z
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      );
    })
    .parse(configuration.caUrl);
  const root = new X509Certificate(configuration.tlsRoot);
  if (!root.ca) throw new Error('Signing trust must be a CA certificate.');
  const provisioner = z.string().min(1).max(128).parse(configuration.provisioner);
  const password = z.string().min(1).max(16384).parse(configuration.provisionerPassword);
  const hostCa = guestImageSchema.shape.sshHostCa.parse(configuration.sshHostCa);
  const userCa = guestImageSchema.shape.sshUserCa.parse(configuration.sshUserCa);

  async function inWorkspace<T>(input: {
    signal?: AbortSignal;
    work: (
      directory: string,
      run: (args: string[]) => Promise<string>,
      flags: string[],
    ) => Promise<T>;
  }): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), 'agent-cloud-sign-'));
    try {
      const trust = join(directory, 'root.crt');
      const secret = join(directory, 'provisioner-password');
      await writeFile(trust, root.toString(), { flag: 'wx', mode: 0o600 });
      await writeFile(secret, password, { flag: 'wx', mode: 0o600 });
      const flags = [
        '--ca-url',
        caUrl,
        '--root',
        trust,
        '--provisioner',
        provisioner,
        '--provisioner-password-file',
        secret,
      ];
      const run = async (args: string[]) => {
        try {
          const { stdout } = await promisify(execFile)(binary, args, {
            cwd: directory,
            env: { PATH: '/usr/bin:/bin', STEPPATH: directory, LANG: 'C' },
            timeout: 20_000,
            ...(input.signal ? { signal: input.signal } : {}),
            killSignal: 'SIGKILL',
            maxBuffer: 32 * 1024,
          });
          return stdout;
        } catch {
          throw new CloudError('provider_unavailable', 'Certificate tooling failed.', true);
        }
      };
      return await input.work(directory, run, flags);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  return { caUrl, root, hostCa, userCa, inWorkspace };
}

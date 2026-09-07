import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { guestImageSchema, guestProofSchema } from '@agent-cloud/contracts';

type Credential =
  | { kind: 'key'; privateKey: string }
  | { kind: 'certificate'; privateKey: string; certificate: string };
type Trust = { kind: 'pinned_key'; publicKey: string } | { kind: 'host_ca'; publicKey: string };

/** Shared native SSH settings. The caller still owns credential purpose and the allowed command. */
export async function withSshFiles<T>(input: {
  user: string;
  alias: string;
  port: number;
  credential: Credential;
  trust: Trust;
  work: (files: { directory: string; options: string[] }) => Promise<T>;
}) {
  const user = z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,63}$/)
    .parse(input.user);
  const alias = z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,253}$/)
    .parse(input.alias);
  const port = z.int().min(1).max(65535).parse(input.port);
  const publicKey = (
    input.trust.kind === 'host_ca'
      ? guestImageSchema.shape.sshHostCa
      : guestProofSchema.shape.sshHostPublicKey
  ).parse(input.trust.publicKey);
  const directory = await mkdtemp(join(tmpdir(), 'agent-cloud-ssh-'));
  try {
    const key = join(directory, 'identity');
    const hosts = join(directory, 'known_hosts');
    await writeFile(key, input.credential.privateKey, { flag: 'wx', mode: 0o600 });
    await writeFile(
      hosts,
      `${input.trust.kind === 'host_ca' ? '@cert-authority ' : ''}${alias} ${publicKey}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    const quote = (value: string) =>
      '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
    const options = ['-F', '/dev/null', '-i', key];
    if (input.credential.kind === 'certificate') {
      await writeFile(key + '-cert.pub', input.credential.certificate + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      options.push('-o', `CertificateFile=${quote(key + '-cert.pub')}`);
    }
    for (const value of [
      `User=${user}`,
      `Port=${port}`,
      `UserKnownHostsFile=${quote(hosts)}`,
      'GlobalKnownHostsFile=/dev/null',
      `HostKeyAlias=${alias}`,
      `HostKeyAlgorithms=${input.trust.kind === 'host_ca' ? 'ssh-ed25519-cert-v01@openssh.com' : 'ssh-ed25519'}`,
      'StrictHostKeyChecking=yes',
      'UpdateHostKeys=no',
      'BatchMode=yes',
      'IdentitiesOnly=yes',
      'IdentityAgent=none',
      'ForwardAgent=no',
      'ClearAllForwardings=yes',
      'PermitLocalCommand=no',
      'ProxyCommand=none',
      'ProxyJump=none',
      'PasswordAuthentication=no',
      'KbdInteractiveAuthentication=no',
      'PreferredAuthentications=publickey',
      'ConnectTimeout=5',
      'ConnectionAttempts=1',
      'ServerAliveInterval=10',
      'ServerAliveCountMax=3',
      'LogLevel=ERROR',
    ])
      options.push('-o', value);
    return await input.work({ directory, options });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

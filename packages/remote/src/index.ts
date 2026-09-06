import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { CloudError, guestImageSchema, guestProofSchema } from '@agent-cloud/contracts';
import type { AllocationId } from '@agent-cloud/contracts';
import { guestName, type ProbeCredential } from '@agent-cloud/pki';

type GuestTarget = {
  allocationId: AllocationId;
  address: string;
  port?: number;
  trust: { kind: 'pinned_key'; publicKey: string } | { kind: 'host_ca'; publicKey: string };
  credential: ProbeCredential;
};

/** Internal identity proof only. The caller supplies an address from owned provider observations. */
export function createGuestProbe(config: { sshBinary?: string } = {}) {
  const ssh = resolve(config.sshBinary ?? '/usr/bin/ssh');
  async function readIdentity(input: GuestTarget) {
    const alias = guestName(input.allocationId);
    const address = z
      .string()
      .refine((value) => isIP(value) !== 0)
      .parse(input.address);
    const port = z
      .int()
      .min(1)
      .max(65535)
      .parse(input.port ?? 22);
    const trust = (
      input.trust.kind === 'host_ca'
        ? guestImageSchema.shape.sshHostCa
        : guestProofSchema.shape.sshHostPublicKey
    ).parse(input.trust.publicKey);
    const expires = Date.parse(z.iso.datetime().parse(input.credential.expiresAt));
    if (input.credential.allocationId !== input.allocationId || expires <= Date.now() + 5000)
      throw new CloudError(
        'permission_denied',
        'Probe credential is expired or belongs to another allocation.',
      );
    const directory = await mkdtemp(join(tmpdir(), 'agent-cloud-probe-'));
    const run = async (binary: string, args: string[]) => {
      try {
        const { stdout } = await promisify(execFile)(binary, args, {
          cwd: directory,
          env: { PATH: '/usr/bin:/bin', LANG: 'C' },
          timeout: 15_000,
          killSignal: 'SIGKILL',
          maxBuffer: 16 * 1024,
        });
        return stdout;
      } catch {
        throw new CloudError('provider_unavailable', 'Guest SSH identity proof failed.', true);
      }
    };
    try {
      const identity = join(directory, 'probe');
      await writeFile(identity, input.credential.privateKey, { mode: 0o600, flag: 'wx' });
      await writeFile(identity + '-cert.pub', input.credential.certificate + '\n', {
        mode: 0o600,
        flag: 'wx',
      });
      const knownHosts = join(directory, 'known_hosts');
      await writeFile(
        knownHosts,
        `${input.trust.kind === 'host_ca' ? '@cert-authority ' : ''}${alias} ${trust}\n`,
        { mode: 0o600, flag: 'wx' },
      );
      const quote = (path: string) =>
        '"' + path.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
      const args = [
        '-F',
        '/dev/null',
        '-T',
        '-p',
        String(port),
        '-i',
        identity,
        '-o',
        `CertificateFile=${quote(identity + '-cert.pub')}`,
        '-o',
        `UserKnownHostsFile=${quote(knownHosts)}`,
        '-o',
        'GlobalKnownHostsFile=/dev/null',
        '-o',
        `HostKeyAlias=${alias}`,
        '-o',
        `HostKeyAlgorithms=${input.trust.kind === 'host_ca' ? 'ssh-ed25519-cert-v01@openssh.com' : 'ssh-ed25519'}`,
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        'UpdateHostKeys=no',
        '-o',
        'BatchMode=yes',
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'IdentityAgent=none',
        '-o',
        'ForwardAgent=no',
        '-o',
        'ClearAllForwardings=yes',
        '-o',
        'PermitLocalCommand=no',
        '-o',
        'ProxyCommand=none',
        '-o',
        'ProxyJump=none',
        '-o',
        'PasswordAuthentication=no',
        '-o',
        'KbdInteractiveAuthentication=no',
        '-o',
        'ConnectTimeout=5',
        '-o',
        'ConnectionAttempts=1',
        '-o',
        'LogLevel=ERROR',
        '-l',
        'agent-probe',
        address,
        '/usr/local/bin/guestctl identity --json',
      ];
      const output = await run(ssh, args);
      let proof;
      try {
        proof = guestProofSchema.parse(JSON.parse(output));
      } catch {
        throw new CloudError(
          'provider_unavailable',
          'Guest returned invalid identity evidence.',
          true,
        );
      }
      if (
        proof.allocationId !== input.allocationId ||
        (input.trust.kind === 'pinned_key' && proof.sshHostPublicKey !== trust)
      )
        throw new CloudError(
          'provider_unavailable',
          'Guest identity evidence disagrees with the allocation.',
          true,
        );
      return proof;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  return { readIdentity };
}

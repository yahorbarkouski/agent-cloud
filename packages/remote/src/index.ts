import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  CloudError,
  guestImageSchema,
  guestProofSchema,
  guestBootRuntimeSchema,
  guestBootProofSchema,
  guestSubject,
  sameGuestSubject,
} from '@agent-cloud/contracts';
import type { GuestSubject } from '@agent-cloud/contracts';
import { guestName, type ProbeCredential } from '@agent-cloud/pki';
import { withSshFiles } from './ssh-files.js';
export { createImageBuilder } from './image-builder.js';
export { runReferenceCommand } from './reference.js';

type GuestTarget = {
  subject: GuestSubject;
  address: string;
  port?: number;
  trust: { kind: 'pinned_key'; publicKey: string } | { kind: 'host_ca'; publicKey: string };
  credential: ProbeCredential<'probe' | 'runtime'>;
};
type IdentityTarget = Omit<GuestTarget, 'credential'> & { credential: ProbeCredential };
type RuntimeTarget = Omit<GuestTarget, 'credential' | 'trust'> & {
  credential: ProbeCredential<'runtime'>;
  trust: { kind: 'host_ca'; publicKey: string };
};

function readGuestJson(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    throw new CloudError('provider_unavailable', 'Guest returned malformed JSON evidence.', true);
  }
}

/** Internal identity proof only. The caller supplies an address from owned provider observations. */
export function createGuestProbe(config: { sshBinary?: string } = {}) {
  const ssh = resolve(config.sshBinary ?? '/usr/bin/ssh');
  async function read(input: GuestTarget, purpose: 'probe' | 'runtime') {
    if (
      input.credential.kind !== purpose ||
      (purpose === 'runtime' && input.trust.kind !== 'host_ca')
    )
      throw new CloudError(
        'permission_denied',
        'Guest read needs its matching credential purpose and trust.',
      );
    const alias = guestName(input.subject);
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
    if (!sameGuestSubject(input.credential.subject, input.subject) || expires <= Date.now() + 5000)
      throw new CloudError(
        'permission_denied',
        'Probe credential is expired or belongs to another guest subject.',
      );
    return withSshFiles({
      user: 'agent-probe',
      alias,
      port,
      trust: { kind: input.trust.kind, publicKey: trust },
      credential: {
        kind: 'certificate',
        privateKey: input.credential.privateKey,
        certificate: input.credential.certificate,
      },
      work: async ({ directory, options }) => {
        try {
          const { stdout } = await promisify(execFile)(
            ssh,
            [
              ...options,
              '-T',
              address,
              input.credential.kind === 'runtime'
                ? '/usr/bin/sudo -n -- /usr/local/bin/guestctl inspect --json'
                : '/usr/local/bin/guestctl identity --json',
            ],
            {
              cwd: directory,
              env: { PATH: '/usr/bin:/bin', LANG: 'C' },
              timeout: input.credential.kind === 'runtime' ? 30_000 : 15_000,
              killSignal: 'SIGKILL',
              maxBuffer: 32 * 1024,
            },
          );
          return stdout;
        } catch {
          throw new CloudError('provider_unavailable', 'Guest SSH identity proof failed.', true);
        }
      },
    });
  }

  async function readIdentity(input: IdentityTarget) {
    const output = await read(input, 'probe');
    const parsed = guestBootProofSchema.safeParse(readGuestJson(output));
    if (!parsed.success)
      throw new CloudError(
        'provider_unavailable',
        'Guest returned invalid identity evidence.',
        true,
      );
    const proof = parsed.data;
    if (
      !sameGuestSubject(guestSubject(proof), input.subject) ||
      (input.trust.kind === 'pinned_key' && proof.sshHostPublicKey !== input.trust.publicKey)
    )
      throw new CloudError(
        'provider_unavailable',
        'Guest identity evidence disagrees with the guest subject.',
        true,
      );
    return proof;
  }
  async function readRuntime(input: RuntimeTarget) {
    const parsed = guestBootRuntimeSchema.safeParse(readGuestJson(await read(input, 'runtime')));
    if (!parsed.success || !sameGuestSubject(guestSubject(parsed.data.proof), input.subject))
      throw new CloudError(
        'provider_unavailable',
        'Guest returned invalid runtime evidence.',
        true,
      );
    return parsed.data;
  }
  return { readIdentity, readRuntime };
}

export { runHostingCommand } from './hosting.js';

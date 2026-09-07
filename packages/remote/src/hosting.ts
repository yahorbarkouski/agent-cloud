import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import { z } from 'zod';
import {
  CloudError,
  hostingGuestCommandSchema,
  hostingGuestResponseSchema,
  sameGuestSubject,
  type GuestSubject,
  type HostingGuestCommand,
} from '@agent-cloud/contracts';
import { guestName, type ProbeCredential } from '@agent-cloud/pki';
import { withSshFiles } from './ssh-files.js';

/** Fixed root recipe command with JSON on stdin, never shell interpolation or general sudo. */
export async function runHostingCommand(input: {
  subject: GuestSubject;
  address: string;
  port?: number;
  hostCa: string;
  credential: ProbeCredential<'hosting'>;
  command: HostingGuestCommand;
}) {
  const address = z
    .string()
    .refine((value) => isIP(value) !== 0)
    .parse(input.address);
  const command = hostingGuestCommandSchema.parse(input.command);
  if (
    input.subject.kind !== 'allocation' ||
    !sameGuestSubject(input.subject, input.credential.subject) ||
    Date.parse(input.credential.expiresAt) <= Date.now() + 35_000
  )
    throw new CloudError(
      'permission_denied',
      'Hosting credential is expired or belongs to another allocation.',
    );
  return withSshFiles({
    user: 'agent-hosting',
    alias: guestName(input.subject),
    port: input.port ?? 22,
    trust: { kind: 'host_ca', publicKey: input.hostCa },
    credential: {
      kind: 'certificate',
      privateKey: input.credential.privateKey,
      certificate: input.credential.certificate,
    },
    work: async ({ directory, options }) => {
      const output = await new Promise<string>((resolve, reject) => {
        const child = execFile(
          '/usr/bin/ssh',
          [...options, '-T', address, '/usr/bin/sudo -n -- /usr/local/bin/guestctl hosting --json'],
          {
            cwd: directory,
            env: { PATH: '/usr/bin:/bin', LANG: 'C' },
            timeout: 30_000,
            killSignal: 'SIGKILL',
            maxBuffer: 65_536,
          },
          (error, stdout) => {
            if (error)
              reject(
                new CloudError(
                  'guest_unreachable',
                  'Hosting command response unavailable. Inspect before retrying the same route version.',
                  true,
                ),
              );
            else resolve(stdout);
          },
        );
        child.stdin?.on('error', () => {
          /* Completion above reports failed transport without secret stderr. */
        });
        child.stdin?.end(JSON.stringify(command) + '\n');
      });
      try {
        return hostingGuestResponseSchema.parse(JSON.parse(output));
      } catch {
        throw new CloudError(
          'guest_unreachable',
          'Hosting command returned invalid evidence.',
          true,
        );
      }
    },
  });
}

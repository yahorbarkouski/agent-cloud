import { execFile } from 'node:child_process';
import { CloudError, type MachineId } from '@agent-cloud/contracts';
import type { CloudClient } from '@agent-cloud/sdk';
import { withCustomerSession, customerSshArguments } from './ssh.js';

/** Structured helper replies travel inside the same revocable, pinned customer SSH session. */
export async function invokeGuest(input: {
  client: CloudClient;
  machine: MachineId;
  command: 'run' | 'compose' | 'compose-wait';
  request: string;
  app?: string;
}) {
  return withCustomerSession(
    input.client,
    input.machine,
    (options, host) =>
      new Promise<string>((resolve, reject) => {
        const child = execFile(
          '/usr/bin/ssh',
          customerSshArguments({
            options,
            host,
            command: [
              '/usr/bin/sudo',
              '-n',
              '--',
              '/usr/local/bin/guestctl',
              input.command,
              ...(input.app ? [input.app] : []),
              '--json',
            ],
          }),
          {
            timeout: input.command === 'compose-wait' ? 320_000 : 30_000,
            killSignal: 'SIGKILL',
            maxBuffer: 1_048_576,
          },
          (error, stdout) => {
            if (error)
              reject(
                new CloudError(
                  'guest_unreachable',
                  'Guest reply unavailable. Inspect or retry with the same invocation/release ID; do not create a replacement.',
                  true,
                ),
              );
            else resolve(stdout);
          },
        );
        const interrupted = () => {
          child.kill('SIGTERM');
        };
        process.once('SIGINT', interrupted);
        process.once('SIGTERM', interrupted);
        child.once('close', () => {
          process.removeListener('SIGINT', interrupted);
          process.removeListener('SIGTERM', interrupted);
        });
        child.stdin?.on('error', () => {});
        child.stdin?.end(input.request);
      }),
  );
}

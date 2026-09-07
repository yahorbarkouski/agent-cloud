import { guestSubject, sameGuestSubject } from '@agent-cloud/contracts';
import type { Dirent } from 'node:fs';
import { chmod, chown, copyFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { probePrincipal, runtimePrincipal } from '@agent-cloud/pki';
import { atomicWrite, ensureDirectory, isMissing } from './files.js';
import type { EnrollmentSystem } from './enrollment.js';
import { runTool } from './tools.js';
import type { GuestConfiguration } from './identity.js';
import { readOwnedFile } from './files.js';
import { z } from 'zod';
import { consumeImageRecord, validateImageBoot } from './image.js';

/** These paths are owned by the installed image, never supplied by a customer request. */
export function guestSystem(configuration: GuestConfiguration): EnrollmentSystem {
  const run = (binary: string, args: string[]) => runTool(binary, args, configuration.state);
  return {
    prepareIdentity: (spec) => validateImageBoot(configuration, spec),
    prepareSsh: async ({ proof }) => {
      await consumeImageRecord();
      await copyFile('/usr/lib/agent-cloud/sshd_config', '/etc/ssh/sshd_config');
      await chmod('/etc/ssh/sshd_config', 0o644);
      await run('/usr/bin/systemctl', ['disable', '--now', 'ssh.socket']);
      await atomicWrite(
        join(configuration.state, 'proof.json'),
        JSON.stringify(proof) + '\n',
        0o644,
      );
      await atomicWrite(
        join(configuration.state, 'probe-principals'),
        probePrincipal(guestSubject(proof)) + '\n' + runtimePrincipal(guestSubject(proof)) + '\n',
        0o644,
      );
      // Stopping Ubuntu's socket unit may remove its sshd runtime directory.
      await ensureDirectory('/run/sshd', 0o755);
      await run('/usr/sbin/sshd', ['-t']);
      await run('/usr/bin/systemctl', ['enable', 'ssh.service']);
      await run('/usr/bin/systemctl', ['restart', 'ssh.service']);
    },
    activate: async ({ proof, spec }) => {
      await ensureDirectory(join(configuration.state, 'ssh'), 0o755);
      await atomicWrite(
        join(configuration.state, 'ssh', 'certificate.conf'),
        `HostCertificate ${join(configuration.state, 'certificates', 'host-cert.pub')}\n`,
        0o644,
      );
      await run('/usr/sbin/sshd', ['-t']);
      await run('/usr/bin/systemctl', ['restart', 'ssh.service']);
      const proxy = {
        admin: { listen: '127.0.0.1:2019' },
        apps: {
          tls: {
            certificates: {
              load_files: [
                {
                  certificate: join(configuration.state, 'certificates', 'guest.crt'),
                  key: join(configuration.state, 'certificates', 'guest.key'),
                },
              ],
            },
          },
          http: {
            servers: {
              health: {
                listen: ['127.0.0.1:8081'],
                routes: [
                  {
                    match: [{ path: ['/ready'] }],
                    handle: [
                      {
                        handler: 'static_response',
                        body: JSON.stringify({
                          ...(proof.version === 1
                            ? { allocationId: proof.allocationId }
                            : { subject: proof.subject }),
                          imageVersion: proof.imageVersion,
                        }),
                      },
                    ],
                  },
                ],
              },
              guest: {
                listen: [':8443'],
                automatic_https: { disable: true },
                tls_connection_policies: [
                  {
                    client_authentication: {
                      mode: 'require_and_verify',
                      ca: {
                        provider: 'file',
                        pem_files: [join(configuration.state, 'certificates', 'root.crt')],
                      },
                    },
                  },
                ],
                routes: [{ handle: [{ handler: 'static_response', status_code: 404 }] }],
              },
            },
          },
        },
      };
      if (!sameGuestSubject(guestSubject(spec), guestSubject(proof)))
        throw new Error('Guest activation subject disagrees.');
      const gid = z.coerce
        .number()
        .int()
        .nonnegative()
        .parse((await run('/usr/bin/id', ['-g', 'agent-proxy'])).trim());
      await atomicWrite(
        join(configuration.state, 'certificates', 'guest.key'),
        await readOwnedFile(join(configuration.state, 'keys', 'guest.key'), 'private'),
        0o640,
      );
      await chown(join(configuration.state, 'certificates'), 0, gid);
      await chmod(join(configuration.state, 'certificates'), 0o750);
      await chown(join(configuration.state, 'certificates', 'guest.key'), 0, gid);
      await atomicWrite(
        join(configuration.state, 'caddy.json'),
        JSON.stringify(proxy) + '\n',
        0o640,
      );
      await chown(join(configuration.state, 'caddy.json'), 0, gid);
      await run('/usr/local/bin/caddy', [
        'validate',
        '--config',
        join(configuration.state, 'caddy.json'),
      ]);
      await run('/usr/bin/systemctl', ['restart', 'agent-cloud-proxy.service']);
    },
    eraseBootstrap: async () => {
      // Runs after cloud-final.service: it must not rewrite user data after erasure.
      // Disabling subsequent discovery prevents provider metadata from repopulating the caches.
      await atomicWrite('/etc/cloud/cloud-init.disabled', 'Guest enrollment completed.\n', 0o644);
      const instances = '/var/lib/cloud/instances';
      let entries: Dirent[] = [];
      try {
        entries = await readdir(instances, { withFileTypes: true });
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      for (const entry of entries)
        if (entry.isDirectory()) {
          for (const name of [
            'user-data.txt',
            'user-data.txt.i',
            'cloud-config.txt',
            'vendor-data.txt',
            'vendor-data.txt.i',
            'vendor-data2.txt',
            'vendor-data2.txt.i',
            'obj.pkl',
          ])
            await rm(join(instances, entry.name, name), { force: true });
        }
      for (const path of [
        '/run/cloud-init/instance-data-sensitive.json',
        '/run/cloud-init/combined-cloud-config.json',
        '/var/log/cloud-init.log',
        '/var/log/cloud-init-output.log',
      ])
        await rm(path, { force: true });
      await rm('/var/lib/cloud/seed', { recursive: true, force: true });
      // Keep the local retry trigger until every other cache has been removed.
      await rm(join(configuration.state, 'bootstrap.json'), { force: true });
    },
  };
}

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  CloudError,
  imageBuilderBootSchema,
  imageInstallationSchema,
  imageBuildAdmissionSchema,
  imageSanitationReceiptSchema,
  type ImageBuilderBoot,
  type ImageInstallation,
} from '@agent-cloud/contracts';
import { imageInstallCommand, imageTransferCheck, verifyImageInputs } from '@agent-cloud/images';
import { withSshFiles } from './ssh-files.js';

type BuilderTarget = {
  boot: ImageBuilderBoot;
  address: string;
  port?: number;
  hostPublicKey: string;
  managementPrivateKey: string;
};
const stage = '/tmp/agent-cloud-input';
const state = '/var/lib/agent-cloud-builder';
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const shell = (argv: string[]) => argv.map(quote).join(' ');

// The base image supplies every tool used here; uploaded code has not been trusted yet.
const inspectScript = `set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
[ "$(id -u)" = 0 ]
. /etc/os-release
[ "$ID" = ubuntu ]
[ "$VERSION_ID" = 24.04 ]
[ "$(dpkg --print-architecture)" = amd64 ]
cloud-init status --wait >/dev/null
[ ! -L /run/agent-cloud-builder.json ]
printf '%s  /run/agent-cloud-builder.json\\n' "$1" | sha256sum -c - >/dev/null
if [ -e ${state} ] || [ -L ${state} ]; then
  [ ! -L ${state} ]
  [ -d ${state} ]
  [ "$(stat -c %u ${state})" = 0 ]
  [ "$(stat -c %a ${state})" = 700 ]
fi
check_started() {
  [ ! -L ${state}/install-started ]
  [ -f ${state}/install-started ]
  [ "$(stat -c %u ${state}/install-started)" = 0 ]
  [ "$(stat -c %a ${state}/install-started)" = 600 ]
  printf '%s  ${state}/install-started\\n' "$1" | sha256sum -c - >/dev/null
}
installation() {
  if [ -e /usr/lib/agent-cloud/image-build.json ] || [ -L /usr/lib/agent-cloud/image-build.json ]; then
    check_started "$1"
    [ ! -L /usr/lib/agent-cloud/image-build.json ]
    printf '{"kind":"installed","receipt":'
    cat /usr/lib/agent-cloud/image-build.json
    printf '}\\n'
  elif [ -e ${state}/install-started ] || [ -L ${state}/install-started ]; then
    check_started "$1"
    printf '{"kind":"started"}\\n'
  else
    printf '{"kind":"not_started"}\\n'
  fi
}
`;

/** Operator builder transport. The controller must supply a currently owned provider address and serialize the build. */
export function createImageBuilder(
  configuration: { sshBinary?: string; sftpBinary?: string } = {},
) {
  const ssh = resolve(configuration.sshBinary ?? '/usr/bin/ssh');
  const sftp = resolve(configuration.sftpBinary ?? '/usr/bin/sftp');
  async function session<T>(
    input: BuilderTarget,
    work: (session: {
      boot: ImageBuilderBoot;
      inspect: () => Promise<ImageInstallation>;
      run: (script: string, args: string[], timeout: number) => Promise<string>;
      transfer: (directory: string, batch: string, timeout: number) => Promise<void>;
    }) => Promise<T>,
  ) {
    const boot = imageBuilderBootSchema.parse(input.boot);
    const address = z.ipv4().parse(input.address);
    const hostPublicKey = imageBuildAdmissionSchema.shape.access.shape.hostPublicKey.parse(
      input.hostPublicKey,
    );
    const digest = createHash('sha256')
      .update(JSON.stringify(boot) + '\n')
      .digest('hex');
    return withSshFiles({
      user: 'agent-cloud-build',
      alias: `image-build-${boot.buildId}`,
      port: input.port ?? 22,
      credential: { kind: 'key', privateKey: input.managementPrivateKey },
      trust: { kind: 'pinned_key', publicKey: hostPublicKey },
      work: async ({ directory, options }) => {
        const native = async (binary: string, args: string[], cwd: string, timeout: number) => {
          try {
            return (
              await promisify(execFile)(binary, args, {
                cwd,
                env: { PATH: '/usr/bin:/bin', LANG: 'C' },
                timeout,
                killSignal: 'SIGKILL',
                maxBuffer: 32 * 1024,
              })
            ).stdout;
          } catch {
            throw new CloudError(
              'guest_unreachable',
              'Builder SSH operation ended without a valid receipt; inspect its state before retrying.',
              true,
            );
          }
        };
        const run = (script: string, args: string[], timeout: number) =>
          native(
            ssh,
            [
              ...options,
              '-T',
              address,
              shell([
                '/usr/bin/sudo',
                '-n',
                '--',
                '/bin/sh',
                '-c',
                inspectScript + script,
                'image-builder',
                digest,
                ...args,
              ]),
            ],
            directory,
            timeout,
          );
        const inspect = async () => parse(await run('installation "$1"\n', [], 60_000), boot);
        return work({
          boot,
          run,
          inspect,
          transfer: async (source, batch, timeout) => {
            const file = join(directory, 'sftp-batch');
            await writeFile(file, batch, { flag: 'wx', mode: 0o600 });
            await native(sftp, [...options, '-S', ssh, '-b', file, address], source, timeout);
          },
        });
      },
    });
  }
  function parse(output: string, boot: ImageBuilderBoot) {
    let installation;
    try {
      installation = imageInstallationSchema.parse(JSON.parse(output));
    } catch {
      throw new CloudError(
        'guest_unreachable',
        'Builder returned invalid installation evidence.',
        true,
      );
    }
    if (
      installation.kind === 'installed' &&
      (installation.receipt.builderId !== boot.buildId ||
        installation.receipt.manifestDigest !== boot.manifestDigest)
    )
      throw new CloudError(
        'permission_denied',
        'Builder installation receipt belongs to another image intent.',
      );
    return installation;
  }
  const inspect = (input: BuilderTarget) => session(input, (session) => session.inspect());
  function remaining(deadlineAt: string, maximum: number) {
    const duration = Date.parse(z.iso.datetime().parse(deadlineAt)) - Date.now();
    if (duration <= 0)
      throw new CloudError('permission_denied', 'Image build deadline has expired.');
    return Math.min(duration, maximum);
  }
  async function upload(
    input: BuilderTarget & { sourceDirectory: string; checksumDigest: string; deadlineAt: string },
  ) {
    remaining(input.deadlineAt, 300_000);
    const source = resolve(input.sourceDirectory);
    const verified = await verifyImageInputs(source, input.boot.manifestDigest);
    if (verified.checksumDigest !== input.checksumDigest)
      throw new CloudError(
        'invalid_input',
        'Image transfer differs from its admitted checksum digest.',
      );
    return session(input, async (session) => {
      if ((await session.inspect()).kind !== 'not_started')
        throw new CloudError(
          'permission_denied',
          'Do not replace inputs after image installation has started.',
        );
      await session.run(
        `
[ ! -e ${state}/install-started ]
[ ! -L ${state}/install-started ]
rm -rf -- ${stage}
install -d -m 0700 -o agent-cloud-build -g "$(id -g agent-cloud-build)" ${stage} ${stage}/artifacts ${stage}/systemd
`,
        [],
        remaining(input.deadlineAt, 30_000),
      );
      // Local cwd avoids interpreting special characters in the selected directory as SFTP patterns.
      const paths = [
        ...verified.inputs.files.map((file) => file.path),
        'image.json',
        'image-inputs.json',
        'SHA256SUMS',
      ];
      await session.transfer(
        source,
        paths.map((path) => `@put "${path}" "${stage}/${path}"`).join('\n') + '\n',
        remaining(input.deadlineAt, 300_000),
      );
      return {
        kind: 'uploaded',
        manifestDigest: verified.manifestDigest,
        checksumDigest: verified.checksumDigest,
      } satisfies { kind: 'uploaded'; manifestDigest: string; checksumDigest: string };
    });
  }
  async function install(input: BuilderTarget & { checksumDigest: string; deadlineAt: string }) {
    const checksumDigest = imageBuildAdmissionSchema.shape.source.shape.checksumDigest.parse(
      input.checksumDigest,
    );
    return session(input, async (session) => {
      const command = imageInstallCommand({
        directory: stage,
        builderId: session.boot.buildId,
        manifestDigest: session.boot.manifestDigest,
        checksumDigest,
      });
      const output = await session.run(
        `
if [ ! -e ${state}/install-started ] && [ ! -L ${state}/install-started ]; then
  [ ! -e /usr/lib/agent-cloud/image-build.json ]
  (set -- ${quote(stage)} ${quote(checksumDigest)}; ${imageTransferCheck})
  install -d -m 0700 -o root -g root ${state}
  started=$(mktemp ${state}/.install-XXXXXXXX)
  trap 'rm -f -- "$started"' EXIT
  cat /run/agent-cloud-builder.json > "$started"
  if ln -T "$started" ${state}/install-started 2>/dev/null; then
    ${shell(command)}
  fi
fi
installation "$1"
`,
        [],
        remaining(input.deadlineAt, 1_200_000),
      );
      return parse(output, session.boot);
    });
  }
  const sanitize = (input: BuilderTarget & { deadlineAt: string }) =>
    session(input, async (session) => {
      if ((await session.inspect()).kind !== 'installed')
        throw new CloudError(
          'permission_denied',
          'Image sanitation requires its completed installation receipt.',
        );
      const output = await session.run(
        'exec /usr/local/bin/guestctl prepare-image --json\n',
        [],
        remaining(input.deadlineAt, 120_000),
      );
      let receipt;
      try {
        receipt = imageSanitationReceiptSchema.parse(JSON.parse(output));
      } catch {
        throw new CloudError(
          'guest_unreachable',
          'Builder sanitation ended without a valid receipt.',
          true,
        );
      }
      if (
        receipt.builderId !== session.boot.buildId ||
        receipt.manifestDigest !== session.boot.manifestDigest
      )
        throw new CloudError(
          'permission_denied',
          'Builder sanitation receipt belongs to another image intent.',
        );
      return receipt;
    });
  return { inspect, upload, install, sanitize };
}

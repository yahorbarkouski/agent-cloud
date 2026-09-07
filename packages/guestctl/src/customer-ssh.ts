import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  guestSubject,
  imageInputsSchema,
  type GuestBootProof,
  type GuestBootSpec,
  type GuestManifest,
} from '@agent-cloud/contracts';
import { customerSshSudoers, digestInputs } from '@agent-cloud/images';
import { probePrincipal, runtimePrincipal } from '@agent-cloud/pki';
import { atomicWrite, isMissing, readOwnedFile } from './files.js';
import type { GuestConfiguration } from './identity.js';
import { runTool } from './tools.js';

type CustomerSshSystem = {
  read: (path: string) => Promise<string>;
  run: (binary: string, args: string[]) => Promise<string>;
};

export async function publishCustomerPrincipal(state: string, spec: GuestBootSpec) {
  const path = join(state, 'customer-principals');
  if (spec.version === 1 && spec.image.customerSsh === 1)
    await atomicWrite(path, `customer-${spec.allocationId}\n`, 0o644);
  else await rm(path, { force: true });
}

/** Check installed bytes against the signed inventory, then ask SSH and sudo for effective policy. */
export async function verifyCustomerSsh(
  configuration: GuestConfiguration,
  manifest: GuestManifest,
  proof: GuestBootProof,
  system: CustomerSshSystem = {
    read: (path) => readOwnedFile(path, 'public'),
    run: (binary, args) => runTool(binary, args, configuration.state),
  },
) {
  const library = dirname(configuration.manifest);
  const inputs = imageInputsSchema.parse(
    JSON.parse(await system.read(join(library, 'image-inputs.json'))),
  );
  if (digestInputs(inputs) !== manifest.publicInputsDigest)
    throw new Error('Customer SSH inventory does not match the image manifest.');
  for (const [source, installed] of [
    ['sshd_config', join(library, 'sshd_config')],
    ['sshd_config', '/etc/ssh/sshd_config'],
    ['guest-inspect.sudoers', '/etc/sudoers.d/agent-cloud-inspect'],
    ['guest-customer.sudoers', '/etc/sudoers.d/agent-cloud-customer'],
  ] satisfies [string, string][]) {
    const bytes = await system.read(installed);
    const input = inputs.files.find((file) => file.path === source);
    if (
      input?.sha256 !== createHash('sha256').update(bytes).digest('hex') ||
      input.bytes !== Buffer.byteLength(bytes) ||
      (source === 'guest-customer.sudoers' && bytes !== customerSshSudoers)
    )
      throw new Error('Installed customer SSH policy differs from the image inputs.');
  }
  if (
    (await system.read(join(library, 'ssh_user_ca.pub'))).trim() !== manifest.trust.sshUserCa ||
    (await system.read(join(configuration.state, 'ssh', 'certificate.conf'))) !==
      `HostCertificate ${join(configuration.state, 'certificates', 'current', 'host-cert.pub')}\n` ||
    (await system.read(join(configuration.state, 'probe-principals'))) !==
      `${probePrincipal(guestSubject(proof))}\n${runtimePrincipal(guestSubject(proof))}\n`
  )
    throw new Error('Guest SSH trust or probe principals differ from the guest identity.');
  const principals = join(configuration.state, 'customer-principals');
  if (proof.version === 1) {
    if ((await system.read(principals)) !== `customer-${proof.allocationId}\n`)
      throw new Error('Customer SSH principal differs from the allocation.');
  } else {
    try {
      await system.read(principals);
    } catch (error) {
      if (!isMissing(error)) throw error;
      await verifyPolicy();
      return;
    }
    throw new Error('Image verifiers must not have customer SSH principals.');
  }
  await verifyPolicy();

  async function verifyPolicy() {
    for (const user of ['agent-customer', 'agent-probe']) {
      const entries = (
        await system.run('/usr/sbin/sshd', [
          '-T',
          '-f',
          '/etc/ssh/sshd_config',
          '-C',
          `user=${user},host=localhost,addr=127.0.0.1`,
        ])
      )
        .trim()
        .split('\n')
        .map((line) => {
          const separator = line.indexOf(' ');
          return [line.slice(0, separator), line.slice(separator + 1).trimEnd()] satisfies [
            string,
            string,
          ];
        });
      const effective = new Map(entries);
      const allowedUsers = entries.flatMap(([key, value]) =>
        key === 'allowusers' ? value.split(/\s+/) : [],
      );
      const expected = {
        authenticationmethods: 'publickey',
        pubkeyauthentication: 'yes',
        authorizedkeysfile: 'none',
        authorizedkeyscommand: 'none',
        authorizedprincipalscommand: 'none',
        trustedusercakeys: join(library, 'ssh_user_ca.pub'),
        hostcertificate: join(configuration.state, 'certificates', 'current', 'host-cert.pub'),
        authorizedprincipalsfile: join(
          configuration.state,
          user === 'agent-customer' ? 'customer-principals' : 'probe-principals',
        ),
        passwordauthentication: 'no',
        kbdinteractiveauthentication: 'no',
        hostbasedauthentication: 'no',
        permitemptypasswords: 'no',
        permitrootlogin: 'no',
        allowagentforwarding: 'no',
        allowtcpforwarding: 'no',
        allowstreamlocalforwarding: 'no',
        x11forwarding: 'no',
        permittunnel: 'no',
        permituserenvironment: 'no',
        permituserrc: 'no',
        permittty: user === 'agent-customer' ? 'yes' : 'no',
        forcecommand: 'none',
        subsystem: 'sftp internal-sftp',
      };
      if (
        Object.entries(expected).some(([key, value]) => effective.get(key) !== value) ||
        allowedUsers.sort().join(' ') !== 'agent-customer agent-deploy agent-hosting agent-probe'
      )
        throw new Error('Effective guest SSH policy does not support isolated customer access.');
    }
    const account = (await system.run('/usr/bin/getent', ['passwd', 'agent-customer']))
      .trim()
      .split(':');
    if (
      account.length !== 7 ||
      account[0] !== 'agent-customer' ||
      !/^[1-9][0-9]*$/.test(account[2] ?? '') ||
      account[5] !== '/var/lib/agent-customer' ||
      account[6] !== '/bin/sh'
    )
      throw new Error('Customer SSH account is not installed correctly.');
    if ((await system.run('/usr/bin/id', ['-Gn', 'agent-probe'])).trim() !== 'agent-probe')
      throw new Error('The guest probe must not have supplementary groups.');
    if (
      (
        await system.run('/usr/sbin/runuser', [
          '-u',
          'agent-customer',
          '--',
          '/usr/bin/sudo',
          '-n',
          '--',
          '/usr/bin/id',
          '-u',
        ])
      ).trim() !== '0'
    )
      throw new Error('Customer SSH account does not have passwordless sudo.');
    try {
      await system.run('/usr/sbin/runuser', [
        '-u',
        'agent-probe',
        '--',
        '/usr/bin/sudo',
        '-n',
        '--',
        '/usr/bin/id',
        '-u',
      ]);
    } catch {
      return;
    }
    throw new Error('The guest probe must not have general sudo access.');
  }
}

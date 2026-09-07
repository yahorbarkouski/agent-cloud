import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  bootstrapSpecSchema,
  guestProofSchema,
  imageVerifierProofSchema,
  imageVerifierSpecSchema,
  newId,
} from '../packages/contracts/dist/index.js';
import { createImageManifest, digestManifest } from '../packages/images/dist/index.js';
import { backupPrincipal, probePrincipal, runtimePrincipal } from '../packages/pki/dist/index.js';
import {
  publishCustomerPrincipal,
  verifyCustomerSsh,
} from '../packages/guestctl/src/customer-ssh.js';
import { imageFixture } from './image-fixture.js';

const configuration = {
  state: '/var/lib/agent-cloud',
  manifest: '/usr/lib/agent-cloud/image.json',
  binary: '/usr/lib/agent-cloud/guestctl.mjs',
  step: '/usr/local/bin/step',
  keygen: '/usr/bin/ssh-keygen',
};

async function fixture() {
  const image = imageFixture(undefined, 1);
  for (const path of [
    'sshd_config',
    'guest-inspect.sudoers',
    'guest-customer.sudoers',
    'guest-backup.sudoers',
  ])
    image.files.set(path, await readFile(join('images', path), 'utf8'));
  const inputs = {
    ...image.inputs,
    files: image.inputs.files.map((file) => {
      const bytes = image.files.get(file.path);
      if (bytes === undefined) throw new Error('Missing fixture input.');
      return {
        ...file,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: Buffer.byteLength(bytes),
      };
    }),
  };
  const manifest = createImageManifest({ ...image, inputs });
  const proof = guestProofSchema.parse({
    version: 1,
    allocationId: newId.allocation(),
    imageVersion: manifest.version,
    manifestDigest: digestManifest(manifest),
    sshHostPublicKey: 'ssh-ed25519 AAAA',
    tlsCsr: 'fixture-csr',
  });
  const subject = { kind: 'allocation', id: proof.allocationId } satisfies Parameters<
    typeof probePrincipal
  >[0];
  const files = new Map([
    ['/usr/lib/agent-cloud/image-inputs.json', JSON.stringify(inputs)],
    ['/usr/lib/agent-cloud/ssh_user_ca.pub', manifest.trust.sshUserCa],
    [
      '/var/lib/agent-cloud/ssh/certificate.conf',
      'HostCertificate /var/lib/agent-cloud/certificates/current/host-cert.pub\n',
    ],
    ['/var/lib/agent-cloud/customer-principals', `customer-${proof.allocationId}\n`],
    ['/var/lib/agent-cloud/backup-principals', `${backupPrincipal(subject)}\n`],
    [
      '/var/lib/agent-cloud/probe-principals',
      `${probePrincipal(subject)}\n${runtimePrincipal(subject)}\n`,
    ],
  ]);
  for (const [source, destinations] of [
    ['sshd_config', ['/usr/lib/agent-cloud/sshd_config', '/etc/ssh/sshd_config']],
    ['guest-inspect.sudoers', ['/etc/sudoers.d/agent-cloud-inspect']],
    ['guest-customer.sudoers', ['/etc/sudoers.d/agent-cloud-customer']],
    ['guest-backup.sudoers', ['/etc/sudoers.d/agent-cloud-backup']],
  ] satisfies [string, string[]][]) {
    const content = image.files.get(source);
    if (content === undefined) throw new Error('Missing policy fixture.');
    for (const path of destinations) files.set(path, content);
  }
  const effective = new Map<string, string>();
  for (const user of ['agent-customer', 'agent-probe', 'agent-backup'])
    effective.set(
      user,
      `authenticationmethods publickey
pubkeyauthentication yes
authorizedkeysfile none
authorizedkeyscommand none
authorizedprincipalscommand none
trustedusercakeys /usr/lib/agent-cloud/ssh_user_ca.pub
hostcertificate /var/lib/agent-cloud/certificates/current/host-cert.pub
authorizedprincipalsfile /var/lib/agent-cloud/${user === 'agent-customer' ? 'customer' : user === 'agent-backup' ? 'backup' : 'probe'}-principals
passwordauthentication no
kbdinteractiveauthentication no
hostbasedauthentication no
permitemptypasswords no
permitrootlogin no
allowagentforwarding no
allowtcpforwarding no
allowstreamlocalforwarding no
x11forwarding no
permittunnel no
permituserenvironment no
permituserrc no
permittty ${user === 'agent-customer' ? 'yes' : 'no'}
forcecommand none
subsystem sftp internal-sftp
allowusers agent-probe agent-deploy agent-customer agent-hosting agent-backup
`,
    );
  const system = {
    read: (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw Object.assign(new Error('Missing'), { code: 'ENOENT' });
      return Promise.resolve(value);
    },
    run: (binary: string, args: string[]) => {
      if (binary === '/usr/sbin/sshd') {
        expect(args.slice(0, 4)).toEqual(['-T', '-f', '/etc/ssh/sshd_config', '-C']);
        const user = args[4]?.split(',')[0]?.slice(5);
        const value = user && effective.get(user);
        if (!value) throw new Error('Unknown SSH user.');
        return Promise.resolve(value);
      }
      if (binary === '/usr/bin/getent')
        return Promise.resolve('agent-customer:x:997:997::/var/lib/agent-customer:/bin/sh\n');
      if (binary === '/usr/bin/id') return Promise.resolve('agent-probe\n');
      if (binary === '/usr/sbin/runuser') {
        expect(args.slice(2)).toEqual(['--', '/usr/bin/sudo', '-n', '--', '/usr/bin/id', '-u']);
        if (args[1] === 'agent-customer') return Promise.resolve('0\n');
        throw new Error('Probe cannot run arbitrary commands as root.');
      }
      throw new Error('Unexpected system command.');
    },
  };
  return { manifest, proof, system, files, effective };
}

it('verifies authenticated installed policy, native settings, principal isolation and sudo', async () => {
  const guest = await fixture();
  await verifyCustomerSsh(configuration, guest.manifest, guest.proof, guest.system);
});

it('accepts native Ubuntu sshd formatting and rejects an extra user', async () => {
  const guest = await fixture();
  for (const [user, policy] of guest.effective)
    guest.effective.set(
      user,
      policy
        .replace('subsystem sftp internal-sftp\n', 'subsystem sftp internal-sftp \n')
        .replace(
          'allowusers agent-probe agent-deploy agent-customer agent-hosting agent-backup',
          'allowusers agent-probe\nallowusers agent-deploy\nallowusers agent-customer\nallowusers agent-hosting\nallowusers agent-backup',
        ),
    );
  await verifyCustomerSsh(configuration, guest.manifest, guest.proof, guest.system);
  for (const [user, policy] of guest.effective)
    guest.effective.set(user, policy + 'allowusers unexpected-user\n');
  await expect(
    verifyCustomerSsh(configuration, guest.manifest, guest.proof, guest.system),
  ).rejects.toThrow('Effective');
});

it.each([
  '/usr/lib/agent-cloud/image-inputs.json',
  '/usr/lib/agent-cloud/sshd_config',
  '/etc/ssh/sshd_config',
  '/etc/sudoers.d/agent-cloud-inspect',
  '/etc/sudoers.d/agent-cloud-customer',
  '/etc/sudoers.d/agent-cloud-backup',
  '/usr/lib/agent-cloud/ssh_user_ca.pub',
  '/var/lib/agent-cloud/ssh/certificate.conf',
  '/var/lib/agent-cloud/probe-principals',
  '/var/lib/agent-cloud/customer-principals',
  '/var/lib/agent-cloud/backup-principals',
])('rejects changed installed %s', async (path) => {
  const guest = await fixture();
  guest.files.set(path, 'changed');
  await expect(
    verifyCustomerSsh(configuration, guest.manifest, guest.proof, guest.system),
  ).rejects.toThrow();
});

it.each([
  ['agent-customer', 'permittty yes', 'permittty no'],
  ['agent-customer', 'permituserrc no', 'permituserrc yes'],
  ['agent-customer', 'passwordauthentication no', 'passwordauthentication yes'],
  ['agent-customer', 'allowtcpforwarding no', 'allowtcpforwarding yes'],
  ['agent-customer', 'allowstreamlocalforwarding no', 'allowstreamlocalforwarding yes'],
  ['agent-customer', 'forcecommand none', 'forcecommand /bin/false'],
  ['agent-customer', 'subsystem sftp internal-sftp', 'subsystem sftp /bin/false'],
  ['agent-probe', 'permittty no', 'permittty yes'],
  ['agent-probe', 'probe-principals', 'customer-principals'],
  ['agent-backup', 'backup-principals', 'customer-principals'],
])('rejects effective %s policy changed from %s', async (user, before, after) => {
  const guest = await fixture();
  const effective = guest.effective.get(user);
  if (!effective) throw new Error('Missing effective policy.');
  guest.effective.set(user, effective.replace(before, after));
  await expect(
    verifyCustomerSsh(configuration, guest.manifest, guest.proof, guest.system),
  ).rejects.toThrow('Effective');
});

it('verifies image capability without ever authorizing a verifier as a customer', async () => {
  const guest = await fixture();
  const proof = imageVerifierProofSchema.parse({
    imageVersion: guest.proof.imageVersion,
    manifestDigest: guest.proof.manifestDigest,
    sshHostPublicKey: guest.proof.sshHostPublicKey,
    tlsCsr: guest.proof.tlsCsr,
    version: 2,
    subject: { kind: 'image_verifier', id: randomUUID() },
  });
  guest.files.set(
    '/var/lib/agent-cloud/probe-principals',
    `${probePrincipal(proof.subject)}\n${runtimePrincipal(proof.subject)}\n`,
  );
  guest.files.set('/var/lib/agent-cloud/backup-principals', '');
  await expect(
    verifyCustomerSsh(configuration, guest.manifest, proof, guest.system),
  ).rejects.toThrow('must not have customer');
  guest.files.delete('/var/lib/agent-cloud/customer-principals');
  await verifyCustomerSsh(configuration, guest.manifest, proof, guest.system);
});

it('rejects a customer without sudo and a probe with general sudo', async () => {
  const guest = await fixture();
  const run = guest.system.run;
  guest.system.run = (binary, args) =>
    binary === '/usr/sbin/runuser' ? Promise.resolve('997\n') : run(binary, args);
  await expect(
    verifyCustomerSsh(configuration, guest.manifest, guest.proof, guest.system),
  ).rejects.toThrow('passwordless sudo');
  guest.system.run = (binary, args) =>
    binary === '/usr/sbin/runuser' ? Promise.resolve('0\n') : run(binary, args);
  await expect(
    verifyCustomerSsh(configuration, guest.manifest, guest.proof, guest.system),
  ).rejects.toThrow('probe must not');
});

it('publishes an allocation principal with protected permissions and removes it for old images or verifiers', async () => {
  const guest = await fixture();
  const state = await mkdtemp(join(tmpdir(), 'agent-cloud-customer-principal-'));
  try {
    const spec = bootstrapSpecSchema.parse({
      version: 1,
      accountId: newId.account(),
      machineId: newId.machine(),
      allocationId: guest.proof.allocationId,
      operationId: newId.operation(),
      expiresAt: new Date().toISOString(),
      enrollmentUrl: 'https://enroll.example.test',
      image: {
        providerImage: '123',
        architecture: guest.manifest.architecture,
        version: guest.manifest.version,
        manifestDigest: guest.proof.manifestDigest,
        ...guest.manifest.trust,
        customerSsh: 1,
      },
    });
    const path = join(state, 'customer-principals');
    await publishCustomerPrincipal(state, spec);
    expect(await readFile(path, 'utf8')).toBe(`customer-${spec.allocationId}\n`);
    expect((await stat(path)).mode & 0o777).toBe(0o644);
    await publishCustomerPrincipal(state, {
      ...spec,
      image: { ...spec.image, customerSsh: undefined },
    });
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await publishCustomerPrincipal(state, spec);
    const verifier = imageVerifierSpecSchema.parse({
      version: 2,
      subject: { kind: 'image_verifier', id: randomUUID() },
      image: spec.image,
      expiresAt: spec.expiresAt,
      enrollmentUrl: spec.enrollmentUrl,
    });
    await publishCustomerPrincipal(state, verifier);
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

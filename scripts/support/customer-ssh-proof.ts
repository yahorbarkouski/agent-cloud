import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { newId, type AccessSessionRecord } from '../../packages/contracts/src/index.js';
import {
  createSigner,
  guestName,
  probePrincipal,
  type SignerConfiguration,
} from '../../packages/pki/src/index.js';
import { createCustomerSshSigner } from '../../packages/pki/src/customer-ssh.js';
import { withSshFixture } from './ssh-fixture.js';

export async function checkCustomerSshProof(input: {
  configuration: SignerConfiguration;
  session: AccessSessionRecord;
}) {
  const { configuration } = input;
  await withSshFixture(async ({ scratch, fixture, run, start }) => {
    const existing = createSigner(configuration);
    const customer = createCustomerSshSigner(configuration);
    const subject = { kind: 'allocation', id: input.session.allocationId } satisfies Parameters<
      typeof guestName
    >[0];
    const hostAlias = guestName(subject);
    const clientKey = join(scratch, 'customer');
    const wrongKey = join(scratch, 'wrong');
    for (const path of [clientKey, wrongKey, join(fixture, 'host_key')]) {
      await run('/usr/bin/ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', '', '-f', path]);
    }
    const hostKey = (await readFile(join(fixture, 'host_key.pub'), 'utf8')).trim();
    await writeFile(
      join(fixture, 'host_key-cert.pub'),
      (await existing.signHost({ subject, publicKey: hostKey })) + '\n',
      { mode: 0o644 },
    );
    await writeFile(join(fixture, 'user_ca.pub'), configuration.sshUserCa + '\n', { mode: 0o644 });
    await writeFile(join(fixture, 'principals'), probePrincipal(subject) + '\n', { mode: 0o644 });
    await writeFile(join(fixture, 'customer-principals'), `customer-${subject.id}\n`, {
      mode: 0o644,
    });
    await writeFile(join(fixture, 'proof.json'), JSON.stringify({ forcedProbe: true }), {
      mode: 0o644,
    });
    const publicKey = (await readFile(clientKey + '.pub', 'utf8')).trim();
    // Host-to-container NAT varies by Docker platform. Only this disposable fixture admits private ranges.
    const sources = ['127.0.0.1/32', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];
    async function issue(egressCidrs: string[], allocationId = subject.id) {
      const now = Date.now();
      const session = {
        ...input.session,
        id: newId.accessSession(),
        publicKey,
        allocationId,
        identityPin: {
          ...input.session.identityPin,
          hostAlias: guestName({ kind: 'allocation', id: allocationId }),
        },
        gateway: { ...input.session.gateway, egressCidrs },
        admittedAt: new Date(now - 2000).toISOString(),
        issueDeadline: new Date(now + 88_000).toISOString(),
        hardDeadline: new Date(now + 3_598_000).toISOString(),
        issuance: { kind: 'attempted', attemptedAt: new Date(now - 1000).toISOString() },
      } satisfies AccessSessionRecord;
      const result = await customer.sign({
        session,
        authority: { checkedAt: new Date(now), expiresAt: new Date(now + 3_598_000) },
        signal: AbortSignal.timeout(20_000),
      });
      assert.equal(result.kind, 'issued');
      const path = join(scratch, session.id + '-cert.pub');
      await writeFile(path, result.certificate + '\n', { mode: 0o600 });
      return path;
    }
    const certificate = await issue(sources);
    const encoded = (await readFile(certificate, 'utf8')).trim().split(' ')[1];
    if (!encoded) throw new Error('Expected a signed SSH certificate.');
    const wire = Buffer.from(encoded, 'base64');
    const lastByte = wire.at(-1);
    if (lastByte === undefined) throw new Error('Expected a certificate signature.');
    wire[wire.length - 1] = lastByte ^ 1;
    const invalidSignature = join(scratch, 'invalid-signature-cert.pub');
    await writeFile(
      invalidSignature,
      `ssh-ed25519-cert-v01@openssh.com ${wire.toString('base64')}\n`,
      { mode: 0o600 },
    );
    const deniedSource = await issue(['203.0.113.77/32']);
    const foreign = await issue(sources, newId.allocation());
    const knownHosts = join(scratch, 'known_hosts');
    await writeFile(knownHosts, `@cert-authority ${hostAlias} ${configuration.sshHostCa}\n`, {
      mode: 0o600,
    });
    const port = await start('customer');
    const ssh = (
      options: {
        certificate?: string;
        key?: string;
        user?: string;
        pty?: boolean;
        forward?: boolean;
      } = {},
    ) =>
      run('/usr/bin/ssh', [
        '-F',
        '/dev/null',
        '-o',
        'GlobalKnownHostsFile=/dev/null',
        '-o',
        `UserKnownHostsFile=${knownHosts}`,
        '-o',
        `HostKeyAlias=${hostAlias}`,
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'IdentityAgent=none',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        `CertificateFile=${options.certificate ?? certificate}`,
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=5',
        '-o',
        'PasswordAuthentication=no',
        '-o',
        'PreferredAuthentications=publickey',
        '-o',
        'UpdateHostKeys=no',
        '-o',
        'PermitLocalCommand=no',
        '-p',
        String(port),
        '-i',
        options.key ?? clientKey,
        ...(options.pty ? ['-tt'] : ['-T']),
        ...(options.forward ? ['-W', '127.0.0.1:2222'] : []),
        `${options.user ?? 'agent-customer'}@127.0.0.1`,
        ...(options.forward ? [] : [options.pty ? 'test -t 0 && echo customer-pty' : 'id -un']),
      ]);
    assert.equal((await ssh()).stdout.trim(), 'agent-customer');
    assert.equal((await ssh({ pty: true })).stdout.trim(), 'customer-pty');
    await assert.rejects(ssh({ key: wrongKey }));
    await assert.rejects(ssh({ certificate: invalidSignature }));
    await assert.rejects(ssh({ user: 'agent-probe' }));
    await assert.rejects(ssh({ certificate: deniedSource }));
    await assert.rejects(ssh({ certificate: foreign }));
    await assert.rejects(ssh({ forward: true }));
    await writeFile(knownHosts, `@cert-authority ${hostAlias} ${publicKey}\n`, { mode: 0o600 });
    await assert.rejects(ssh());
    await writeFile(knownHosts, `@cert-authority ${hostAlias} ${configuration.sshHostCa}\n`, {
      mode: 0o600,
    });
    assert.equal((await ssh()).stdout.trim(), 'agent-customer');
    const probe = await existing.issueProbeCredential(subject);
    const probeKey = join(scratch, 'probe');
    const probeCert = join(scratch, 'probe-cert.pub');
    await writeFile(probeKey, probe.privateKey, { mode: 0o600 });
    await writeFile(probeCert, probe.certificate + '\n', { mode: 0o600 });
    assert.deepEqual(
      JSON.parse(
        (await ssh({ user: 'agent-probe', key: probeKey, certificate: probeCert })).stdout,
      ),
      { forcedProbe: true },
    );
    process.stdout.write(
      JSON.stringify({
        nativeCustomerSsh: 'command and PTY authenticated using the signed certificate',
        rejected: [
          'invalid signature',
          'wrong key',
          'wrong user',
          'wrong source',
          'foreign allocation',
          'port forwarding',
          'wrong host CA',
        ],
        probeForcedCommand: 'preserved on the same server',
        boundary: 'local OpenSSH fixture, not a published access-capable image',
      }) + '\n',
    );
  });
}

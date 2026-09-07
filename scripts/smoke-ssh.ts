import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  guestSubject,
  imageBuildIdSchema,
  newId,
  guestBootProofSchema,
} from '../packages/contracts/dist/index.js';
import { createSigner, guestName, probePrincipal } from '../packages/pki/dist/index.js';
import { createGuestProbe } from '../packages/remote/dist/index.js';
import { readPrivateFile } from '../apps/control/src/private-file.js';

import { withSshFixture } from './support/ssh-fixture.js';

const step = resolve('.local/tools/step-0.30.6');
const subjects = [
  guestSubject({ version: 1, allocationId: newId.allocation() }),
  guestSubject({
    version: 2,
    subject: { kind: 'image_verifier', id: imageBuildIdSchema.parse(randomUUID()) },
  }),
];
for (const subject of subjects) {
  await withSshFixture(async ({ scratch, fixture, run, start }) => {
    const signer = createSigner({
      binary: step,
      caUrl: 'https://localhost:9449',
      tlsRoot: await readFile(resolve('.local/pki/public/root_ca.crt'), 'utf8'),
      sshHostCa: (await readFile(resolve('.local/pki/public/ssh_host_ca_key.pub'), 'utf8')).trim(),
      sshUserCa: (await readFile(resolve('.local/pki/public/ssh_user_ca_key.pub'), 'utf8')).trim(),
      provisioner: 'agent-cloud-control',
      provisionerPassword: await readPrivateFile(resolve('.local/pki/provisioner-password')),
    });
    const name = guestName(subject);
    await run('/usr/bin/ssh-keygen', [
      '-t',
      'ed25519',
      '-N',
      '',
      '-C',
      '',
      '-f',
      join(fixture, 'host_key'),
    ]);
    const publicKey = (await readFile(join(fixture, 'host_key.pub'), 'utf8')).trim();
    await writeFile(
      join(fixture, 'host_key-cert.pub'),
      (await signer.signHost({ subject, publicKey })) + '\n',
      { mode: 0o644 },
    );
    await writeFile(
      join(fixture, 'user_ca.pub'),
      await readFile(resolve('.local/pki/public/ssh_user_ca_key.pub')),
      { mode: 0o644 },
    );
    await writeFile(join(fixture, 'principals'), probePrincipal(subject) + '\n', {
      mode: 0o644,
    });
    await run(step, [
      'certificate',
      'create',
      name,
      join(scratch, 'guest.csr'),
      join(scratch, 'guest.key'),
      '--csr',
      '--kty',
      'EC',
      '--curve',
      'P-256',
      '--no-password',
      '--insecure',
      '--san',
      name,
    ]);
    const proof = guestBootProofSchema.parse({
      ...(subject.kind === 'allocation'
        ? { version: 1, allocationId: subject.id }
        : { version: 2, subject }),
      imageVersion: 'fixture-v1',
      manifestDigest: 'a'.repeat(64),
      sshHostPublicKey: publicKey,
      tlsCsr: await readFile(join(scratch, 'guest.csr'), 'utf8'),
    });
    await writeFile(join(fixture, 'proof.json'), JSON.stringify(proof) + '\n', { mode: 0o644 });
    const port = await start();
    const probe = createGuestProbe();
    const target = {
      subject,
      address: '127.0.0.1',
      port,
      credential: await signer.issueProbeCredential(subject),
    };
    assert.deepEqual(
      await probe.readIdentity({ ...target, trust: { kind: 'pinned_key', publicKey } }),
      proof,
    );
    const hostCa = (
      await readFile(resolve('.local/pki/public/ssh_host_ca_key.pub'), 'utf8')
    ).trim();
    assert.deepEqual(
      await probe.readIdentity({ ...target, trust: { kind: 'host_ca', publicKey: hostCa } }),
      proof,
    );
    await run('/usr/bin/ssh-keygen', [
      '-t',
      'ed25519',
      '-N',
      '',
      '-C',
      '',
      '-f',
      join(scratch, 'wrong_key'),
    ]);
    const wrongKey = (await readFile(join(scratch, 'wrong_key.pub'), 'utf8')).trim();
    await assert.rejects(
      probe.readIdentity({ ...target, trust: { kind: 'pinned_key', publicKey: wrongKey } }),
      /SSH identity proof failed/,
    );
    await assert.rejects(
      probe.readIdentity({ ...target, trust: { kind: 'host_ca', publicKey: wrongKey } }),
      /SSH identity proof failed/,
    );
    const foreign = newId.allocation();
    await assert.rejects(
      probe.readIdentity({
        ...target,
        subject: { kind: 'allocation', id: foreign },
        credential: await signer.issueProbeCredential({ kind: 'allocation', id: foreign }),
        trust: { kind: 'pinned_key', publicKey },
      }),
      /SSH identity proof failed/,
    );
    await writeFile(
      join(fixture, 'proof.json'),
      JSON.stringify(
        proof.version === 1
          ? { ...proof, allocationId: newId.allocation() }
          : {
              ...proof,
              subject: { kind: 'image_verifier', id: imageBuildIdSchema.parse(randomUUID()) },
            },
      ),
      { mode: 0o644 },
    );
    await assert.rejects(
      probe.readIdentity({ ...target, trust: { kind: 'pinned_key', publicKey } }),
      /disagrees with the guest subject/,
    );
    process.stdout.write(
      JSON.stringify({
        ok: true,
        subject: subject.kind,
        pinnedHostKey: 'verified connection',
        hostCa: 'verified connection',
        wrongHostKey: 'rejected',
        wrongHostCa: 'rejected',
        foreignAllocationCertificate: 'rejected',
        wrongGuestEvidence: 'rejected',
        cloudResourcesCreated: 0,
      }) + '\n',
    );
  });
}

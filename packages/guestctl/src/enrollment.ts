import { join } from 'node:path';
import { currentCertificates, pruneCertificates } from './certificates.js';
import {
  guestBootSpecSchema,
  issuedGuestIdentitySchema,
  type GuestBootSpec,
  type GuestBootProof,
  type IssuedGuestIdentity,
} from '@agent-cloud/contracts';
import { atomicWrite, readOwnedFile } from './files.js';
import {
  ensureIdentity,
  installIdentity,
  loadBootstrap,
  verifyImage,
  type GuestConfiguration,
} from './identity.js';

export type EnrollmentSystem = {
  prepareIdentity: (spec: GuestBootSpec) => Promise<void>;
  prepareSsh: (input: { proof: GuestBootProof; spec: GuestBootSpec }) => Promise<void>;
  activate: (input: {
    proof: GuestBootProof;
    spec: GuestBootSpec;
    identity: IssuedGuestIdentity;
  }) => Promise<void>;
  eraseBootstrap: () => Promise<void>;
};

export async function responseIdentity(response: Response) {
  if (!response.ok) throw new Error('Control plane did not accept guest enrollment.');
  if (!response.body) throw new Error('Enrollment response has no body.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) throw new Error('Enrollment response exceeds its limit.');
      chunks.push(value);
    }
    return issuedGuestIdentitySchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } finally {
    await reader.cancel();
  }
}

export async function enrollGuest(input: {
  configuration: GuestConfiguration;
  system: EnrollmentSystem;
  transport?: typeof fetch;
}) {
  const { configuration, system } = input;
  const phase = (value: string) =>
    atomicWrite(
      join(configuration.state, 'enrollment-status.json'),
      JSON.stringify({ phase: value, attemptedAt: new Date().toISOString() }) + '\n',
      0o644,
    );
  const installed = (await currentCertificates(configuration))?.identity;
  if (installed) {
    const spec = guestBootSpecSchema.parse(
      JSON.parse(await readOwnedFile(join(configuration.state, 'guest.json'), 'public')),
    );
    await verifyImage(configuration, spec);
    const proof = await ensureIdentity(configuration, spec);
    if (
      installed.sshHostPublicKey !== proof.sshHostPublicKey ||
      installed.tlsCsr !== proof.tlsCsr ||
      installed.imageVersion !== proof.imageVersion
    )
      throw new Error('Installed certificate identity disagrees with the guest keys.');
    await installIdentity(configuration, spec, proof, installed);
    await phase('activate');
    await system.activate({ proof, spec, identity: installed });
  } else {
    const bootstrap = await loadBootstrap(configuration);
    if (Date.parse(bootstrap.spec.expiresAt) <= Date.now())
      throw new Error('Guest enrollment bootstrap has expired.');
    await system.prepareIdentity(bootstrap.spec);
    await phase('identity');
    const proof = await ensureIdentity(configuration, bootstrap.spec);
    await atomicWrite(
      join(configuration.state, 'guest.json'),
      JSON.stringify(bootstrap.spec) + '\n',
      0o644,
    );
    await system.prepareSsh({ proof, spec: bootstrap.spec });
    await phase('certificate');
    const response = await (input.transport ?? fetch)(bootstrap.spec.enrollmentUrl, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bootstrap:
          bootstrap.spec.version === 1
            ? { version: 1, allocationId: bootstrap.spec.allocationId }
            : { version: 2, subject: bootstrap.spec.subject },
        token: bootstrap.token,
        sshHostPublicKey: proof.sshHostPublicKey,
        tlsCsr: proof.tlsCsr,
        imageVersion: proof.imageVersion,
      }),
    });
    const identity = await installIdentity(
      configuration,
      bootstrap.spec,
      proof,
      await responseIdentity(response),
    );
    await phase('activate');
    await system.activate({ proof, spec: bootstrap.spec, identity });
  }
  await pruneCertificates(configuration);
  await phase('cleanup');
  await system.eraseBootstrap();
  await phase('enrolled');
  return { kind: 'enrolled' };
}

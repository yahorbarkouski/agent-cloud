import { createPrivateKey, X509Certificate } from 'node:crypto';
import { join } from 'node:path';
import { guestBootSpecSchema } from '@agent-cloud/contracts';
import { signGuestRenewal } from '@agent-cloud/pki';
import { atomicWrite, isMissing, readOwnedFile } from './files.js';
import { currentCertificates, pruneCertificates } from './certificates.js';
import {
  ensureIdentity,
  installIdentity,
  verifyImage,
  type GuestConfiguration,
} from './identity.js';
import { responseIdentity } from './enrollment.js';

export async function renewGuest(input: {
  configuration: GuestConfiguration;
  system: { reloadIdentity: () => Promise<void> };
  transport?: typeof fetch;
}) {
  const { configuration } = input;
  const spec = guestBootSpecSchema.parse(
    JSON.parse(await readOwnedFile(join(configuration.state, 'guest.json'), 'public')),
  );
  if (spec.version !== 1) return { kind: 'not_required' };
  await verifyImage(configuration, spec);
  const proof = await ensureIdentity(configuration, spec);
  const stored = await currentCertificates(configuration);
  if (!stored) throw new Error('Guest renewal requires an installed identity.');
  const installedAt = Date.parse(stored.identity.issuedAt);
  const due =
    Date.now() >= installedAt + 1_800_000 ||
    new X509Certificate(stored.identity.tlsCertificate).validToDate.getTime() <=
      Date.now() + 1_200_000;
  let identity = stored.identity;
  if (due) {
    const request = signGuestRenewal({
      allocationId: spec.allocationId,
      requestedAt: new Date().toISOString(),
      key: createPrivateKey(
        await readOwnedFile(join(configuration.state, 'keys', 'guest.key'), 'private'),
      ),
    });
    const url = new URL(spec.enrollmentUrl);
    if (url.pathname !== '/guest/enroll')
      throw new Error('Guest renewal requires the pinned enrollment endpoint.');
    url.pathname = '/guest/renew';
    identity = await responseIdentity(
      await (input.transport ?? fetch)(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(90_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      }),
    );
  }
  const activationPath = join(configuration.state, 'certificate-activation.json');
  let activated: string | null = null;
  try {
    activated = await readOwnedFile(activationPath, 'private');
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await installIdentity(configuration, spec, proof, identity);
  if (identity.issuedAt === stored.identity.issuedAt && activated === stored.generation) {
    await pruneCertificates(configuration);
    return { kind: 'current' };
  }
  await input.system.reloadIdentity();
  const current = await currentCertificates(configuration);
  if (!current) throw new Error('Guest certificate publication disappeared.');
  await atomicWrite(activationPath, current.generation, 0o600);
  await pruneCertificates(configuration);
  return { kind: 'renewed', issuedAt: identity.issuedAt };
}

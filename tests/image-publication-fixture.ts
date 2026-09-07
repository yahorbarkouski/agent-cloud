import { generateKeyPairSync } from 'node:crypto';
import type { ImageReleaseKey } from '../packages/contracts/dist/index.js';
import type { Connection } from '../packages/db/dist/index.js';
import { advanceImageBuild } from '../apps/control/dist/advance-image-build.js';
import { imageVerifierScenario } from './image-verifier-fixture.js';

/** Uses real admission, journals, verifier and signing with protocol-only infrastructure. */
export async function verifiedImageScenario(connection: Connection, directory: string) {
  const f = await imageVerifierScenario(connection, directory, true);
  await f.service.enroll(f.proposal);
  await f.runtimeService.check(f.buildId);
  const pair = generateKeyPairSync('ed25519');
  const key: ImageReleaseKey = {
    kind: 'trusted',
    publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    signedFrom: new Date(Date.now() - 60_000).toISOString(),
    signedUntil: new Date(Date.now() + 86_400_000).toISOString(),
    verifyUntil: new Date(Date.now() + 2 * 86_400_000).toISOString(),
  };
  const publication = { privateKey: pair.privateKey, keys: [key] };
  const advance = () => advanceImageBuild({ ...f, publication });
  async function publish() {
    for (let pass = 0; pass < 16; pass++) {
      const result = await advance();
      if (result.kind === 'retained') return result.release;
    }
    throw new Error('Fixture publication did not converge.');
  }
  return { ...f, publication, advance, publish };
}

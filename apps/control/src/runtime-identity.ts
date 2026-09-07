import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto';
import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { CloudError, imageDigestSchema, imageReleaseKeySchema } from '@agent-cloud/contracts';
import { imageReleaseKeyId } from '@agent-cloud/images';
import { BootstrapSeal } from './bootstrap-seal.js';
import { readPrivateFile } from './private-file.js';
import type { ImageReleaseKeySource } from './image-publication.js';

const metadataSchema = z.strictObject({
  version: z.literal(1),
  bootstrapHash: imageDigestSchema,
  releaseKeyId: imageDigestSchema,
});
const policySchema = z.strictObject({
  version: z.literal(1),
  keys: z.array(imageReleaseKeySchema).max(64),
});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

async function requirePrivateDirectory(directory: string) {
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error('Runtime identity requires an owner-only directory owned by this user.');
}

/** Read on every authorization. An unavailable policy never falls back to cached trust. */
export function createImageReleaseKeySource(directory: string): ImageReleaseKeySource {
  return async () => {
    try {
      await requirePrivateDirectory(directory);
      const value: unknown = JSON.parse(
        await readPrivateFile(join(directory, 'release-policy.json')),
      );
      const { keys } = policySchema.parse(value);
      const seen = new Set<string>();
      for (const policy of keys) {
        if (policy.kind === 'revoked') continue;
        const id = imageReleaseKeyId(createPublicKey(policy.publicKey));
        if (
          seen.has(id) ||
          Date.parse(policy.signedFrom) >= Date.parse(policy.signedUntil) ||
          Date.parse(policy.signedUntil) > Date.parse(policy.verifyUntil)
        )
          throw new Error('Invalid release key policy.');
        seen.add(id);
      }
      return keys;
    } catch {
      throw new CloudError(
        'provider_unavailable',
        'Image release key policy is unavailable or invalid.',
        true,
      );
    }
  };
}

/** Customer processes need bootstrap decryption and public policy, never the release signing key. */
export async function readBootstrapIdentity(directory: string) {
  try {
    await requirePrivateDirectory(directory);
    const value: unknown = JSON.parse(await readPrivateFile(join(directory, 'identity.json')));
    const metadata = metadataSchema.parse(value);
    const encodedKey = await readPrivateFile(join(directory, 'bootstrap.key'));
    if (hash(encodedKey) !== metadata.bootstrapHash) throw new Error('Bootstrap identity differs.');
    return { metadata, seal: new BootstrapSeal(encodedKey) };
  } catch {
    throw new CloudError(
      'permission_denied',
      'Bootstrap identity is missing, incomplete or inconsistent. Restore its original files.',
    );
  }
}

export async function readRuntimeIdentity(directory: string) {
  try {
    const identity = await readBootstrapIdentity(directory);
    const privateKey = createPrivateKey(await readPrivateFile(join(directory, 'release.key')));
    if (imageReleaseKeyId(privateKey) !== identity.metadata.releaseKeyId)
      throw new Error('Runtime identity files disagree.');
    return {
      ...identity,
      publication: { privateKey, readKeys: createImageReleaseKeySource(directory) },
    };
  } catch {
    throw new CloudError(
      'permission_denied',
      'Runtime identity is missing, incomplete or inconsistent. Restore its original files.',
    );
  }
}

async function writeDurably(path: string, value: string) {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(value + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
}
async function syncDirectory(path: string) {
  const file = await open(path, 'r');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Exclusive creation; partial setup is preserved for recovery, never silently rekeyed. */
export async function initializeRuntimeIdentity(directory: string, now = new Date()) {
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  let created = false;
  try {
    await mkdir(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  if (created) {
    const encodedKey = randomBytes(32).toString('base64');
    const pair = generateKeyPairSync('ed25519');
    const keyId = imageReleaseKeyId(pair.publicKey);
    const policy = policySchema.parse({
      version: 1,
      keys: [
        {
          kind: 'trusted',
          publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }),
          signedFrom: now.toISOString(),
          signedUntil: new Date(now.getTime() + 90 * 86_400_000).toISOString(),
          verifyUntil: new Date(now.getTime() + 120 * 86_400_000).toISOString(),
        },
      ],
    });
    await writeDurably(join(directory, 'bootstrap.key'), encodedKey);
    await writeDurably(
      join(directory, 'release.key'),
      pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    );
    await writeDurably(join(directory, 'release-policy.json'), JSON.stringify(policy, null, 2));
    await writeDurably(
      join(directory, 'identity.json'),
      JSON.stringify({ version: 1, bootstrapHash: hash(encodedKey), releaseKeyId: keyId }),
    );
    await syncDirectory(directory);
    await syncDirectory(dirname(directory));
  }
  const identity = await readRuntimeIdentity(directory);
  await identity.publication.readKeys();
  return { created, releaseKeyId: identity.metadata.releaseKeyId, directory };
}

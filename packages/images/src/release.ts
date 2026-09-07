import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import {
  guestImageSchema,
  imageReleaseKeySchema,
  imageReleasePayloadSchema,
  signedImageReleaseSchema,
  type ImageReleaseKey,
  type ImageReleasePayload,
} from '@agent-cloud/contracts';
import { createImageManifest, digestManifest } from './provenance.js';

function publicKey(key: KeyObject) {
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Image releases require Ed25519 keys.');
  return key.type === 'public' ? key : createPublicKey(key);
}

export function imageReleaseKeyId(key: KeyObject) {
  return createHash('sha256')
    .update(publicKey(key).export({ format: 'der', type: 'spki' }))
    .digest('hex');
}

function validatePayload(payload: ImageReleasePayload) {
  const manifestDigest = digestManifest(payload.manifest);
  if (
    digestManifest(
      createImageManifest({
        inputs: payload.inputs,
        pins: payload.artifacts,
        trust: payload.manifest.trust,
      }),
    ) !== manifestDigest ||
    payload.sanitation.builderId !== payload.buildId ||
    payload.sanitation.serverId !== payload.snapshot.sourceServerId ||
    payload.sanitation.manifestDigest !== manifestDigest ||
    payload.verifiedBoot.manifestDigest !== manifestDigest ||
    payload.verifiedBoot.serverId === payload.snapshot.sourceServerId ||
    Date.parse(payload.snapshot.sourceStoppedAt) > Date.parse(payload.snapshot.createdAt) ||
    Date.parse(payload.snapshot.createdAt) > Date.parse(payload.verifiedBoot.checkedAt) ||
    Date.parse(payload.verifiedBoot.checkedAt) > Date.parse(payload.issuedAt) ||
    Date.parse(payload.retainUntil) <= Date.parse(payload.issuedAt)
  )
    throw new Error('Image release evidence disagrees.');
}

export function signImageRelease(value: unknown, privateKey: KeyObject) {
  const payload = imageReleasePayloadSchema.parse(value);
  validatePayload(payload);
  if (privateKey.type !== 'private') throw new Error('Image signing requires a private key.');
  const keyId = imageReleaseKeyId(privateKey);
  return signedImageReleaseSchema.parse({
    payload,
    signature: {
      algorithm: 'Ed25519',
      keyId,
      value: sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64url'),
    },
  });
}

/** Authenticates recorded evidence. The consumer must separately observe live snapshot ownership. */
export function verifySignedImageRelease(value: unknown, keys: ImageReleaseKey[], now: Date) {
  const release = signedImageReleaseSchema.parse(value);
  const trusted = new Map<
    string,
    { key: KeyObject; policy: Extract<ImageReleaseKey, { kind: 'trusted' }> }
  >();
  const revoked = new Set<string>();
  for (const input of keys) {
    const policy = imageReleaseKeySchema.parse(input);
    if (policy.kind === 'revoked') {
      revoked.add(policy.keyId);
      continue;
    }
    const key = createPublicKey(policy.publicKey);
    const id = imageReleaseKeyId(key);
    if (trusted.has(id)) throw new Error('Duplicate image signing key policy.');
    if (
      Date.parse(policy.signedFrom) >= Date.parse(policy.signedUntil) ||
      Date.parse(policy.signedUntil) > Date.parse(policy.verifyUntil)
    )
      throw new Error('Invalid image signing key validity.');
    trusted.set(id, { key, policy });
  }
  const entry = trusted.get(release.signature.keyId);
  const issued = Date.parse(release.payload.issuedAt);
  if (
    !entry ||
    revoked.has(release.signature.keyId) ||
    !Number.isFinite(now.getTime()) ||
    issued < Date.parse(entry.policy.signedFrom) ||
    issued >= Date.parse(entry.policy.signedUntil) ||
    now.getTime() >= Date.parse(entry.policy.verifyUntil) ||
    issued > now.getTime() ||
    now.getTime() >= Date.parse(release.payload.retainUntil)
  )
    throw new Error('Image release is expired or its signing key is not trusted.');
  if (
    !verify(
      null,
      Buffer.from(JSON.stringify(release.payload)),
      entry.key,
      Buffer.from(release.signature.value, 'base64url'),
    )
  )
    throw new Error('Invalid image release signature.');
  validatePayload(release.payload);
  return {
    release,
    image: guestImageSchema.parse({
      providerImage: release.payload.snapshot.id,
      architecture: release.payload.manifest.architecture,
      version: release.payload.manifest.version,
      manifestDigest: digestManifest(release.payload.manifest),
      ...release.payload.manifest.trust,
    }),
  };
}

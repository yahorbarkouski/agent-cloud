import { imageFixture } from './image-fixture.js';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  imageReleasePayloadSchema,
  type ImageReleaseKey,
} from '../packages/contracts/dist/index.js';
import {
  digestManifest,
  imageReleaseKeyId,
  signImageRelease,
  verifySignedImageRelease,
} from '../packages/images/dist/index.js';

const pair = generateKeyPairSync('ed25519');
const second = generateKeyPairSync('ed25519');
const now = new Date('2026-09-07T12:00:00Z');
const keyPolicy = (publicKey = pair.publicKey): ImageReleaseKey => ({
  kind: 'trusted',
  publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  signedFrom: '2026-09-01T00:00:00Z',
  signedUntil: '2026-09-10T00:00:00Z',
  verifyUntil: '2026-10-01T00:00:00Z',
});
function payload() {
  const fixture = imageFixture();
  const buildId = randomUUID();
  const value = imageReleasePayloadSchema.parse({
    format: 1,
    buildId,
    issuedAt: now.toISOString(),
    retainUntil: '2026-09-09T00:00:00Z',
    manifest: fixture.manifest,
    inputs: fixture.inputs,
    artifacts: fixture.pins,
    sanitation: {
      kind: 'sanitized',
      builderId: buildId,
      serverId: '456',
      manifestDigest: 'a'.repeat(64),
    },
    snapshot: {
      provider: 'hetzner',
      id: '123',
      sourceServerId: '456',
      diskGb: 40,
      sourceStoppedAt: '2026-09-07T11:30:00Z',
      createdAt: '2026-09-07T11:31:00Z',
    },
    verifiedBoot: {
      serverId: '789',
      bootId: randomUUID(),
      manifestDigest: 'a'.repeat(64),
      checkedAt: '2026-09-07T11:59:00Z',
    },
  });
  value.sanitation.manifestDigest = digestManifest(value.manifest);
  value.verifiedBoot.manifestDigest = value.sanitation.manifestDigest;
  return value;
}

it('authenticates a release and derives the exact image from signed metadata', () => {
  const value = payload();
  const release = signImageRelease(value, pair.privateKey);
  const result = verifySignedImageRelease(release, [keyPolicy()], now);
  expect(result.image).toEqual({
    providerImage: '123',
    architecture: 'x86',
    version: value.manifest.version,
    manifestDigest: digestManifest(value.manifest),
    ...value.manifest.trust,
  });
  const reordered = {
    signature: release.signature,
    payload: Object.fromEntries(Object.entries(value).reverse()),
  };
  expect(verifySignedImageRelease(reordered, [keyPolicy()], now).image).toEqual(result.image);
});

it.each(['snapshot', 'trust', 'input', 'retention', 'boot'])(
  'rejects a tampered signed %s',
  (change) => {
    const release = signImageRelease(payload(), pair.privateKey);
    if (change === 'snapshot') release.payload.snapshot.id = '999';
    if (change === 'trust') release.payload.manifest.trust.tlsRoot = 'other-root';
    if (change === 'input')
      release.payload.inputs.files.push({ path: 'other', sha256: 'b'.repeat(64), bytes: 1 });
    if (change === 'retention') release.payload.retainUntil = '2026-10-01T00:00:00Z';
    if (change === 'boot') release.payload.verifiedBoot.bootId = randomUUID();
    expect(() => verifySignedImageRelease(release, [keyPolicy()], now)).toThrow();
  },
);

it('fails closed on unknown or revoked keys and supports additive rotation', () => {
  const release = signImageRelease(payload(), pair.privateKey);
  expect(() => verifySignedImageRelease(release, [keyPolicy(second.publicKey)], now)).toThrow(
    'not trusted',
  );
  expect(
    verifySignedImageRelease(release, [keyPolicy(), keyPolicy(second.publicKey)], now).image
      .providerImage,
  ).toBe('123');
  expect(() =>
    verifySignedImageRelease(
      release,
      [keyPolicy(), { kind: 'revoked', keyId: imageReleaseKeyId(pair.publicKey) }],
      now,
    ),
  ).toThrow('not trusted');
  expect(() => verifySignedImageRelease(release, [keyPolicy(), keyPolicy()], now)).toThrow(
    'Duplicate',
  );
});

it('rejects future releases, retention expiry and retired signing windows', () => {
  const release = signImageRelease(payload(), pair.privateKey);
  expect(() =>
    verifySignedImageRelease(release, [keyPolicy()], new Date('2026-09-07T11:59:00Z')),
  ).toThrow('expired');
  expect(() =>
    verifySignedImageRelease(release, [keyPolicy()], new Date(release.payload.retainUntil)),
  ).toThrow('expired');
  const key = keyPolicy();
  if (key.kind !== 'trusted') throw new Error('Fixture policy must be trusted.');
  expect(() =>
    verifySignedImageRelease(release, [{ ...key, signedUntil: now.toISOString() }], now),
  ).toThrow('not trusted');
  expect(() =>
    verifySignedImageRelease(release, [{ ...key, signedUntil: '2026-11-01T00:00:00Z' }], now),
  ).toThrow('validity');
});

it.each([
  'sanitation',
  'inputs',
  'builder',
  'reused-source',
  'future-boot',
  'wrong-source',
  'running-snapshot',
  'incomplete-inputs',
])('refuses to sign contradictory %s evidence', (change) => {
  const value = payload();
  if (change === 'sanitation') value.sanitation.manifestDigest = 'b'.repeat(64);
  if (change === 'inputs') value.manifest.publicInputsDigest = 'b'.repeat(64);
  if (change === 'builder') value.sanitation.builderId = randomUUID();
  if (change === 'reused-source') value.verifiedBoot.serverId = value.snapshot.sourceServerId;
  if (change === 'future-boot') value.verifiedBoot.checkedAt = '2026-09-08T00:00:00Z';
  if (change === 'wrong-source') value.sanitation.serverId = '999';
  if (change === 'running-snapshot') value.snapshot.sourceStoppedAt = '2026-09-07T11:32:00Z';
  if (change === 'incomplete-inputs')
    value.inputs.files = value.inputs.files.filter((file) => file.path !== 'install.sh');
  expect(() => signImageRelease(value, pair.privateKey)).toThrow();
});

it('refuses another key algorithm or a public-only signer', () => {
  expect(() =>
    signImageRelease(payload(), generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey),
  ).toThrow('Ed25519');
  expect(() => signImageRelease(payload(), pair.publicKey)).toThrow('private');
});

import { createHash } from 'node:crypto';
import {
  guestManifestSchema,
  imageArtifactsSchema,
  imageSourcePaths,
  renewalImageSourcePaths,
} from '../packages/contracts/dist/index.js';
import {
  createImageManifest,
  customerSshSudoers,
  imageArtifacts,
} from '../packages/images/dist/index.js';

export function imageFixture(
  publicTrust?: Parameters<typeof createImageManifest>[0]['trust'],
  customerSsh?: 1,
) {
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const artifact = (file: string) => ({
    file,
    version: '1.0.0',
    url: 'https://artifacts.example.test/' + file,
    sha256: hash(file),
  });
  const pins = imageArtifactsSchema.parse({
    architecture: 'x86',
    node: artifact('node.tar.xz'),
    step: artifact('step.tar.gz'),
    caddy: artifact('caddy.tar.gz'),
    dockerVersion: '1.0.0',
    composeVersion: '1.0.0',
    debs: [{ ...artifact('docker.deb'), name: 'docker' }],
  });
  const trust = guestManifestSchema.shape.trust.parse(
    publicTrust ?? {
      sshUserCa: 'ssh-ed25519 AAAA',
      sshHostCa: 'ssh-ed25519 BBBB',
      tlsRoot: 'test-public-root',
    },
  );
  const sources = customerSsh === 1 ? imageSourcePaths : renewalImageSourcePaths;
  const files = new Map([...sources, 'guestctl.mjs'].map((path) => [path, path]));
  if (customerSsh === 1) files.set('guest-customer.sudoers', customerSshSudoers);
  for (const artifact of imageArtifacts(pins))
    files.set('artifacts/' + artifact.file, artifact.file);
  files.set('artifacts.json', JSON.stringify(pins) + '\n');
  files.set('trust.json', JSON.stringify(trust) + '\n');
  const inputs = {
    format: 1,
    files: [...files]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, value]) => ({ path, sha256: hash(value), bytes: Buffer.byteLength(value) })),
  } satisfies Parameters<typeof createImageManifest>[0]['inputs'];
  const manifest = createImageManifest({ inputs, pins, trust });
  return { files, inputs, manifest, pins, trust };
}

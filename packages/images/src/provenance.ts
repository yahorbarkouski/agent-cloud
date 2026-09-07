import { createHash } from 'node:crypto';
import {
  guestManifestSchema,
  imageArtifactsSchema,
  imageInputsSchema,
  imageSourcePaths,
  enrollmentImageSourcePaths,
  renewalImageSourcePaths,
  type GuestManifest,
  type ImageArtifacts,
  type ImageInputs,
} from '@agent-cloud/contracts';
import { customerSshSudoers } from './customer-ssh.js';

export function imageArtifacts(pins: ImageArtifacts) {
  const artifacts = [pins.node, pins.step, pins.caddy, ...pins.debs];
  if (new Set(artifacts.map((item) => item.file)).size !== artifacts.length)
    throw new Error('Image artifacts must have unique paths.');
  return artifacts;
}

export function inputPaths(pins: ImageArtifacts, sources: string[] = imageSourcePaths) {
  return [
    ...sources,
    ...imageArtifacts(pins).map((item) => `artifacts/${item.file}`),
    'artifacts.json',
    'trust.json',
    'guestctl.mjs',
  ].sort();
}

/** Schema parsing fixes field order; paths are ASCII and the inventory is already sorted. */
export function digestInputs(inputs: ImageInputs) {
  return createHash('sha256')
    .update(JSON.stringify(imageInputsSchema.parse(inputs)))
    .digest('hex');
}

export function digestManifest(manifest: GuestManifest) {
  return createHash('sha256')
    .update(JSON.stringify(guestManifestSchema.parse(manifest)))
    .digest('hex');
}

export function createImageManifest({
  inputs,
  pins,
  trust,
}: {
  inputs: ImageInputs;
  pins: ImageArtifacts;
  trust: GuestManifest['trust'];
}) {
  const paths = JSON.stringify(inputs.files.map((file) => file.path));
  const customerSsh = paths === JSON.stringify(inputPaths(pins));
  if (
    !customerSsh &&
    paths !== JSON.stringify(inputPaths(pins, renewalImageSourcePaths)) &&
    paths !== JSON.stringify(inputPaths(pins, enrollmentImageSourcePaths))
  )
    throw new Error('Image inventory does not cover the complete input set.');
  if (
    customerSsh &&
    inputs.files.find((file) => file.path === 'guest-customer.sudoers')?.sha256 !==
      createHash('sha256').update(customerSshSudoers).digest('hex')
  )
    throw new Error('Customer SSH image requires the supported sudo policy.');
  for (const artifact of imageArtifacts(pins)) {
    if (
      inputs.files.find((file) => file.path === `artifacts/${artifact.file}`)?.sha256 !==
      artifact.sha256
    )
      throw new Error('Image artifact does not match its pinned checksum.');
  }
  for (const [path, value] of [
    ['artifacts.json', imageArtifactsSchema.parse(pins)],
    ['trust.json', guestManifestSchema.shape.trust.parse(trust)],
  ] satisfies [string, unknown][]) {
    const bytes = JSON.stringify(value) + '\n';
    const file = inputs.files.find((file) => file.path === path);
    if (
      file?.sha256 !== createHash('sha256').update(bytes).digest('hex') ||
      file.bytes !== Buffer.byteLength(bytes)
    )
      throw new Error('Image metadata does not match its canonical input.');
  }
  const bundle = inputs.files.find((file) => file.path === 'guestctl.mjs');
  if (!bundle) throw new Error('Image executable is missing.');
  const publicInputsDigest = digestInputs(inputs);
  return guestManifestSchema.parse({
    format: 2,
    publicInputsDigest,
    version: `dev-${publicInputsDigest.slice(0, 24)}`,
    architecture: pins.architecture,
    components: {
      node: pins.node.version,
      step: pins.step.version,
      caddy: pins.caddy.version,
      docker: pins.dockerVersion,
      compose: pins.composeVersion,
      guestctlSha256: bundle.sha256,
    },
    trust,
    ...(customerSsh ? { customerSsh: 1 } : {}),
  });
}

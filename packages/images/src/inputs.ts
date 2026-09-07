import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  guestManifestSchema,
  imageArtifactsSchema,
  imageDigestSchema,
  imageInputPathSchema,
  imageInputsSchema,
} from '@agent-cloud/contracts';
import { createImageManifest, digestManifest } from './provenance.js';

const derived = ['SHA256SUMS', 'image-inputs.json', 'image.json'];

async function paths(directory: string, prefix = ''): Promise<string[]> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || (stat.mode & 0o022) !== 0)
    throw new Error('Image inputs require real directories without group or public write access.');
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length === 0 || entries.length > 67)
    throw new Error('Image input directories must be nonempty and bounded.');
  for (const entry of entries) {
    const path = imageInputPathSchema.parse(prefix + entry.name);
    if (entry.isDirectory()) files.push(...(await paths(join(directory, entry.name), path + '/')));
    else if (entry.isFile()) files.push(path);
    else throw new Error('Image inputs must be regular files, without symlinks.');
    if (files.length > 67) throw new Error('Too many image input files.');
  }
  return files.sort();
}

async function readInput(path: string, maxBytes: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes || (stat.mode & 0o022) !== 0)
      throw new Error('Image input file is unsafe or exceeds its size limit.');
    const data = await file.readFile();
    if (data.length !== stat.size) throw new Error('Image input changed while being read.');
    return data;
  } finally {
    await file.close();
  }
}

export async function inspectInputs(directory: string) {
  const files = [];
  for (const path of await paths(directory)) {
    if (derived.includes(path)) continue;
    const data = await readInput(join(directory, path), 128 * 1024 * 1024);
    files.push({
      path,
      sha256: createHash('sha256').update(data).digest('hex'),
      bytes: data.length,
    });
  }
  return imageInputsSchema.parse({ format: 1, files });
}

/** The caller pins the digest independently of the transferred directory. */
export async function verifyImageInputs(directory: string, expectedManifestDigest: string) {
  imageDigestSchema.parse(expectedManifestDigest);
  const manifestBytes = await readInput(join(directory, 'image.json'), 32_768);
  const manifest = guestManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
  if (digestManifest(manifest) !== expectedManifestDigest)
    throw new Error('Image manifest does not match the admitted digest.');
  const inventoryBytes = await readInput(join(directory, 'image-inputs.json'), 32_768);
  const inputs = imageInputsSchema.parse(JSON.parse(inventoryBytes.toString('utf8')));
  const actual = await inspectInputs(directory);
  if (JSON.stringify(actual) !== JSON.stringify(inputs))
    throw new Error('Image input bytes do not match the inventory.');
  const pins = imageArtifactsSchema.parse(
    JSON.parse((await readInput(join(directory, 'artifacts.json'), 32_768)).toString('utf8')),
  );
  const trust = guestManifestSchema.shape.trust.parse(
    JSON.parse((await readInput(join(directory, 'trust.json'), 16_384)).toString('utf8')),
  );
  if (digestManifest(createImageManifest({ inputs, pins, trust })) !== expectedManifestDigest)
    throw new Error('Image manifest does not describe the verified inputs.');
  const checksums = inputs.files.map((file) => `${file.sha256}  ${file.path}`);
  checksums.push(`${createHash('sha256').update(inventoryBytes).digest('hex')}  image-inputs.json`);
  checksums.push(`${createHash('sha256').update(manifestBytes).digest('hex')}  image.json`);
  if (
    (await readInput(join(directory, 'SHA256SUMS'), 32_768)).toString('utf8') !==
    checksums.join('\n') + '\n'
  )
    throw new Error('Image transfer checksums do not describe the complete input tree.');
  return {
    manifest,
    inputs,
    manifestDigest: expectedManifestDigest,
    checksumDigest: createHash('sha256')
      .update(checksums.join('\n') + '\n')
      .digest('hex'),
  };
}

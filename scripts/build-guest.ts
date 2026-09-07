import { build } from 'esbuild';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  guestManifestSchema,
  imageArtifactsSchema,
  imageSourcePaths,
  type ImageArtifacts,
} from '../packages/contracts/dist/index.js';
import {
  createImageManifest,
  digestManifest,
  imageArtifacts,
  inspectInputs,
  verifyImageInputs,
} from '../packages/images/dist/index.js';

const pins = imageArtifactsSchema.parse(
  JSON.parse(await readFile('images/artifacts.json', 'utf8')),
);
const cache = resolve('.local/guest-artifacts');
const builds = resolve('.local/guest-builds');
await mkdir(cache, { recursive: true, mode: 0o700 });
await mkdir(builds, { recursive: true, mode: 0o700 });
async function download(artifact: ImageArtifacts['node']) {
  const path = join(cache, artifact.sha256);
  try {
    if (
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex') === artifact.sha256
    )
      return;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const response = await fetch(artifact.url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok || !response.body) throw new Error(`Image download failed: ${artifact.file}.`);
    const reader = response.body.getReader();
    const file = await open(temporary, 'wx', 0o600);
    const hash = createHash('sha256');
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 128 * 1024 * 1024) throw new Error('Image artifact exceeds its size limit.');
        hash.update(value);
        await file.writeFile(value);
      }
      if (hash.digest('hex') !== artifact.sha256)
        throw new Error(`Image checksum mismatch: ${artifact.file}.`);
      await file.sync();
    } finally {
      await reader.cancel();
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
const artifacts = imageArtifacts(pins);
const downloads = await Promise.allSettled(artifacts.map(download));
for (const result of downloads) if (result.status === 'rejected') throw result.reason;
const staging = await mkdtemp(join(builds, '.staging-'));
const pointer = resolve('.local/guest-build.json');
const pointerTemporary = pointer + '.' + randomUUID() + '.tmp';
let published = false;
try {
  await mkdir(join(staging, 'artifacts'));
  await mkdir(join(staging, 'systemd'));
  for (const artifact of artifacts)
    await copyFile(join(cache, artifact.sha256), join(staging, 'artifacts', artifact.file));
  for (const file of imageSourcePaths) await copyFile(join('images', file), join(staging, file));
  await build({
    entryPoints: ['packages/guestctl/src/cli.ts'],
    outfile: join(staging, 'guestctl.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    sourcemap: false,
  });
  const trust = guestManifestSchema.shape.trust.parse({
    sshHostCa: (await readFile('.local/pki/public/ssh_host_ca_key.pub', 'utf8')).trim(),
    sshUserCa: (await readFile('.local/pki/public/ssh_user_ca_key.pub', 'utf8')).trim(),
    tlsRoot: await readFile('.local/pki/public/root_ca.crt', 'utf8'),
  });
  await writeFile(join(staging, 'artifacts.json'), JSON.stringify(pins) + '\n', { mode: 0o644 });
  await writeFile(join(staging, 'trust.json'), JSON.stringify(trust) + '\n', { mode: 0o644 });
  const inputs = await inspectInputs(staging);
  const manifest = createImageManifest({ inputs, pins, trust });
  const manifestDigest = digestManifest(manifest);
  await writeFile(join(staging, 'image-inputs.json'), JSON.stringify(inputs) + '\n', {
    mode: 0o644,
  });
  await writeFile(join(staging, 'image.json'), JSON.stringify(manifest) + '\n', { mode: 0o644 });
  const checksums = inputs.files.map((file) => `${file.sha256}  ${file.path}`);
  for (const file of ['image-inputs.json', 'image.json']) {
    checksums.push(
      `${createHash('sha256')
        .update(await readFile(join(staging, file)))
        .digest('hex')}  ${file}`,
    );
  }
  await writeFile(join(staging, 'SHA256SUMS'), checksums.join('\n') + '\n', { mode: 0o644 });
  const verified = await verifyImageInputs(staging, manifestDigest);
  const destination = join(builds, manifestDigest);
  try {
    await rename(staging, destination);
    published = true;
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        'code' in error &&
        ['EEXIST', 'ENOTEMPTY', 'EACCES'].includes(String(error.code))
      )
    )
      throw error;
    // A concurrent or previous identical build wins only after complete verification.
    await verifyImageInputs(destination, manifestDigest);
  }
  for (const file of [
    ...inputs.files.map((file) => file.path),
    'image.json',
    'image-inputs.json',
    'SHA256SUMS',
  ])
    await chmod(join(destination, file), 0o444);
  for (const path of ['artifacts', 'systemd', '.']) await chmod(join(destination, path), 0o555);
  await writeFile(pointerTemporary, JSON.stringify({ manifestDigest }) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  await rename(pointerTemporary, pointer);
  process.stdout.write(
    JSON.stringify({
      directory: destination,
      imageVersion: manifest.version,
      manifestDigest,
      publicInputsDigest: manifest.publicInputsDigest,
      checksumDigest: verified.checksumDigest,
      artifacts: artifacts.length,
      cloudResourcesCreated: 0,
    }) + '\n',
  );
} finally {
  if (!published) await removeStaging();
  await rm(pointerTemporary, { force: true });
}

async function removeStaging() {
  for (const path of ['.', 'artifacts', 'systemd']) {
    try {
      await chmod(join(staging, path), 0o700);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  await rm(staging, { recursive: true, force: true });
}

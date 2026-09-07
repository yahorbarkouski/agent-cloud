import { build } from 'esbuild';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { guestManifestSchema } from '../packages/contracts/dist/index.js';

const artifactSchema = z.object({
  version: z.string().min(1),
  file: z.string().regex(/^[A-Za-z0-9._~+-]+$/),
  url: z.url(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const pins = z
  .object({
    architecture: z.literal('x86'),
    node: artifactSchema,
    step: artifactSchema,
    caddy: artifactSchema,
    dockerVersion: z.string(),
    composeVersion: z.string(),
    debs: z.array(artifactSchema.extend({ name: z.string() })),
  })
  .parse(JSON.parse(await readFile('images/artifacts.json', 'utf8')));
const destination = resolve('.local/guest-build');
await mkdir(join(destination, 'artifacts'), { recursive: true, mode: 0o700 });
await mkdir(join(destination, 'systemd'), { recursive: true, mode: 0o700 });
async function download(artifact: z.infer<typeof artifactSchema>) {
  const path = join(destination, 'artifacts', artifact.file);
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
const artifacts = [pins.node, pins.step, pins.caddy, ...pins.debs];
// Unique filenames keep concurrent downloads independent.
if (new Set(artifacts.map((value) => value.file)).size !== artifacts.length)
  throw new Error('Image artifact paths must be unique.');
const downloads = await Promise.allSettled(artifacts.map(download));
for (const result of downloads) if (result.status === 'rejected') throw result.reason;
await build({
  entryPoints: ['packages/guestctl/src/cli.ts'],
  outfile: join(destination, 'guestctl.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: false,
});
const bundleHash = createHash('sha256')
  .update(await readFile(join(destination, 'guestctl.mjs')))
  .digest('hex');
const manifest = guestManifestSchema.parse({
  format: 1,
  version: `dev-${bundleHash.slice(0, 12)}`,
  architecture: pins.architecture,
  components: {
    node: pins.node.version,
    step: pins.step.version,
    caddy: pins.caddy.version,
    docker: pins.dockerVersion,
    compose: pins.composeVersion,
    guestctlSha256: bundleHash,
  },
  trust: {
    sshHostCa: (await readFile('.local/pki/public/ssh_host_ca_key.pub', 'utf8')).trim(),
    sshUserCa: (await readFile('.local/pki/public/ssh_user_ca_key.pub', 'utf8')).trim(),
    tlsRoot: await readFile('.local/pki/public/root_ca.crt', 'utf8'),
  },
});
await writeFile(join(destination, 'image.json'), JSON.stringify(manifest) + '\n', { mode: 0o644 });
const files = [
  'install.sh',
  'sshd_config',
  'systemd/agent-cloud-enroll.service',
  'systemd/agent-cloud-proxy.service',
];
for (const file of files) await copyFile(join('images', file), join(destination, file));
const inventory = [
  ...artifacts.map((value) => `artifacts/${value.file}`),
  'guestctl.mjs',
  'image.json',
  ...files,
];
const checksums = await Promise.all(
  inventory.map(
    async (file) =>
      `${createHash('sha256')
        .update(await readFile(join(destination, file)))
        .digest('hex')}  ${file}`,
  ),
);
await writeFile(join(destination, 'SHA256SUMS'), checksums.join('\n') + '\n');
process.stdout.write(
  JSON.stringify({
    directory: destination,
    imageVersion: manifest.version,
    manifestDigest: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    artifacts: artifacts.length,
    cloudResourcesCreated: 0,
  }) + '\n',
);

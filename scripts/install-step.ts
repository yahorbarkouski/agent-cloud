import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, rename, chmod, lstat, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';

// Official release assets pinned by the SHA-256 digests returned by GitHub's release API.
const releases = [
  {
    platform: 'darwin',
    arch: 'arm64',
    artifact: 'darwin_0.30.6_arm64',
    hash: '33cf8015b875f5d370b93c03d794eb7ba371e5c64569604c72cce6b5cbefd11f',
  },
  {
    platform: 'darwin',
    arch: 'x64',
    artifact: 'darwin_0.30.6_amd64',
    hash: '67b499409f06395ec1c7e0b31c0c5a65a9151104e999e52af8611854966851d4',
  },
  {
    platform: 'linux',
    arch: 'arm64',
    artifact: 'linux_0.30.6_arm64',
    hash: 'eff511c3e6797039702e74fada62b10b079e413742f925703e5b7d810e611619',
  },
  {
    platform: 'linux',
    arch: 'x64',
    artifact: 'linux_0.30.6_amd64',
    hash: 'e44a5dc5f880a694b24a0f2941a69a81b0bc6ee053170fdfde18453d4d5816de',
  },
];
const release = releases.find(
  (value) => value.platform === process.platform && value.arch === process.arch,
);
if (!release)
  throw new Error('The development Smallstep installer supports Linux/macOS on x64/arm64.');
const root = resolve('.local');
await mkdir(root, { recursive: true, mode: 0o700 });
const info = await lstat(root);
if (!info.isDirectory() || (info.mode & 0o077) !== 0)
  throw new Error('.local must be an owner-only real directory.');
const scratch = await mkdtemp(join(root, 'step-install-'));
try {
  const url = `https://github.com/smallstep/cli/releases/download/v0.30.6/step_${release.artifact}.tar.gz`;
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Smallstep download failed with HTTP ${response.status}.`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(archive).digest('hex') !== release.hash)
    throw new Error('Smallstep archive checksum does not match the pinned release.');
  const path = join(scratch, 'release.tar.gz');
  await writeFile(path, archive, { mode: 0o600 });
  await promisify(execFile)('tar', ['-xzf', path, '-C', scratch, 'step_0.30.6/bin/step'], {
    timeout: 15_000,
    maxBuffer: 64 * 1024,
  });
  const tools = join(root, 'tools');
  await mkdir(tools, { recursive: true, mode: 0o700 });
  if (!(await lstat(tools)).isDirectory())
    throw new Error('Tool destination must be a real directory.');
  const binary = join(tools, 'step-0.30.6');
  const staged = join(scratch, 'step_0.30.6/bin/step');
  // Refuse to follow a pre-existing symlink when installing the workspace-local executable.
  try {
    if (!(await lstat(binary)).isFile())
      throw new Error('Tool destination must be a regular file.');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  await chmod(staged, 0o700);
  await rename(staged, binary);
  const { stdout } = await promisify(execFile)(binary, ['version'], {
    timeout: 5000,
    maxBuffer: 4096,
  });
  process.stdout.write(
    JSON.stringify({
      binary,
      version: stdout.trim(),
      archiveSha256: release.hash,
      binarySha256: createHash('sha256')
        .update(await readFile(binary))
        .digest('hex'),
    }) + '\n',
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}

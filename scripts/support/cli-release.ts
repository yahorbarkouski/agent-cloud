import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { packageCli } from './packaged-cli.js';

const execute = promisify(execFile);
const source = fileURLToPath(new URL('../../', import.meta.url));
const packageSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  license: z.string().min(1),
});
const ownPackages = new Set([
  '@agent-cloud/cli',
  '@agent-cloud/contracts',
  '@agent-cloud/sdk',
  '@agent-cloud/recipes',
  '@agent-cloud/skills',
]);
const sha256 = (content: Uint8Array | string) => createHash('sha256').update(content).digest('hex');

/** Never dereference archive links or ship workspace credentials, native binaries or missing notices. */
export async function inspectCliBundle(directory: string) {
  const root = await realpath(directory);
  const packages: {
    name: string;
    version: string;
    license: string;
    path: string;
    notices: string[];
  }[] = [];
  let bytes = 0;
  let files = 0;
  const within = (path: string) => {
    const local = relative(root, path);
    return local !== '..' && !local.startsWith('..' + sep) && !isAbsolute(local);
  };
  async function visit(path: string): Promise<void> {
    const info = await lstat(path);
    const local = relative(root, path).split(sep).join('/');
    if (info.isSymbolicLink()) {
      if (isAbsolute(await readlink(path)) || !within(await realpath(path)))
        throw new Error('CLI bundle contains a link outside the release.');
      return;
    }
    if (info.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) {
        if (/^(?:\.env(?:\..*)?|\.local|\.git|\.npmrc|\.pnpmfile\.cjs)$/.test(entry))
          throw new Error('CLI bundle contains a private workspace path.');
        await visit(join(path, entry));
      }
      return;
    }
    if (!info.isFile() || /\.(?:node|pem|key)$/.test(local))
      throw new Error('CLI bundle contains an unsupported file.');
    bytes += info.size;
    if (++files > 20_000 || bytes > 64 * 1024 * 1024)
      throw new Error('CLI bundle exceeds its reviewable release size.');
    if (!local.endsWith('/package.json') && local !== 'package.json') return;
    const candidate: unknown = JSON.parse(await readFile(path, 'utf8'));
    // Some dependencies have format-only package.json files in ESM/CJS subdirectories.
    if (!z.object({ name: z.string() }).safeParse(candidate).success) return;
    const pkg = packageSchema.parse(candidate);
    const notices = (await readdir(dirname(path)))
      .filter((name) => /^(?:licen[sc]e|copying|notice)(?:[.-].*)?$/i.test(name))
      .sort();
    if (!ownPackages.has(pkg.name) && notices.length === 0)
      throw new Error('CLI dependency is missing its license text.');
    packages.push({
      ...pkg,
      path: local,
      notices: notices.map((name) => join(dirname(local), name).split(sep).join('/')),
    });
  }
  await visit(root);
  for (const name of ownPackages)
    if (!packages.some((pkg) => pkg.name === name))
      throw new Error('CLI bundle is missing a required package.');
  return { bytes, files, packages: packages.sort((a, b) => a.path.localeCompare(b.path)) };
}

/** Produces a portable Node distribution. Output must be a new directory; never overwrite a release. */
export async function buildCliRelease(output: string) {
  const destination = resolve(output);
  // Refuse existing output before touching generated files in the checkout.
  await mkdir(destination, { mode: 0o700 });
  // tsc's incremental build can retain removed source outputs. Clear only the four
  // generated CLI package directories and force compilation before selecting inputs.
  for (const path of [
    'apps/cli/dist',
    'packages/contracts/dist',
    'packages/sdk/dist',
    'packages/recipes/dist',
  ])
    await rm(join(source, path), { recursive: true, force: true });
  await execute(
    process.execPath,
    [join(source, 'node_modules/typescript/bin/tsc'), '-b', '--force'],
    {
      cwd: source,
      timeout: 120_000,
      maxBuffer: 131072,
    },
  );
  const pkg = packageSchema
    .extend({ version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/) })
    .parse(JSON.parse(await readFile(join(source, 'apps/cli/package.json'), 'utf8')));
  const rootPackage = z
    .object({ engines: z.object({ node: z.string() }) })
    .parse(JSON.parse(await readFile(join(source, 'package.json'), 'utf8')));
  const revision = (await execute('git', ['rev-parse', 'HEAD'], { cwd: source })).stdout.trim();
  const workingTreeDirty =
    (await execute('git', ['status', '--porcelain'], { cwd: source })).stdout.length > 0;
  const lockSha256 = sha256(await readFile(join(source, 'pnpm-lock.yaml')));
  const scratch = await mkdtemp(join(tmpdir(), 'acld-cli-release-'));
  try {
    const cli = await packageCli(scratch);
    const installed = dirname(dirname(cli));
    const name = `agent-cloud-cli-${pkg.version}`;
    const bundle = join(scratch, name);
    await mkdir(bundle, { mode: 0o755 });
    for (const entry of ['dist', 'node_modules', 'package.json'])
      await cp(join(installed, entry), join(bundle, entry), {
        recursive: true,
        verbatimSymlinks: true,
      });
    await cp(join(source, 'LICENSE'), join(bundle, 'LICENSE'));
    await cp(join(source, 'docs/cli-install.md'), join(bundle, 'README.md'));
    await mkdir(join(bundle, 'bin'), { mode: 0o755 });
    await writeFile(join(bundle, 'bin/acld'), "#!/usr/bin/env node\nimport '../dist/index.js';\n", {
      mode: 0o755,
      flag: 'wx',
    });
    const inventory = await inspectCliBundle(bundle);
    await writeFile(
      join(bundle, 'DEPENDENCIES.json'),
      JSON.stringify({ version: 1, packages: inventory.packages }, null, 2) + '\n',
    );
    const provenance = {
      version: 1,
      name: pkg.name,
      cliVersion: pkg.version,
      node: rootPackage.engines.node,
      platform: 'linux-darwin',
      architecture: 'portable-javascript',
      sourceRevision: revision,
      workingTreeDirty,
      lockSha256,
    };
    await writeFile(join(bundle, 'BUILD.json'), JSON.stringify(provenance, null, 2) + '\n');
    const archiveName = `${name}.tar.gz`;
    const archive = join(destination, archiveName);
    await execute('tar', ['-czf', archive, '-C', scratch, name], {
      env: { PATH: process.env.PATH, COPYFILE_DISABLE: '1' },
      timeout: 30_000,
      maxBuffer: 65536,
    });
    await chmod(archive, 0o644);
    const content = await readFile(archive);
    const digest = sha256(content);
    const manifest = {
      ...provenance,
      archive: archiveName,
      bytes: content.byteLength,
      sha256: digest,
    };
    const manifestJson = JSON.stringify(manifest, null, 2) + '\n';
    await writeFile(join(destination, 'release.json'), manifestJson, { flag: 'wx', mode: 0o644 });
    // Written last. No completed checksum file is left by a failed build.
    await writeFile(
      join(destination, 'SHA256SUMS'),
      `${digest}  ${archiveName}\n${sha256(manifestJson)}  release.json\n`,
      { flag: 'wx', mode: 0o644 },
    );
    return { ...manifest, directory: destination };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

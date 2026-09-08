import { execFile } from 'node:child_process';
import { cp, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';

/** Deploy only allowlisted built inputs. pnpm --prod must never prune the source checkout. */
export async function packageCli(directory: string) {
  const source = fileURLToPath(new URL('../../', import.meta.url));
  const packaging = join(directory, 'workspace');
  await mkdir(packaging, { mode: 0o700 });
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'])
    await cp(join(source, name), join(packaging, name));
  for (const group of ['apps', 'packages']) {
    for (const entry of await readdir(join(source, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(group, entry.name);
      await mkdir(join(packaging, path), { recursive: true });
      await cp(join(source, path, 'package.json'), join(packaging, path, 'package.json'));
    }
  }
  await mkdir(join(packaging, 'skills/agent-cloud'), { recursive: true });
  await cp(join(source, 'skills/package.json'), join(packaging, 'skills/package.json'));
  for (const path of [
    'apps/cli/dist',
    'packages/contracts/dist',
    'packages/sdk/dist',
    'packages/recipes/dist',
    'packages/recipes/assets',
    'skills/agent-cloud/SKILL.md',
  ])
    await cp(join(source, path), join(packaging, path), { recursive: true });
  const installed = join(directory, 'installed-cli');
  await promisify(execFile)(
    'npm',
    [
      'exec',
      '--yes',
      '--package=pnpm@12.3.4',
      '--',
      'pnpm',
      '--filter',
      '@agent-cloud/cli',
      'deploy',
      '--legacy',
      '--prod',
      installed,
    ],
    { cwd: packaging, timeout: 120_000, maxBuffer: 131_072 },
  );
  return join(installed, 'dist/index.js');
}

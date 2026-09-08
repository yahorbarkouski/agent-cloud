import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { inspectCliBundle } from '../scripts/support/cli-release.js';

let scratch: string;
let bundle: string;
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'acld-bundle-refusal-'));
  bundle = join(scratch, 'bundle');
  await mkdir(bundle);
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

it('rejects an archive symlink resolving outside its root, including a chain', async () => {
  await writeFile(join(scratch, 'secret'), 'private fixture canary');
  await symlink('../secret', join(bundle, 'outside'));
  await symlink('outside', join(bundle, 'chained'));
  await expect(inspectCliBundle(bundle)).rejects.toThrow('outside the release');
});

it.each(['.env', '.env.production', '.npmrc', '.local', 'runtime.key', 'binding.node'])(
  'refuses private or platform-dependent archive input %s',
  async (name) => {
    await writeFile(join(bundle, name), 'private fixture canary');
    await expect(inspectCliBundle(bundle)).rejects.toThrow(/private workspace|unsupported file/);
  },
);

it('refuses a dependency whose license identifier has no bundled license text', async () => {
  await writeFile(
    join(bundle, 'package.json'),
    JSON.stringify({ name: 'dependency', version: '1.0.0', license: 'MIT' }),
  );
  await expect(inspectCliBundle(bundle)).rejects.toThrow('missing its license text');
});

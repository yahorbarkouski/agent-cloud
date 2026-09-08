import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, symlink, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { prepareRecipe } from '../packages/recipes/src/index.js';
import { recipes } from '../packages/recipes/src/catalog.js';
import { readComposeBundle } from '../apps/cli/src/compose.js';
import {
  preparedRecipeSchema,
  recipesResponseSchema,
  recipeResponseSchema,
} from '../packages/contracts/src/index.js';

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'acld-recipes-'));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});
function cli(args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    execFile(
      process.execPath,
      [resolve('apps/cli/dist/index.js'), 'recipe', ...args],
      {
        cwd: scratch,
        env: { PATH: process.env.PATH, ACLD_CREDENTIALS: join(scratch, 'absent') },
        timeout: 10_000,
      },
      (error, stdout, stderr) => {
        done({ code: error ? 1 : 0, stdout, stderr });
      },
    );
  });
}

it('discovers bundled versions offline and rejects an unavailable version before creating output', async () => {
  const listed = await cli(['list']);
  expect(listed.code).toBe(0);
  expect(recipesResponseSchema.parse(JSON.parse(listed.stdout)).recipes).toEqual(recipes);
  const detail = await cli(['inspect', 'umami', '--version', '1.0.0']);
  expect(
    recipeResponseSchema.parse(JSON.parse(detail.stdout)).recipe.backup.pointInTimeRecovery,
  ).toBe(false);
  const destination = join(scratch, 'unavailable');
  const failed = await cli(['prepare', 'umami', '--version', '99.0.0', '--output', destination]);
  expect(failed.code).toBe(1);
  expect(JSON.parse(failed.stderr)).toMatchObject({ error: { code: 'not_found' } });
  await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('prepares a private CLI context that the actual Compose upload reader accepts without printing secrets', async () => {
  const destination = join(scratch, 'umami context');
  const result = await cli([
    'prepare',
    'umami',
    '--version',
    '1.0.0',
    '--output',
    destination,
    '--port',
    '3007',
  ]);
  expect(result.code, result.stderr).toBe(0);
  const prepared = preparedRecipeSchema.parse(JSON.parse(result.stdout));
  const bundle = await readComposeBundle(destination);
  expect(bundle.map((file) => file.path)).toEqual([
    'bootstrap.mjs',
    'compose.yaml',
    'recipe.json',
    'release-id',
    'secrets/database-password',
    'secrets/umami.env',
  ]);
  expect((await stat(destination)).mode & 0o777).toBe(0o700);
  expect((await stat(join(destination, 'secrets'))).mode & 0o777).toBe(0o700);
  expect((await stat(join(destination, 'bootstrap.mjs'))).mode & 0o777).toBe(0o644);
  for (const name of ['database-password', 'umami.env']) {
    const file = join(destination, 'secrets', name);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const content = await readFile(file, 'utf8');
    for (const secret of content.match(/[a-f0-9]{64}/g) ?? []) {
      expect(result.stdout + result.stderr).not.toContain(secret);
    }
  }
  expect(await readFile(join(destination, 'compose.yaml'), 'utf8')).toContain(
    '127.0.0.1:3007:3000',
  );
  expect((await readFile(join(destination, 'release-id'), 'utf8')).trim()).toBe(prepared.releaseId);
  expect(JSON.parse(await readFile(join(destination, 'recipe.json'), 'utf8'))).toEqual({
    id: 'umami',
    version: '1.0.0',
    releaseId: prepared.releaseId,
  });
  const retry = await cli(['prepare', 'umami', '--version', '1.0.0', '--output', destination]);
  expect(retry.code).toBe(1);
  expect(await readComposeBundle(destination)).toEqual(bundle);
});

it('allows exactly one simultaneous preparation and preserves its complete context on retries', async () => {
  const input = { id: 'postgres', version: '1.0.0', output: join(scratch, 'concurrent') };
  const results = await Promise.allSettled([prepareRecipe(input), prepareRecipe(input)]);
  expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
  const snapshot = await readComposeBundle(input.output);
  await expect(prepareRecipe(input)).rejects.toThrow('Existing files and secrets');
  expect(await readComposeBundle(input.output)).toEqual(snapshot);
});

it('refuses linked or partial output, an unsupported port, and a traversal recipe', async () => {
  const target = join(scratch, 'target');
  const link = join(scratch, 'link');
  await mkdir(target);
  await writeFile(join(target, 'sentinel'), 'keep');
  await symlink(target, link);
  const base = { id: 'postgres', version: '1.0.0' };
  await expect(prepareRecipe({ ...base, output: link })).rejects.toThrow(
    'Existing files and secrets',
  );
  await expect(prepareRecipe({ ...base, output: target })).rejects.toThrow(
    'Existing files and secrets',
  );
  expect(await readFile(join(target, 'sentinel'), 'utf8')).toBe('keep');
  for (const invalid of [
    { ...base, port: 3000 },
    { ...base, id: '../umami' },
    { ...base, id: 'umami', port: 80 },
  ]) {
    await expect(prepareRecipe({ ...invalid, output: join(scratch, 'invalid') })).rejects.toThrow();
  }
  await expect(stat(join(scratch, 'invalid'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('creates independent high-entropy database and application secrets for separate contexts', async () => {
  const paths = [join(scratch, 'first'), join(scratch, 'second')];
  const secrets: string[] = [];
  for (const path of paths) {
    await prepareRecipe({ id: 'umami', version: '1.0.0', output: path });
    const env = await readFile(join(path, 'secrets/umami.env'), 'utf8');
    const values = env.match(/[a-f0-9]{64}/g) ?? [];
    expect(values).toHaveLength(4);
    secrets.push(...values);
    expect(await readFile(join(path, 'secrets/database-password'), 'utf8')).toBe(
      z.string().parse(values[0]),
    );
  }
  expect(new Set(secrets).size).toBe(8);
});

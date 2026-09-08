import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { CloudError, recipePrepareSchema, preparedRecipeSchema } from '@agent-cloud/contracts';
import { findRecipe } from './catalog.js';
export { recipes, findRecipe } from './catalog.js';

async function syncDirectory(path: string) {
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writeNew(path: string, content: string | Buffer, mode = 0o600) {
  const handle = await open(path, 'wx', mode);
  try {
    // Override a restrictive umask for non-secret code mounted for Umami's uid 1001.
    await handle.chmod(mode);
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function prepareRecipe(value: unknown) {
  const input = recipePrepareSchema.parse(value);
  const recipe = findRecipe(input.id, input.version);
  const assets = new URL(`../assets/${recipe.id}/`, import.meta.url);
  let compose = await readFile(new URL('compose.yaml', assets), 'utf8');
  const bootstrap = recipe.id === 'umami' ? await readFile(new URL('bootstrap.mjs', assets)) : null;
  if (recipe.id === 'umami')
    compose = compose.replace('127.0.0.1:3000:3000', `127.0.0.1:${input.port ?? 3000}:3000`);
  const destination = resolve(input.output);
  const createdParent = await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  try {
    // Exclusive creation also refuses concurrent preparation, symlinks and partial output.
    await mkdir(destination, { mode: 0o700 });
  } catch {
    throw new CloudError(
      'invalid_input',
      'Recipe destination must be a new writable directory. Existing files and secrets are never overwritten.',
    );
  }
  await mkdir(join(destination, 'secrets'), { mode: 0o700 });
  await writeNew(join(destination, 'compose.yaml'), compose);
  const databasePassword = randomBytes(32).toString('hex');
  await writeNew(join(destination, 'secrets/database-password'), databasePassword);
  if (bootstrap) {
    await writeNew(
      join(destination, 'secrets/umami.env'),
      `DATABASE_URL=postgresql://umami:${databasePassword}@database:5432/umami\nAPP_SECRET=${randomBytes(32).toString('hex')}\nTWO_FACTOR_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}\nRECIPE_ADMIN_PASSWORD=${randomBytes(32).toString('hex')}\n`,
    );
    await writeNew(join(destination, 'bootstrap.mjs'), bootstrap, 0o644);
  }
  const releaseId = randomUUID();
  await writeNew(join(destination, 'release-id'), `${releaseId}\n`);
  await syncDirectory(join(destination, 'secrets'));
  // Written last: a receipt identifies the selected version, never replaces missing secrets.
  await writeNew(
    join(destination, 'recipe.json'),
    JSON.stringify({ id: recipe.id, version: recipe.version, releaseId }) + '\n',
  );
  await syncDirectory(destination);
  const syncBoundary = createdParent ? dirname(createdParent) : dirname(destination);
  for (let path = dirname(destination); ; path = dirname(path)) {
    await syncDirectory(path);
    if (path === syncBoundary) break;
  }
  return preparedRecipeSchema.parse({
    recipe: recipe.id,
    version: recipe.version,
    source: destination,
    releaseId,
    prepared: true,
  });
}

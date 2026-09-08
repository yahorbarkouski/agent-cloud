import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { parseArgs } from 'node:util';

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { output: { type: 'string' }, port: { type: 'string' } },
  });
  const [recipe] = positionals;
  if (positionals.length !== 1 || !['postgres', 'umami'].includes(recipe) || !values.output)
    throw new Error('Use: node recipes/prepare.mjs <postgres|umami> --output <new-directory>.');
  const port = Number(values.port ?? '3000');
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || (recipe !== 'umami' && values.port))
    throw new Error('--port is an Umami loopback port between 1024 and 65535.');
  const destination = resolve(values.output);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  // Never overwrite secrets or a context whose release might already be admitted.
  await mkdir(destination, { mode: 0o700 });
  await mkdir(join(destination, 'secrets'), { mode: 0o700 });
  const source = fileURLToPath(new URL(`./${recipe}/`, import.meta.url));
  let compose = await readFile(join(source, 'compose.yaml'), 'utf8');
  if (recipe === 'umami')
    compose = compose.replace('127.0.0.1:3000:3000', `127.0.0.1:${port}:3000`);
  await writeFile(join(destination, 'compose.yaml'), compose, { mode: 0o600, flag: 'wx' });
  const databasePassword = randomBytes(32).toString('hex');
  await writeFile(join(destination, 'secrets/database-password'), databasePassword, {
    mode: 0o600,
    flag: 'wx',
  });
  if (recipe === 'umami') {
    const administratorPassword = randomBytes(32).toString('hex');
    await writeFile(
      join(destination, 'secrets/umami.env'),
      `DATABASE_URL=postgresql://umami:${databasePassword}@database:5432/umami\nAPP_SECRET=${randomBytes(32).toString('hex')}\nTWO_FACTOR_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}\nRECIPE_ADMIN_PASSWORD=${administratorPassword}\n`,
      { mode: 0o600, flag: 'wx' },
    );
    // Non-secret code must be readable by Umami's uid 1001 through the bind mount.
    await writeFile(
      join(destination, 'bootstrap.mjs'),
      await readFile(join(source, 'bootstrap.mjs')),
      {
        mode: 0o644,
        flag: 'wx',
      },
    );
    await chmod(join(destination, 'bootstrap.mjs'), 0o644);
  }
  await writeFile(join(destination, 'release-id'), `${randomUUID()}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  process.stdout.write(JSON.stringify({ recipe, source: destination, prepared: true }) + '\n');
} catch {
  process.stderr.write(
    'Recipe preparation failed. Use postgres or umami with --output naming a new directory; existing output and secrets are never overwritten.\n',
  );
  process.exitCode = 1;
}

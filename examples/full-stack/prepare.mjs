import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const [hostname, directory, ...extra] = process.argv.slice(2);
if (
  !hostname ||
  !directory ||
  extra.length ||
  hostname.length > 253 ||
  !hostname.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
) {
  throw new Error('Usage: node prepare.mjs <returned-app-hostname> <new-private-directory>');
}
const source = dirname(fileURLToPath(import.meta.url));
const destination = resolve(directory);
// Refuse an existing context: regeneration must never replace database credentials.
await mkdir(destination, { mode: 0o700 });
for (const name of [
  'backend.ts',
  'package.json',
  'package-lock.json',
  'Dockerfile',
  '.dockerignore',
  'Caddyfile',
  'index.html',
]) {
  const target = join(destination, name);
  await copyFile(join(source, name), target, constants.COPYFILE_EXCL);
  await chmod(target, 0o600);
}
const compose = (await readFile(join(source, 'compose.yaml'), 'utf8')).replace(
  'APP_HOSTNAME: example.invalid',
  `APP_HOSTNAME: ${hostname}`,
);
await writeFile(join(destination, 'compose.yaml'), compose, { mode: 0o600, flag: 'wx' });
await writeFile(join(destination, 'database-password'), randomBytes(32).toString('hex') + '\n', {
  mode: 0o600,
  flag: 'wx',
});
process.stdout.write(JSON.stringify({ directory: destination, hostname, port: 3000 }) + '\n');

import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readPrivateFile } from './private-file.js';

async function template() {
  return readFile(new URL('../assets/pgbackrest.conf', import.meta.url), 'utf8');
}

/** One independently recoverable encryption authority. Never rotate it on a retry. */
export async function initializeControlWal(path: string) {
  const fixed = await template();
  const configuration = (passphrase: string) => fixed.replace('@CIPHER_PASS@', passphrase);
  try {
    const file = await open(path, 'wx', 0o600);
    try {
      await file.chmod(0o600);
      await file.writeFile(configuration(randomBytes(32).toString('hex')));
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  const content = await readPrivateFile(path);
  const passphrase = /^repo1-cipher-pass=([a-f0-9]{64})$/m.exec(content)?.[1];
  if (!passphrase || content !== configuration(passphrase).trim())
    throw new Error(
      'Existing WAL configuration is invalid; restore its matching independent copy.',
    );
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

import { createHash, randomUUID } from 'node:crypto';
import { lstat, readlink, rename, rm, symlink, readdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { issuedGuestIdentitySchema, type IssuedGuestIdentity } from '@agent-cloud/contracts';
import { isMissing, readOwnedFile, syncDirectory } from './files.js';
import type { GuestConfiguration } from './identity.js';

export function certificateDigest(identity: IssuedGuestIdentity) {
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

/** Only this root-owned relative pointer may select a certificate generation. */
export async function currentCertificates(configuration: GuestConfiguration) {
  const base = join(configuration.state, 'certificates');
  const owner = process.getuid?.();
  try {
    const directory = await lstat(base);
    if (!directory.isDirectory() || directory.uid !== owner || directory.mode & 0o022)
      throw new Error('Certificate directory is unsafe.');
    const pointer = await lstat(join(base, 'current'));
    if (!pointer.isSymbolicLink() || pointer.uid !== owner)
      throw new Error('Certificate pointer is unsafe.');
    const generation = await readlink(join(base, 'current'));
    if (!/^[0-9a-f]{64}$/.test(generation)) throw new Error('Certificate pointer is invalid.');
    const path = join(base, generation);
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.uid !== owner || stat.mode & 0o022)
      throw new Error('Certificate generation is unsafe.');
    const identity = issuedGuestIdentitySchema.parse(
      JSON.parse(await readOwnedFile(join(path, 'identity.json'), 'private')),
    );
    if (certificateDigest(identity) !== generation)
      throw new Error('Certificate generation identity changed.');
    return { path, generation, identity };
  } catch (error) {
    if (!isMissing(error)) throw error;
    // A missing current pointer is only valid before initial publication. A dangling pointer is corruption.
    try {
      await lstat(join(base, 'current'));
    } catch (missing) {
      if (isMissing(missing)) return null;
      throw missing;
    }
    throw new Error('Published certificate generation is missing.', { cause: error });
  }
}

export async function selectCertificates(configuration: GuestConfiguration, generation: string) {
  if (!/^[0-9a-f]{64}$/.test(generation)) throw new Error('Invalid certificate generation.');
  const base = join(configuration.state, 'certificates');
  const temporary = join(base, `.current-${randomUUID()}`);
  try {
    await symlink(generation, temporary);
    await rename(temporary, join(base, 'current'));
    await syncDirectory(base);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Called after successful service activation. Keep current and its immediate predecessor only. */
export async function pruneCertificates(configuration: GuestConfiguration) {
  const current = await currentCertificates(configuration);
  if (!current) return;
  const base = join(configuration.state, 'certificates');
  const generations: Array<{ name: string; issuedAt: number }> = [];
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!/^[0-9a-f]{64}$/.test(entry.name)) continue;
    if (!entry.isDirectory()) throw new Error('Unexpected certificate generation entry.');
    const identity = issuedGuestIdentitySchema.parse(
      JSON.parse(await readOwnedFile(join(base, entry.name, 'identity.json'), 'private')),
    );
    if (certificateDigest(identity) !== entry.name)
      throw new Error('Certificate generation changed.');
    generations.push({ name: entry.name, issuedAt: Date.parse(identity.issuedAt) });
  }
  const previous = generations
    .filter((entry) => entry.name !== current.generation)
    .sort((a, b) => b.issuedAt - a.issuedAt)[0]?.name;
  for (const entry of generations) {
    if (entry.name === current.generation || entry.name === previous) continue;
    const path = join(base, entry.name);
    for (const name of ['host-cert.pub', 'guest.crt', 'root.crt', 'identity.json'])
      await rm(join(path, name));
    await rmdir(path);
  }
  await discardStaging(base);
  await syncDirectory(base);
}

/** The guest wrapper holds the same exclusive lock used by installation and renewal. */
async function discardStaging(base: string) {
  const owner = process.getuid?.();
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!/^\.generation-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
    const path = join(base, entry.name);
    const directory = await lstat(path);
    if (!directory.isDirectory() || directory.uid !== owner || directory.mode & 0o022)
      throw new Error('Interrupted certificate staging is unsafe.');
    const entries = await readdir(path);
    for (const name of entries) {
      if (
        !/^(host-cert\.pub|guest\.crt|root\.crt|identity\.json)(\.[0-9a-f-]{36}\.tmp)?$/.test(name)
      )
        throw new Error('Interrupted certificate staging contains an unknown file.');
      await readOwnedFile(
        join(path, name),
        name.startsWith('identity.json') ? 'private' : 'public',
      );
    }
    for (const name of entries) await rm(join(path, name));
    await rmdir(path);
  }
}

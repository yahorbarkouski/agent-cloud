import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  CloudError,
  imageBuildAdmissionSchema,
  imageBuildIdSchema,
  type ImageBuildAdmission,
} from '@agent-cloud/contracts';
import { readPrivateFile } from './private-file.js';

const identitySchema = z.strictObject({
  buildId: imageBuildIdSchema,
  manifestDigest: imageBuildAdmissionSchema.shape.source.shape.manifestDigest,
  managementAddress: imageBuildAdmissionSchema.shape.access.shape.managementAddress,
});
const metadataSchema = identitySchema.omit({ managementAddress: true }).extend({
  version: z.literal(1),
  access: imageBuildAdmissionSchema.shape.access,
});
type Identity = z.infer<typeof identitySchema>;
type AccessBinding = Pick<ImageBuildAdmission, 'id' | 'access'> & {
  source: Pick<ImageBuildAdmission['source'], 'manifestDigest'>;
};
const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';
const occupied = (error: unknown) =>
  error instanceof Error &&
  'code' in error &&
  (error.code === 'EEXIST' || error.code === 'ENOTEMPTY');

async function privateDirectory(path: string) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error('Image access needs an owner-only directory owned by this process user.');
}
async function syncFile(path: string) {
  const file = await open(path, 'r');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Operator-local secrets. Public metadata may enter SQL; private keys never do. */
export function createImageAccessStore(configuration: {
  directory: string;
  keygenBinary?: string;
}) {
  const root = resolve(configuration.directory);
  const keygen = resolve(configuration.keygenBinary ?? '/usr/bin/ssh-keygen');
  const run = async (args: string[], cwd: string) => {
    try {
      return (
        await promisify(execFile)(keygen, args, {
          cwd,
          env: { PATH: '/usr/bin:/bin', LANG: 'C' },
          timeout: 10_000,
          killSignal: 'SIGKILL',
          maxBuffer: 4096,
        })
      ).stdout.trim();
    } catch {
      throw new CloudError('internal_error', 'Image access key generation or validation failed.');
    }
  };
  async function read(identity: Identity) {
    await privateDirectory(root);
    const directory = join(root, identity.buildId);
    await privateDirectory(directory);
    const metadata = metadataSchema.parse(
      JSON.parse(await readPrivateFile(join(directory, 'metadata.json'))),
    );
    if (
      metadata.buildId !== identity.buildId ||
      metadata.manifestDigest !== identity.manifestDigest ||
      metadata.access.managementAddress !== identity.managementAddress
    )
      throw new CloudError(
        'idempotency_conflict',
        'Existing image access belongs to another build intent.',
      );
    const managementPrivateKey = (await readPrivateFile(join(directory, 'management'))) + '\n';
    const hostPrivateKey = (await readPrivateFile(join(directory, 'host'))) + '\n';
    // Verify exactly the bytes being returned, not a second read of mutable store paths.
    const temporary = await mkdtemp(join(tmpdir(), 'agent-cloud-image-keys-'));
    try {
      for (const { name, privateKey, publicKey } of [
        {
          name: 'management',
          privateKey: managementPrivateKey,
          publicKey: metadata.access.publicKey,
        },
        { name: 'host', privateKey: hostPrivateKey, publicKey: metadata.access.hostPublicKey },
      ]) {
        const path = join(temporary, name);
        await writeFile(path, privateKey, { flag: 'wx', mode: 0o600 });
        if ((await run(['-y', '-f', path], temporary)) !== publicKey)
          throw new CloudError(
            'permission_denied',
            'Image access private and public keys disagree.',
          );
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    if (metadata.access.publicKey === metadata.access.hostPublicKey)
      throw new CloudError(
        'permission_denied',
        'Image management and host keys must be independent.',
      );
    return { access: metadata.access, managementPrivateKey, hostPrivateKey };
  }
  async function prepare(input: Identity) {
    const identity = identitySchema.parse(input);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await privateDirectory(root);
    const destination = join(root, identity.buildId);
    const exists = await lstat(destination).then(
      () => true,
      (error: unknown) => {
        if (missing(error)) return false;
        throw error;
      },
    );
    // An incomplete existing directory must not silently cause key replacement.
    if (exists) return (await read(identity)).access;
    const temporary = await mkdtemp(join(root, '.preparing-'));
    try {
      for (const name of ['management', 'host']) {
        await run(['-t', 'ed25519', '-N', '', '-C', '', '-f', join(temporary, name)], temporary);
        await chmod(join(temporary, name + '.pub'), 0o600);
      }
      const access = imageBuildAdmissionSchema.shape.access.parse({
        managementAddress: identity.managementAddress,
        publicKey: (await readFile(join(temporary, 'management.pub'), 'utf8')).trim(),
        hostPublicKey: (await readFile(join(temporary, 'host.pub'), 'utf8')).trim(),
        secretId: randomUUID(),
      });
      await writeFile(
        join(temporary, 'metadata.json'),
        JSON.stringify({
          buildId: identity.buildId,
          manifestDigest: identity.manifestDigest,
          version: 1,
          access,
        }) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
      for (const name of ['management', 'host', 'management.pub', 'host.pub', 'metadata.json'])
        await syncFile(join(temporary, name));
      await syncFile(temporary);
      try {
        await rename(temporary, destination);
      } catch (error) {
        if (!occupied(error)) throw error;
      }
      await syncFile(root);
      return (await read(identity)).access;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  async function recover(input: AccessBinding) {
    try {
      const access = imageBuildAdmissionSchema.shape.access.parse(input.access);
      const result = await read(
        identitySchema.parse({
          buildId: input.id,
          manifestDigest: input.source.manifestDigest,
          managementAddress: access.managementAddress,
        }),
      );
      if (JSON.stringify(result.access) !== JSON.stringify(access))
        throw new Error('Image access differs from admission.');
      return result;
    } catch {
      throw new CloudError(
        'permission_denied',
        'Image builder access is unavailable or does not match its admission.',
      );
    }
  }
  /** Call only after authoritative cleanup of resources that could need this access. */
  async function remove(input: AccessBinding) {
    const id = imageBuildIdSchema.parse(input.id);
    const access = imageBuildAdmissionSchema.shape.access.parse(input.access);
    const manifestDigest = identitySchema.shape.manifestDigest.parse(input.source.manifestDigest);
    const destination = join(root, id);
    const retiring = join(root, `.removing-${id}-${access.secretId}`);
    try {
      try {
        await privateDirectory(root);
      } catch (error) {
        if (missing(error)) return;
        throw error;
      }
      const exists = await lstat(destination).then(
        () => true,
        (error: unknown) => {
          if (missing(error)) return false;
          throw error;
        },
      );
      if (exists) {
        try {
          await privateDirectory(destination);
          const metadata = metadataSchema.parse(
            JSON.parse(await readPrivateFile(join(destination, 'metadata.json'))),
          );
          if (
            metadata.buildId !== id ||
            metadata.manifestDigest !== manifestDigest ||
            JSON.stringify(metadata.access) !== JSON.stringify(access)
          )
            throw new Error('Image access differs from the terminal build.');
          // Rename before unlinking so a restart can finish even after metadata has been removed.
          await rename(destination, retiring);
        } catch (error) {
          if (!missing(error)) throw error;
          // Another cleanup may have moved this directory. Missing metadata in an existing
          // directory is corruption, not evidence that its keys were already removed.
          const remains = await lstat(destination).then(
            () => true,
            (cause: unknown) => {
              if (missing(cause)) return false;
              throw cause;
            },
          );
          if (remains) throw error;
        }
        await syncFile(root);
      }
      try {
        await privateDirectory(retiring);
      } catch (error) {
        if (missing(error)) return;
        throw error;
      }
      try {
        const metadata = metadataSchema.parse(
          JSON.parse(await readPrivateFile(join(retiring, 'metadata.json'))),
        );
        if (
          metadata.buildId !== id ||
          metadata.manifestDigest !== manifestDigest ||
          JSON.stringify(metadata.access) !== JSON.stringify(access)
        )
          throw new Error('Retiring image access belongs to another intent.');
      } catch (error) {
        if (!missing(error)) throw error;
      }
      for (const name of ['management', 'host', 'management.pub', 'host.pub', 'metadata.json'])
        await rm(join(retiring, name), { force: true });
      // Refuse unexpected files instead of recursively deleting arbitrary contents.
      try {
        await rmdir(retiring);
      } catch (error) {
        if (!missing(error)) throw error;
      }
      await syncFile(root);
    } catch {
      throw new CloudError(
        'permission_denied',
        'Terminal image access cleanup needs its owned local key directory.',
      );
    }
  }
  return { prepare, recover, remove };
}
export type ImageAccessStore = ReturnType<typeof createImageAccessStore>;

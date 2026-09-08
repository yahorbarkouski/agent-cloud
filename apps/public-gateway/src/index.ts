import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  gatewayAdminSocket,
  normalizePublicSnapshot,
  publicGatewayConfigurationSchema,
  publicRouteSnapshotSchema,
  renderCaddyConfig,
  type PublicGatewayConfiguration,
  type PublicRouteSnapshot,
} from './config.js';
export * from './config.js';

export type CaddyRuntime = {
  run: (args: string[]) => Promise<void>;
  readConfig: () => Promise<unknown>;
};
const savedSchema = z.strictObject({
  snapshot: publicRouteSnapshotSchema,
  config: z.json(),
  credentialsDigest: z.string().regex(/^[0-9a-f]{64}$/),
});

function missing(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function ownedFile(path: string, privateFile: boolean) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      stat.mode & (privateFile ? 0o077 : 0o022) ||
      stat.size > 2 * 1024 * 1024
    )
      throw new Error('Gateway file ownership, permissions or size is invalid.');
    const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size >= buffer.length) throw new Error('Gateway file exceeds its limit.');
    return buffer.subarray(0, size);
  } finally {
    await file.close();
  }
}

async function writeDurably(directory: string, path: string, value: unknown) {
  const temporary = join(directory, `.${randomUUID()}.json`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(value) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

function nativeRuntime(configuration: PublicGatewayConfiguration): CaddyRuntime {
  return {
    run: (args) =>
      new Promise((resolve, reject) => {
        const child = spawn(configuration.caddy, args, {
          cwd: configuration.stateDirectory,
          env: {
            PATH: '/usr/local/bin:/usr/bin:/bin',
            LANG: 'C',
            XDG_CONFIG_HOME: join(configuration.stateDirectory, 'config'),
            XDG_DATA_HOME: join(configuration.stateDirectory, 'data'),
          },
          timeout: 30_000,
          killSignal: 'SIGKILL',
          stdio: 'ignore',
        });
        const failed = () => {
          reject(
            new Error('Caddy command failed; the accepted gateway configuration is unchanged.'),
          );
        };
        child.on('error', failed);
        child.on('exit', (code) => {
          if (code === 0) resolve();
          else failed();
        });
      }),
    readConfig: () =>
      new Promise((resolve, reject) => {
        const req = request(
          { socketPath: gatewayAdminSocket(configuration), path: '/config/', method: 'GET' },
          (response) => {
            if (response.statusCode !== 200) {
              response.resume();
              reject(new Error('Private Caddy configuration could not be inspected.'));
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            response.on('data', (data: Buffer) => {
              size += data.length;
              if (size > 2 * 1024 * 1024) {
                response.destroy(new Error('Caddy configuration exceeds its limit.'));
                return;
              }
              chunks.push(data);
            });
            response.on('error', reject);
            response.on('end', () => {
              try {
                const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                resolve(value);
              } catch {
                reject(new Error('Private Caddy configuration is not valid JSON.'));
              }
            });
          },
        );
        req.on('error', (error) => {
          if (missing(error) || ('code' in error && error.code === 'ECONNREFUSED')) resolve(null);
          else reject(error);
        });
        req.setTimeout(5000, () => req.destroy(new Error('Private Caddy inspection timed out.')));
        req.end();
      }),
  };
}

/** One controller owns this state directory; calls through this instance are serialized. */
export function createPublicGateway(
  input: PublicGatewayConfiguration,
  suppliedRuntime?: CaddyRuntime,
) {
  const configuration = publicGatewayConfigurationSchema.parse(input);
  const runtime = suppliedRuntime ?? nativeRuntime(configuration);
  const directory = configuration.stateDirectory;
  const accepted = join(directory, 'last-good.json');
  const candidate = join(directory, 'candidate.json');
  const admin = `unix/${gatewayAdminSocket(configuration)}`;
  const empty = renderCaddyConfig(configuration, { revision: 'bootstrap', routes: [] });
  let tail: Promise<unknown> = Promise.resolve();
  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work);
    tail = result.catch(() => undefined);
    return result;
  }
  async function prepare() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
      throw new Error('Gateway state requires an owner-only directory.');
  }
  async function saved() {
    try {
      return savedSchema.parse(JSON.parse((await ownedFile(accepted, true)).toString('utf8')));
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
  async function credentialsDigest(snapshot: PublicRouteSnapshot) {
    const hash = createHash('sha256');
    if (snapshot.routes.length === 0) return hash.digest('hex');
    for (const [path, privateFile] of [
      [configuration.guestCaFile, false],
      [configuration.clientCertificateFile, false],
      [configuration.clientKeyFile, true],
    ] satisfies [string, boolean][]) {
      const bytes = await ownedFile(path, privateFile);
      hash.update(String(bytes.length) + ':').update(bytes);
    }
    return hash.digest('hex');
  }
  async function inspect() {
    await prepare();
    const state = await saved();
    const active = await runtime.readConfig();
    const credentialsMatch =
      state === null ||
      (await credentialsDigest(state.snapshot).then(
        (digest) => digest === state.credentialsDigest,
        () => false,
      ));
    return {
      revision: state?.snapshot.revision ?? null,
      routes: state?.snapshot.routes.length ?? 0,
      active:
        active !== null && isDeepStrictEqual(active, state?.config ?? empty) && credentialsMatch,
    };
  }
  return {
    inspect: () => serialize(inspect),
    start: () =>
      serialize(async () => {
        await prepare();
        const state = await saved();
        // Operator configuration wins on restart, including a changed control hostname/port.
        const config = state ? renderCaddyConfig(configuration, state.snapshot) : empty;
        await writeDurably(directory, candidate, config);
        await runtime.run(['validate', '--config', candidate]);
        const digest = state && (await credentialsDigest(state.snapshot));
        if ((await runtime.readConfig()) === null)
          await runtime.run(['start', '--config', candidate]);
        else await runtime.run(['reload', '--config', candidate, '--address', admin, '--force']);
        if (!isDeepStrictEqual(await runtime.readConfig(), config))
          throw new Error('Caddy did not load the accepted startup configuration.');
        if (state && digest) {
          if (digest !== (await credentialsDigest(state.snapshot)))
            throw new Error('Gateway TLS files changed during startup.');
          await writeDurably(directory, accepted, { ...state, config, credentialsDigest: digest });
        }
        return inspect();
      }),
    apply: (input: PublicRouteSnapshot) => {
      const snapshot = normalizePublicSnapshot(input);
      const config = renderCaddyConfig(configuration, snapshot);
      return serialize(async () => {
        await prepare();
        const previous = await saved();
        if (
          previous?.snapshot.revision === snapshot.revision &&
          !isDeepStrictEqual(previous.snapshot, snapshot)
        )
          throw new Error('A gateway revision cannot describe different routes.');
        const digest = await credentialsDigest(snapshot);
        const active = await runtime.readConfig();
        if (active === null) throw new Error('Start the public gateway before applying routes.');
        if (
          previous?.snapshot.revision === snapshot.revision &&
          previous.credentialsDigest === digest &&
          isDeepStrictEqual(previous.config, config) &&
          isDeepStrictEqual(active, config)
        )
          return inspect();
        await writeDurably(directory, candidate, config);
        await runtime.run(['validate', '--config', candidate]);
        await runtime.run(['reload', '--config', candidate, '--address', admin, '--force']);
        if (!isDeepStrictEqual(await runtime.readConfig(), config))
          throw new Error('Caddy did not load the requested gateway configuration.');
        if (digest !== (await credentialsDigest(snapshot)))
          throw new Error('Gateway TLS files changed during reload.');
        await writeDurably(directory, accepted, { snapshot, config, credentialsDigest: digest });
        return inspect();
      });
    },
    stop: () =>
      serialize(async () => {
        await prepare();
        if ((await runtime.readConfig()) !== null) await runtime.run(['stop', '--address', admin]);
      }),
  };
}

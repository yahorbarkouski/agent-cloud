import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify, isDeepStrictEqual } from 'node:util';
import {
  referenceReleaseSchema,
  referenceStateSchema,
  type ReferenceCommand,
  type ReferenceState,
  type ReferenceRelease,
} from '@agent-cloud/contracts';
import { atomicWrite, ensureDirectory, isMissing, readOwnedFile, syncDirectory } from './files.js';
import { referenceFrontend, referenceImages, referenceRecipe } from './reference-recipe.js';

export type ReferenceSystem = {
  start: () => Promise<void>;
  compose: (directory: string, args: string[]) => Promise<string>;
};
export const referenceSystem: ReferenceSystem = {
  start: async () => {
    await promisify(execFile)(
      '/usr/bin/systemctl',
      ['start', '--no-block', 'agent-cloud-reference.service'],
      { timeout: 5000, maxBuffer: 4096 },
    );
  },
  compose: async (directory, args) => {
    try {
      return (
        await promisify(execFile)(
          '/usr/bin/docker',
          ['compose', '--project-name', 'agent-cloud-reference', '--file', 'compose.json', ...args],
          {
            cwd: directory,
            env: {
              PATH: '/usr/local/bin:/usr/bin:/bin',
              LANG: 'C',
              DOCKER_CONFIG: '/root/.docker',
            },
            timeout: 720_000,
            killSignal: 'SIGKILL',
            maxBuffer: 32_768,
          },
        )
      ).stdout;
    } catch {
      throw new Error('Reference Compose operation failed.');
    }
  },
};

export function createReferenceDeployment(configuration: {
  directory: string;
  binary: string;
  system: ReferenceSystem;
}) {
  const root = configuration.directory;
  const statePath = join(root, 'state.json');
  const releaseDirectory = (id: string) => join(root, 'releases', id);
  async function state(): Promise<ReferenceState> {
    try {
      return referenceStateSchema.parse(JSON.parse(await readOwnedFile(statePath, 'private')));
    } catch (error) {
      if (isMissing(error)) return { kind: 'absent' };
      throw error;
    }
  }
  const save = (release: ReferenceRelease, phase: 'pending' | 'running' | 'succeeded' | 'failed') =>
    atomicWrite(
      statePath,
      JSON.stringify({ kind: 'release', release, phase, updatedAt: new Date().toISOString() }) +
        '\n',
      0o600,
    );

  /** The fixed guest wrapper serializes admission. Work uses its own independent lock. */
  async function command(input: ReferenceCommand) {
    await ensureDirectory(root, 0o700);
    const current = await state();
    if (input.kind === 'inspect' || input.kind === 'logs') {
      const output =
        current.kind === 'absent'
          ? ''
          : await configuration.system.compose(
              releaseDirectory(current.release.releaseId),
              input.kind === 'logs'
                ? ['logs', '--no-color', '--tail', '100', 'backend']
                : ['ps', '--all', '--format', 'json'],
            );
      return { state: current, output };
    }
    const release = referenceReleaseSchema.parse({
      releaseId: input.releaseId,
      expectedReleaseId: input.expectedReleaseId,
      revision: input.revision,
      hostname: input.hostname,
    });
    if (current.kind === 'release' && current.release.releaseId === release.releaseId) {
      if (!isDeepStrictEqual(current.release, release))
        throw new Error('Release ID was used with a different request.');
      if (current.phase === 'pending' || current.phase === 'running')
        await configuration.system.start();
      return { state: current, output: '' };
    }
    if (
      (current.kind === 'absent' ? null : current.release.releaseId) !== release.expectedReleaseId
    )
      throw new Error('Expected release differs from the current deployment.');
    if (current.kind === 'release' && ['pending', 'running'].includes(current.phase))
      throw new Error('Another deployment is still active.');
    // A release directory is immutable. Failed or stale requests cannot repurpose its identity.
    await ensureDirectory(join(root, 'releases'), 0o700);
    const directory = releaseDirectory(release.releaseId);
    await ensureDirectory(directory, 0o700);
    const requestPath = join(directory, 'request.json');
    try {
      const existing = referenceReleaseSchema.parse(
        JSON.parse(await readOwnedFile(requestPath, 'private')),
      );
      if (!isDeepStrictEqual(existing, release))
        throw new Error('Release ID is already bound to another request.');
    } catch (error) {
      if (!isMissing(error)) throw error;
      await atomicWrite(requestPath, JSON.stringify(release) + '\n', 0o600);
    }
    try {
      await readOwnedFile(join(root, 'database-password'), 'public');
    } catch (error) {
      if (!isMissing(error)) throw error;
      // Parent is root-only. The read-only secret mount must be readable by the non-root backend.
      await atomicWrite(
        join(root, 'database-password'),
        randomBytes(32).toString('hex') + '\n',
        0o444,
      );
    }
    await atomicWrite(
      join(directory, 'compose.json'),
      JSON.stringify(referenceRecipe(release)),
      0o600,
    );
    await atomicWrite(
      join(directory, 'Caddyfile'),
      `${release.hostname} {\n handle /api/* {\n  reverse_proxy backend:3000\n }\n handle {\n  root * /srv\n  file_server\n }\n}\nhttp://:8080 {\n respond /ready 200\n}\n`,
      0o644,
    );
    await atomicWrite(join(directory, 'index.html'), referenceFrontend(release.revision), 0o644);
    await atomicWrite(
      join(directory, 'Dockerfile'),
      `FROM ${referenceImages.node}\nWORKDIR /app\nCOPY guestctl.mjs /app/guestctl.mjs\nUSER node\nCMD ["node", "/app/guestctl.mjs", "reference-app"]\n`,
      0o644,
    );
    // The binary is public immutable image input; sync it before recording durable intent.
    await atomicWrite(
      join(directory, 'guestctl.mjs'),
      await readFile(configuration.binary, 'utf8'),
      0o644,
    );
    await syncDirectory(directory);
    await save(release, 'pending');
    await configuration.system.start();
    return { state: await state(), output: '' };
  }

  /** systemd resumes a pending/running release after reboot or an interrupted process. */
  async function work() {
    const current = await state();
    if (current.kind === 'absent' || current.phase === 'succeeded' || current.phase === 'failed')
      return;
    const { release } = current;
    await save(release, 'running');
    try {
      const directory = releaseDirectory(release.releaseId);
      await configuration.system.compose(directory, ['config', '--quiet']);
      await configuration.system.compose(directory, ['build', '--quiet', 'backend']);
      await configuration.system.compose(directory, [
        'up',
        '--detach',
        '--wait',
        '--wait-timeout',
        '120',
        '--remove-orphans',
      ]);
      await save(release, 'succeeded');
    } catch {
      await save(release, 'failed');
      throw new Error('Reference deployment failed; inspect status and logs.');
    }
  }
  return { command, work, state };
}

import { createHash } from 'node:crypto';
import { chmod, mkdir, open, readdir, statfs } from 'node:fs/promises';
import { dirname, join, resolve, sep, posix } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import {
  CloudError,
  composeAppSchema,
  composeReleaseIdSchema,
  composeReleaseSchema,
  composeApplySchema,
  composeRecoverSchema,
  composePromoteSchema,
  composeResponseSchema,
  type ComposeCommand,
  type ComposeRelease,
} from '@agent-cloud/contracts';
import { atomicWrite, ensureDirectory, isMissing, readOwnedFile, syncDirectory } from './files.js';
import { composeConfigSchema, composePsSchema, type ComposeSystem } from './compose-system.js';

const requestSchema = z.union([composeApplySchema, composeRecoverSchema, composePromoteSchema]);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const terminal = (release: ComposeRelease) =>
  ['succeeded', 'failed', 'interrupted'].includes(release.phase);

/** Give a verified isolated app egress and loopback ports without changing images or data mounts. */
export function promoteRestoreNetwork(value: unknown, project: string, release: string) {
  const config = composeConfigSchema.parse(value);
  const networks = z
    .strictObject({
      default: z.strictObject({
        internal: z.literal(true),
        name: z.string().optional(),
        ipam: z.strictObject({}).optional(),
      }),
    })
    .parse(config['networks']);
  if (networks.default.name && networks.default.name !== `${project}_default`)
    throw new CloudError('invalid_input', 'Promotion requires the isolated project network.');
  for (const service of Object.values(config.services)) {
    if (service['network_mode'])
      throw new CloudError('invalid_input', 'Promotion does not permit host networking.');
    z.union([
      z.tuple([z.literal('default')]),
      z.strictObject({ default: z.record(z.string(), z.unknown()).nullable() }),
    ]).parse(service['networks']);
    if (service['ports'])
      z.array(z.looseObject({ host_ip: z.literal('127.0.0.1') })).parse(service['ports']);
  }
  // A distinct network avoids deleting the connected isolation network during replacement.
  config['networks'] = { default: { name: `${project}_promoted_${release}` } };
  return config;
}

/** Guest diagnostics belong to this machine's root-capable customer, never billing authority. */
export function createComposeDeployments(input: { directory: string; system: ComposeSystem }) {
  const appPath = (app: string) => join(input.directory, composeAppSchema.parse(app));
  const releasePath = (app: string, id: string) =>
    join(appPath(app), 'releases', composeReleaseIdSchema.parse(id));
  const project = (app: string) => `acld-${composeAppSchema.parse(app)}`;
  const save = (app: string, release: ComposeRelease) =>
    atomicWrite(
      join(releasePath(app, release.id), 'state.json'),
      JSON.stringify(release) + '\n',
      0o600,
    );
  async function readRelease(app: string, id: string) {
    const result = composeReleaseSchema.parse(
      JSON.parse(await readOwnedFile(join(releasePath(app, id), 'state.json'), 'private')),
    );
    if (result.id !== id) throw new Error('Release record differs from its directory.');
    return result;
  }
  async function current(app: string) {
    let id: string;
    try {
      id = composeReleaseIdSchema.parse(
        JSON.parse(await readOwnedFile(join(appPath(app), 'head.json'), 'private')),
      );
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    // A published head with a missing release is corruption, never a new empty app.
    return readRelease(app, id);
  }
  async function reply(
    app: string,
    release: ComposeRelease | null,
    kind: 'state' | 'inspect' | 'logs' = 'state',
    service?: string,
  ) {
    let output = '';
    let containers: z.infer<typeof composeResponseSchema>['containers'] = [];
    if (release && kind !== 'state') {
      const file = join(releasePath(app, release.id), 'runtime.json');
      // ps/logs select the stable project even if validation failed before a runtime file existed.
      const selector = join(appPath(app), 'selector.json');
      await atomicWrite(selector, '{"services":{}}\n', 0o600);
      let selected = selector;
      try {
        await readOwnedFile(file, 'private', 16_777_216);
        selected = file;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      const text = await input.system.compose(
        project(app),
        selected,
        kind === 'logs'
          ? ['logs', '--no-color', '--tail', '100', ...(service ? [service] : [])]
          : ['ps', '--all', '--format', 'json'],
      );
      if (kind === 'logs') output = text.slice(-131_072);
      else
        containers = text
          .trim()
          .split('\n')
          .filter(Boolean)
          .flatMap((line) => {
            const parsed: unknown = JSON.parse(line);
            return (
              Array.isArray(parsed)
                ? z.array(composePsSchema).parse(parsed)
                : [composePsSchema.parse(parsed)]
            ).map((value) => ({
              id: value.ID,
              service: value.Service,
              state: value.State,
              health: value.Health,
              exitCode: value.ExitCode,
            }));
          });
    }
    return composeResponseSchema.parse({ app, project: project(app), release, containers, output });
  }

  /** Wrapper admission flock serializes all mutations; work has an independent lifetime lock. */
  async function command(command: ComposeCommand) {
    if (command.kind === 'inspect' || command.kind === 'logs')
      return reply(
        command.app,
        await current(command.app),
        command.kind,
        command.kind === 'logs' ? command.service : undefined,
      );
    const request =
      command.kind === 'apply'
        ? { ...command, files: [...command.files].sort((a, b) => a.path.localeCompare(b.path)) }
        : command;
    const requestJson = JSON.stringify(request);
    const requestDigest = digest(requestJson);
    const head = await current(command.app);
    let existing: ComposeRelease | null = null;
    try {
      existing = await readRelease(command.app, command.releaseId);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (existing && existing.requestDigest !== requestDigest)
      throw new CloudError(
        'idempotency_conflict',
        'Release ID belongs to a different deployment request.',
      );
    if (existing && (head?.id === existing.id || terminal(existing)))
      return reply(command.app, existing);
    if ((head?.id ?? null) !== command.expectedReleaseId)
      throw new CloudError(
        'version_conflict',
        'Expected release differs from the current deployment. Inspect before applying another release.',
      );
    if (head && !terminal(head))
      throw new CloudError('resource_busy', 'A deployment is still active for this app.', true);
    if (command.kind === 'apply' && !command.files.some((file) => file.path === command.file))
      throw new CloudError(
        'invalid_input',
        'The selected Compose file is missing from the source bundle.',
      );
    if (command.kind === 'recover' || command.kind === 'promote') {
      const source = await readRelease(command.app, command.fromReleaseId);
      if (source.phase !== 'succeeded')
        throw new CloudError('invalid_input', 'Recovery requires a previously succeeded release.');
      if (command.kind === 'promote' && command.fromReleaseId !== command.expectedReleaseId)
        throw new CloudError('invalid_input', 'Promote the current verified isolated release.');
    }
    await ensureDirectory(input.directory, 0o700);
    await syncDirectory(dirname(input.directory));
    if ((await readdir(input.directory)).length >= 32 && !head)
      throw new CloudError('quota_exceeded', 'Managed Compose app limit reached.');
    await ensureDirectory(appPath(command.app), 0o700);
    await syncDirectory(input.directory);
    const releases = join(appPath(command.app), 'releases');
    await ensureDirectory(releases, 0o700);
    await syncDirectory(appPath(command.app));
    if ((await readdir(releases)).length >= 128 && !existing)
      throw new CloudError(
        'quota_exceeded',
        'Retained release limit reached; retained sources are needed for recovery.',
      );
    const disk = await statfs(releases);
    if (disk.bavail * disk.bsize < 536_870_912)
      throw new CloudError('quota_exceeded', 'Insufficient free disk for another release.');
    const directory = releasePath(command.app, command.releaseId);
    await ensureDirectory(directory, 0o700);
    await syncDirectory(releases);
    // A crash before state/head publication may leave only the immutable request.
    try {
      const stored = await readOwnedFile(join(directory, 'request.json'), 'private', 16_777_216);
      if (digest(stored.trimEnd()) !== requestDigest)
        throw new CloudError(
          'idempotency_conflict',
          'Release ID already has different saved inputs.',
        );
    } catch (error) {
      if (!isMissing(error)) throw error;
      await atomicWrite(join(directory, 'request.json'), requestJson + '\n', 0o600);
    }
    const now = new Date().toISOString();
    const release: ComposeRelease = existing ?? {
      id: command.releaseId,
      requestDigest,
      previousSuccessfulReleaseId:
        head?.phase === 'succeeded' ? head.id : (head?.previousSuccessfulReleaseId ?? null),
      phase: 'queued',
      submittedAt: now,
      updatedAt: now,
      configDigest: null,
      images: {},
      failure: null,
    };
    await save(command.app, release);
    await atomicWrite(
      join(appPath(command.app), 'head.json'),
      JSON.stringify(release.id) + '\n',
      0o600,
    );
    // The periodic service recovers a lost wakeup. An uncertain start never changes the release ID.
    await input.system.start();
    return reply(command.app, await current(command.app));
  }

  async function prepare(app: string, release: ComposeRelease) {
    const directory = releasePath(app, release.id);
    const request = requestSchema.parse(
      JSON.parse(await readOwnedFile(join(directory, 'request.json'), 'private', 16_777_216)),
    );
    if (
      digest(JSON.stringify(request)) !== release.requestDigest ||
      request.app !== app ||
      request.releaseId !== release.id
    )
      throw new Error('Saved deployment input integrity differs.');
    const runtimePath = join(directory, 'runtime.json');
    if (request.kind === 'recover' || request.kind === 'promote') {
      const original = await readRelease(app, request.fromReleaseId);
      if (original.phase !== 'succeeded') throw new Error('Recovery source is not successful.');
      let runtime = await readOwnedFile(
        join(releasePath(app, original.id), 'runtime.json'),
        'private',
        16_777_216,
      );
      if (digest(runtime) !== original.configDigest)
        throw new Error('Recovery configuration integrity differs.');
      for (const image of Object.values(original.images)) {
        if ((await input.system.imageId(image)) !== image)
          throw new Error('Recovery image differs.');
      }
      if (request.kind === 'promote')
        runtime =
          JSON.stringify(promoteRestoreNetwork(JSON.parse(runtime), project(app), release.id)) +
          '\n';
      await atomicWrite(runtimePath, runtime, 0o600);
      return { request, configDigest: digest(runtime), images: original.images };
    }
    const source = join(directory, 'source');
    await ensureDirectory(source, 0o700);
    await syncDirectory(directory);
    for (const file of request.files) {
      const path = join(source, file.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o755 });
      // New release paths contain only validated relative regular-file entries; no archives or links.
      const handle = await open(path, 'wx', file.executable ? 0o755 : 0o644);
      try {
        await handle.writeFile(Buffer.from(file.content, 'base64'));
        await handle.chmod(file.executable ? 0o755 : 0o644);
        await handle.sync();
      } finally {
        await handle.close();
      }
      let parent = dirname(path);
      while (parent !== source) {
        await chmod(parent, 0o755);
        await syncDirectory(parent);
        parent = dirname(parent);
      }
      await syncDirectory(source);
    }
    const config = composeConfigSchema.parse(
      JSON.parse(
        await input.system.compose(project(app), join(source, request.file), [
          'config',
          '--format',
          'json',
        ]),
      ),
    );
    for (const [name, service] of Object.entries(config.services)) {
      for (const volume of service.volumes ?? []) {
        if (volume.type === 'volume' && !volume.source)
          throw new CloudError(
            'invalid_input',
            'Use named volumes for persistent data; anonymous volumes cannot be recovered reliably.',
          );
        if (
          volume.type === 'bind' &&
          volume.source &&
          (resolve(volume.source) === source || resolve(volume.source).startsWith(source + sep)) &&
          !volume.read_only
        )
          throw new CloudError(
            'invalid_input',
            'Release source bind mounts must be read-only. Keep mutable data in a named volume or an explicit external path.',
          );
      }
      if (service.build !== undefined)
        service.image = `${project(app)}:${release.id}-${digest(name).slice(0, 16)}`;
    }
    const buildPath = join(directory, 'build.json');
    await atomicWrite(buildPath, JSON.stringify(config) + '\n', 0o600);
    await input.system.compose(project(app), buildPath, ['build', '--quiet']);
    await input.system.compose(project(app), buildPath, ['pull', '--quiet', '--ignore-buildable']);
    const images: Record<string, string> = {};
    for (const [name, service] of Object.entries(config.services)) {
      if (!service.image) throw new Error('Every service needs a built or pulled image.');
      const id = await input.system.imageId(service.image);
      for (const declared of await input.system.imageVolumes(id)) {
        const path = posix.resolve('/', declared);
        const covered = (service.volumes ?? []).some((volume) => {
          const target = posix.resolve('/', volume.target);
          return (
            (volume.type === 'volume' || volume.type === 'bind') &&
            Boolean(volume.source) &&
            (path === target || path.startsWith(target.endsWith('/') ? target : target + '/'))
          );
        });
        if (!covered)
          throw new CloudError(
            'invalid_input',
            'An image declares a data volume without an explicit persistent mount. Add a named volume or bind mount for every image-declared volume.',
          );
      }
      images[name] = id;
      service.image = id;
      service.pull_policy = 'never';
      delete service.build;
    }
    const runtime = JSON.stringify(config) + '\n';
    await atomicWrite(runtimePath, runtime, 0o600);
    return { request, configDigest: digest(runtime), images };
  }

  /** One bounded worker per VM. Never repeat an uncertain build/apply after its process exits. */
  async function work() {
    let apps: string[];
    try {
      apps = await readdir(input.directory);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const app of apps) {
      if (!composeAppSchema.safeParse(app).success) continue;
      let release = await current(app);
      if (!release || terminal(release)) continue;
      if (release.phase !== 'queued') {
        await save(app, {
          ...release,
          phase: 'interrupted',
          updatedAt: new Date().toISOString(),
          failure:
            'The deployment worker stopped before recording completion. Inspect running containers, then explicitly recover or apply a new release.',
        });
        continue;
      }
      try {
        release = { ...release, phase: 'preparing', updatedAt: new Date().toISOString() };
        await save(app, release);
        const prepared = await prepare(app, release);
        release = {
          ...release,
          phase: 'applying',
          configDigest: prepared.configDigest,
          images: prepared.images,
          updatedAt: new Date().toISOString(),
        };
        await save(app, release);
        await input.system.compose(
          project(app),
          join(releasePath(app, release.id), 'runtime.json'),
          [
            'up',
            '--detach',
            '--wait',
            '--wait-timeout',
            String(prepared.request.waitSeconds),
            '--remove-orphans',
            ...(prepared.request.kind === 'promote' ? ['--force-recreate'] : []),
            '--no-build',
            '--pull',
            'never',
          ],
        );
        await save(app, { ...release, phase: 'succeeded', updatedAt: new Date().toISOString() });
      } catch (error) {
        await save(app, {
          ...release,
          phase: 'failed',
          updatedAt: new Date().toISOString(),
          failure:
            error instanceof CloudError
              ? error.failure.message
              : 'Deployment preparation or application failed. Inspect the release and logs; retained volumes have not been deleted.',
        });
      }
    }
  }
  async function wait(app: string) {
    const deadline = Date.now() + 300_000;
    for (;;) {
      const release = await current(app);
      if (!release || terminal(release) || Date.now() >= deadline) return reply(app, release);
      await setTimeout(500);
    }
  }
  return { command, work, wait, current };
}

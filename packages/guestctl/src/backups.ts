import { constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, chown, lstat, open, readdir, rename, rm, statfs } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix } from 'node:path';
import { addAbortSignal, type Readable } from 'node:stream';
import { z } from 'zod';
import {
  CloudError,
  backupIdSchema,
  backupGuestCaptureSchema,
  backupGuestStateSchema,
  backupCaptureManifestSchema,
  restoreIdSchema,
  restoreGuestRequestSchema,
  restoreGuestStateSchema,
  composeApplySchema,
  composeRecoverSchema,
  composePromoteSchema,
  composeReleaseIdSchema,
  composeReleaseSchema,
  composePathSchema,
  composeAppSchema,
  type BackupGuestCommand,
  type RestoreGuestRequest,
} from '@agent-cloud/contracts';
import { createComposeDeployments } from './compose.js';
import { composeConfigSchema, composePsSchema } from './compose-system.js';
import { atomicWrite, ensureDirectory, isMissing, readOwnedFile, syncDirectory } from './files.js';
import {
  customerFile,
  hashBackupFile,
  packBackup,
  unpackBackup,
  readBackupHandle,
  writeBackupStream,
  type BackupBudget,
} from './backup-archive.js';
import {
  backupComposeSystem,
  backupSystem,
  isolatedBackupConfig,
  postgresCommand,
  postgresVersion,
  type BackupSystem,
} from './backup-system.js';

type CaptureCommand = Extract<BackupGuestCommand, { kind: 'capture' }>;
type Capture = z.infer<typeof backupGuestStateSchema>;
type Restore = z.infer<typeof restoreGuestStateSchema>;
const sourceRequest = z.union([composeApplySchema, composeRecoverSchema, composePromoteSchema]);
const metadataSchema = z.strictObject({
  version: z.literal(1),
  backupId: backupIdSchema,
  manifest: backupCaptureManifestSchema,
  source: composeApplySchema,
  config: composeConfigSchema,
  sourceRoot: z.string().refine(isAbsolute),
  customerRoot: z.string().refine(isAbsolute),
  files: z
    .array(
      z.strictObject({
        path: composePathSchema,
        entry: z.string().regex(/^file-[0-9]{1,2}$/),
        mode: z.int().min(0).max(0o777),
        uid: z.int().nonnegative(),
        gid: z.int().nonnegative(),
      }),
    )
    .max(100),
});
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const metadataMaximum = 33_554_432;

/** Every method runs under the backup wrapper lock. Capture/restore also hold both Compose locks. */
export function createGuestBackups(input: {
  directory: string;
  composeDirectory: string;
  customerDirectory: string;
  system?: BackupSystem;
}) {
  const system = input.system ?? backupSystem;
  const location = (kind: 'captures' | 'restores', id: string) =>
    join(input.directory, kind, (kind === 'captures' ? backupIdSchema : restoreIdSchema).parse(id));
  async function optional<T>(path: string, schema: z.ZodType<T>, maximum = 1_048_576) {
    try {
      return schema.parse(JSON.parse(await readOwnedFile(path, 'private', maximum)));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }
  const save = (directory: string, name: string, value: unknown) =>
    atomicWrite(join(directory, name), JSON.stringify(value) + '\n', 0o600);
  async function admit(
    kind: 'captures' | 'restores',
    id: string,
    request: CaptureCommand | RestoreGuestRequest,
  ) {
    await ensureDirectory(input.directory, 0o700);
    await syncDirectory(dirname(input.directory));
    const root = join(input.directory, kind);
    await ensureDirectory(root, 0o700);
    await syncDirectory(input.directory);
    const directory = location(kind, id);
    const stored = await optional(
      join(directory, 'request.json'),
      z.strictObject({ digest: z.string(), request: z.unknown() }),
    );
    const requestDigest = digest(JSON.stringify(request));
    if (
      stored &&
      (stored.digest !== requestDigest || digest(JSON.stringify(stored.request)) !== requestDigest)
    )
      throw new CloudError(
        'idempotency_conflict',
        'Backup operation ID already has different inputs.',
      );
    if (!stored) {
      if ((await readdir(root)).length >= 1024)
        throw new CloudError('quota_exceeded', 'Guest backup operation history is full.');
      const disk = await statfs(root);
      if (disk.bavail * disk.bsize < request.limits.maxBytes * 2 + 268_435_456)
        throw new CloudError(
          'quota_exceeded',
          'Insufficient scratch space for the admitted backup operation.',
        );
      await ensureDirectory(directory, 0o700);
      await syncDirectory(root);
      await save(directory, 'request.json', { digest: requestDigest, request });
    }
    return { directory, requestDigest };
  }
  async function inspect(value: string): Promise<{ capture: Capture }> {
    const id = backupIdSchema.parse(value);
    const directory = location('captures', id);
    const result = await optional(join(directory, 'result.json'), backupGuestStateSchema);
    if (result) {
      if (result.kind === 'missing' || result.id !== id)
        throw new Error('Backup result identity differs.');
      return { capture: result };
    }
    const request = await optional(
      join(directory, 'request.json'),
      z.strictObject({
        digest: z.string().regex(/^[a-f0-9]{64}$/),
        request: backupGuestCaptureSchema,
      }),
    );
    return {
      capture: request
        ? { kind: 'pending', id, requestDigest: request.digest }
        : { kind: 'missing' },
    };
  }
  async function source(recipe: CaptureCommand['recipe']) {
    const root = join(input.composeDirectory, recipe.app);
    const head = composeReleaseIdSchema.parse(
      JSON.parse(await readOwnedFile(join(root, 'head.json'), 'private')),
    );
    if (head !== recipe.releaseId)
      throw new CloudError(
        'version_conflict',
        'Backup requires the exact current succeeded Compose release.',
      );
    const releasePath = (id: string) => join(root, 'releases', composeReleaseIdSchema.parse(id));
    const release = composeReleaseSchema.parse(
      JSON.parse(await readOwnedFile(join(releasePath(head), 'state.json'), 'private')),
    );
    if (release.id !== head || release.phase !== 'succeeded')
      throw new CloudError('resource_busy', 'Backup requires a succeeded Compose release.');
    const runtime = await readOwnedFile(
      join(releasePath(head), 'runtime.json'),
      'private',
      16_777_216,
    );
    if (digest(runtime) !== release.configDigest)
      throw new Error('Captured runtime configuration integrity differs.');
    let id = head;
    const seen = new Set<string>();
    for (let depth = 0; depth < 128; depth++) {
      if (seen.has(id)) throw new Error('Captured release source ancestry has a cycle.');
      seen.add(id);
      const state = composeReleaseSchema.parse(
        JSON.parse(await readOwnedFile(join(releasePath(id), 'state.json'), 'private')),
      );
      const request = sourceRequest.parse(
        JSON.parse(
          await readOwnedFile(join(releasePath(id), 'request.json'), 'private', 16_777_216),
        ),
      );
      if (
        state.id !== id ||
        state.phase !== 'succeeded' ||
        request.app !== recipe.app ||
        request.releaseId !== id ||
        digest(JSON.stringify(request)) !== state.requestDigest
      )
        throw new Error('Captured source request integrity differs.');
      if (request.kind === 'apply')
        return {
          request,
          release,
          runtime: join(releasePath(head), 'runtime.json'),
          sourceRoot: join(releasePath(id), 'source'),
          config: composeConfigSchema.parse(
            JSON.parse(
              await readOwnedFile(join(releasePath(id), 'build.json'), 'private', 16_777_216),
            ),
          ),
        };
      id = request.fromReleaseId;
    }
    throw new Error('Captured release source ancestry is too deep.');
  }
  async function container(
    project: string,
    runtime: string,
    service: string,
    budget: BackupBudget,
    image?: string,
  ) {
    const output = await system.docker(
      [
        'compose',
        '--project-name',
        project,
        '--file',
        runtime,
        'ps',
        '--all',
        '--format',
        'json',
        service,
      ],
      { ...budget, maximum: 65_536 },
    );
    const rows = output
      .trim()
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        const value: unknown = JSON.parse(line);
        return Array.isArray(value)
          ? z.array(composePsSchema).parse(value)
          : [composePsSchema.parse(value)];
      });
    if (rows.length !== 1 || rows[0]?.Service !== service || rows[0].State !== 'running')
      throw new CloudError(
        'resource_busy',
        'Backup requires one running PostgreSQL service container.',
      );
    const id = z
      .string()
      .regex(/^[a-f0-9]{12,64}$/)
      .parse(rows[0].ID);
    const inspected = z
      .object({
        Id: z.string().regex(/^[a-f0-9]{64}$/),
        Image: z.string(),
        Config: z.object({ Labels: z.record(z.string(), z.string()) }),
        State: z.object({ Running: z.literal(true) }),
      })
      .parse(
        JSON.parse(
          await system.docker(['inspect', '--format', '{{json .}}', '--', id], {
            ...budget,
            maximum: 1_048_576,
          }),
        ),
      );
    if (
      !inspected.Id.startsWith(id) ||
      inspected.Config.Labels['com.docker.compose.project'] !== project ||
      inspected.Config.Labels['com.docker.compose.service'] !== service ||
      (image !== undefined && inspected.Image !== image)
    )
      throw new Error('PostgreSQL container does not match the captured managed release.');
    return inspected.Id;
  }
  async function capture(value: CaptureCommand): Promise<{ capture: Capture }> {
    const request = backupGuestCaptureSchema.parse(value);
    if (new Set(request.recipe.files).size !== request.recipe.files.length)
      throw new CloudError('invalid_input', 'Declared backup files must be unique.');
    const { directory } = await admit('captures', request.id, request);
    const previous = await inspect(request.id);
    if (previous.capture.kind !== 'pending') return previous;
    const failed = (reason: string): Capture => ({ kind: 'failed', id: request.id, reason });
    if (
      await optional(join(directory, 'started.json'), z.object({ startedAt: z.iso.datetime() }))
    ) {
      const result = failed('Capture was interrupted; create a new backup ID.');
      await save(directory, 'result.json', result);
      return { capture: result };
    }
    const budget = {
      maximum: request.limits.maxBytes,
      signal: AbortSignal.timeout(request.limits.timeoutSeconds * 1000),
    };
    const work = join(directory, 'work');
    const capturedAt = new Date().toISOString();
    await save(directory, 'started.json', { startedAt: capturedAt });
    try {
      await ensureDirectory(work, 0o700);
      await syncDirectory(directory);
      const deployment = await source(request.recipe);
      // Prove that the captured recipe can be rebased before copying database bytes.
      const normalized = isolatedBackupConfig(deployment.config, {
        sourceRoot: deployment.sourceRoot,
        customerRoot: input.customerDirectory,
        filesRoot: join(input.customerDirectory, 'restores', request.id),
        declared: request.recipe.files,
        databaseService: request.recipe.service,
      });
      if (
        deployment.request.files.length >= 1024 ||
        deployment.request.files.reduce((total, file) => total + file.content.length, 0) +
          (Buffer.byteLength(JSON.stringify(normalized), 'utf8') * 4) / 3 >
          11_184_000
      )
        throw new CloudError(
          'quota_exceeded',
          'Captured source leaves insufficient room for an isolated restore configuration.',
        );
      const files: z.infer<typeof metadataSchema>['files'] = [];
      const entries: Array<{ name: string; path: string }> = [];
      let copied = 0;
      for (const [index, relative] of request.recipe.files.entries()) {
        const path = await customerFile(input.customerDirectory, relative);
        const handle = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const info = await handle.stat();
          if (!info.isFile())
            throw new CloudError('invalid_input', 'Declared backup entries must be regular files.');
          const name = `file-${index}`;
          const destination = join(work, name);
          copied += (
            await writeBackupStream(destination, readBackupHandle(handle, budget.signal), {
              ...budget,
              maximum: budget.maximum - copied,
            })
          ).bytes;
          entries.push({ name, path: destination });
          files.push({
            path: relative,
            entry: name,
            mode: info.mode & 0o777,
            uid: info.uid,
            gid: info.gid,
          });
        } finally {
          await handle.close();
        }
      }
      const image = z
        .string()
        .regex(/^sha256:[a-f0-9]{64}$/)
        .parse(deployment.release.images[request.recipe.service]);
      const id = await container(
        `acld-${request.recipe.app}`,
        deployment.runtime,
        request.recipe.service,
        budget,
        image,
      );
      const version = await postgresVersion(system, id, request.recipe, budget);
      const globalsPath = join(work, 'globals.sql');
      await system.docker(
        postgresCommand(id, [
          'pg_dumpall',
          '--globals-only',
          '--no-tablespaces',
          '--no-password',
          '--username',
          request.recipe.user,
          '--database',
          request.recipe.database,
        ]),
        {
          ...budget,
          maximum: Math.min(16_777_216, budget.maximum - copied),
          outputFile: globalsPath,
        },
      );
      copied += (await lstat(globalsPath)).size;
      const databasePath = join(work, 'database.dump');
      await system.docker(
        postgresCommand(id, [
          'pg_dump',
          '--format=custom',
          '--no-tablespaces',
          '--no-password',
          '--username',
          request.recipe.user,
          '--dbname',
          request.recipe.database,
        ]),
        { ...budget, maximum: budget.maximum - copied, outputFile: databasePath },
      );
      await checkDump(databasePath);
      const manifest = backupCaptureManifestSchema.parse({
        version: 1,
        recipe: request.recipe,
        capturedAt,
        completedAt: new Date().toISOString(),
        postgresVersion: version,
        sourceFiles: deployment.request.files.length,
        declaredFiles: request.recipe.files,
        consistency: 'database-consistent-files-best-effort',
        exclusions: [
          'Other databases, tablespaces, replication slots and undeclared files are excluded.',
          'Files and role globals are captured separately from the database snapshot.',
          'Images must remain buildable or pullable from captured Compose source.',
          'File ACLs, extended attributes and filesystem snapshots are not captured.',
        ],
      });
      const metadata = metadataSchema.parse({
        version: 1,
        backupId: request.id,
        manifest,
        source: deployment.request,
        config: deployment.config,
        sourceRoot: deployment.sourceRoot,
        customerRoot: input.customerDirectory,
        files,
      });
      const text = JSON.stringify(metadata) + '\n';
      if (Buffer.byteLength(text) > metadataMaximum)
        throw new CloudError('quota_exceeded', 'Backup source metadata exceeds its limit.');
      await atomicWrite(join(work, 'metadata.json'), text, 0o600);
      const archive = join(directory, 'archive.next');
      const artifact = await packBackup(
        archive,
        [
          { name: 'metadata.json', path: join(work, 'metadata.json') },
          { name: 'globals.sql', path: globalsPath },
          { name: 'database.dump', path: databasePath },
          ...entries,
        ],
        budget,
      );
      await rename(archive, join(directory, 'archive.tar'));
      await syncDirectory(directory);
      const result = backupGuestStateSchema.parse({
        kind: 'captured',
        id: request.id,
        manifest,
        ...artifact,
      });
      await save(directory, 'result.json', result);
      await rm(work, { recursive: true, force: true });
      return { capture: result };
    } catch (error) {
      const result = failed(
        error instanceof CloudError
          ? error.failure.message.slice(0, 256)
          : 'Capture failed or exceeded its time limit; use a new backup ID after inspection.',
      );
      await save(directory, 'result.json', result);
      await rm(work, { recursive: true, force: true });
      await rm(join(directory, 'archive.next'), { force: true });
      return { capture: result };
    }
  }
  async function read(value: string) {
    const id = backupIdSchema.parse(value);
    const { capture } = await inspect(id);
    if (capture.kind !== 'captured')
      throw new CloudError('not_found', 'Captured backup artifact is unavailable.');
    const path = join(location('captures', id), 'archive.tar');
    const integrity = await hashBackupFile(path, {
      maximum: capture.bytes,
      signal: AbortSignal.timeout(900_000),
    });
    if (integrity.bytes !== capture.bytes || integrity.sha256 !== capture.sha256)
      throw new Error('Captured backup integrity differs.');
    return { path, capture };
  }
  async function remove(value: string): Promise<{ capture: Capture }> {
    const id = backupIdSchema.parse(value);
    const previous = await inspect(id);
    if (previous.capture.kind === 'missing') return previous;
    const directory = location('captures', id);
    const result: Capture = { kind: 'failed', id, reason: 'Guest backup staging was removed.' };
    await save(directory, 'result.json', result);
    await rm(join(directory, 'archive.tar'), { force: true });
    await rm(join(directory, 'archive.next'), { force: true });
    await rm(join(directory, 'work'), { recursive: true, force: true });
    await syncDirectory(directory);
    return { capture: result };
  }
  async function inspectRestore(value: string): Promise<Restore | null> {
    const id = restoreIdSchema.parse(value);
    const directory = location('restores', id);
    const result = await optional(join(directory, 'result.json'), restoreGuestStateSchema);
    if (result && result.id !== id) throw new Error('Restore result identity differs.');
    if (result) return result;
    return (await optional(join(directory, 'request.json'), z.unknown()))
      ? { kind: 'pending', id }
      : null;
  }
  async function restore(value: RestoreGuestRequest, stream: Readable): Promise<Restore> {
    const request = restoreGuestRequestSchema.parse(value);
    if (request.bytes > request.limits.maxBytes)
      throw new CloudError('quota_exceeded', 'Restore archive exceeds its admitted byte limit.');
    const { directory } = await admit('restores', request.id, request);
    const previous = await inspectRestore(request.id);
    if (previous && previous.kind !== 'pending') {
      stream.destroy();
      return previous;
    }
    const failed = (reason: string): Restore => ({ kind: 'failed', id: request.id, reason });
    if (
      await optional(join(directory, 'started.json'), z.object({ startedAt: z.iso.datetime() }))
    ) {
      stream.destroy();
      const result = failed(
        'Restore was interrupted; preserve this target and use a new empty app or VM.',
      );
      await save(directory, 'result.json', result);
      return result;
    }
    const budget = {
      maximum: request.limits.maxBytes,
      signal: AbortSignal.timeout(request.limits.timeoutSeconds * 1000),
    };
    addAbortSignal(budget.signal, stream);
    const work = join(directory, 'work');
    await save(directory, 'started.json', { startedAt: new Date().toISOString() });
    try {
      const project = `acld-${request.app}`;
      if (await optional(join(input.composeDirectory, request.app, 'head.json'), z.unknown()))
        throw new CloudError('version_conflict', 'Restore requires an empty managed app.');
      // work() visits every app. Holding both Compose locks keeps this check stable until it ends.
      const observer = createComposeDeployments({
        directory: input.composeDirectory,
        system: backupComposeSystem(system, budget),
      });
      const apps = await readdir(input.composeDirectory).catch((error: unknown) => {
        if (isMissing(error)) return [];
        throw error;
      });
      for (const app of apps) {
        if (!composeAppSchema.safeParse(app).success) continue;
        const current = await observer.current(app);
        if (current && !['succeeded', 'failed', 'interrupted'].includes(current.phase))
          throw new CloudError(
            'resource_busy',
            'Restore requires other managed app deployments to finish first.',
          );
      }
      for (const args of [
        ['ps', '--all', '--quiet', '--filter', `label=com.docker.compose.project=${project}`],
        ['volume', 'ls', '--quiet', '--filter', `name=^${project}_`],
        ['network', 'ls', '--quiet', '--filter', `name=^${project}_`],
      ])
        if ((await system.docker(args, { ...budget, maximum: 65_536 })).trim())
          throw new CloudError(
            'version_conflict',
            'Restore requires an unused Compose project with no existing containers, volumes or networks.',
          );
      await ensureDirectory(work, 0o700);
      await syncDirectory(directory);
      const archive = join(work, 'archive.tar');
      const received = await writeBackupStream(archive, stream, {
        ...budget,
        maximum: request.bytes,
      });
      if (received.bytes !== request.bytes || received.sha256 !== request.sha256)
        throw new CloudError('invalid_input', 'Restore archive length or checksum differs.');
      const entries = await unpackBackup(archive, work, budget);
      const metadata = metadataSchema.parse(
        JSON.parse(await readOwnedFile(join(work, 'metadata.json'), 'private', metadataMaximum)),
      );
      if (
        metadata.backupId !== request.backupId ||
        metadata.manifest.sourceFiles !== metadata.source.files.length ||
        JSON.stringify(metadata.manifest.declaredFiles) !==
          JSON.stringify(metadata.files.map((file) => file.path)) ||
        JSON.stringify(metadata.manifest.recipe.files) !==
          JSON.stringify(metadata.manifest.declaredFiles)
      )
        throw new CloudError(
          'invalid_input',
          'Restore metadata differs from the requested backup.',
        );
      const expected = new Set([
        'metadata.json',
        'globals.sql',
        'database.dump',
        ...metadata.files.map((file) => file.entry),
      ]);
      if (
        expected.size !== 3 + metadata.files.length ||
        new Set(metadata.files.map((file) => file.path)).size !== metadata.files.length ||
        entries.size !== expected.size ||
        [...entries].some((entry) => !expected.has(entry))
      )
        throw new CloudError('invalid_input', 'Restore archive entries differ from its manifest.');
      await checkDump(join(work, 'database.dump'));
      const filesParent = join(input.customerDirectory, 'restores');
      // Customers can traverse the shared parent; each restore stays private until publication.
      await ensureDirectory(filesParent, 0o755);
      await syncDirectory(input.customerDirectory);
      const filesRoot = join(filesParent, request.id);
      await ensureDirectory(filesRoot, 0o700);
      await syncDirectory(filesParent);
      for (const file of metadata.files) {
        const path = await customerFile(filesRoot, file.path, true);
        const source = await open(
          join(work, file.entry),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          await writeBackupStream(path, readBackupHandle(source, budget.signal), budget);
        } finally {
          await source.close();
        }
        await chmod(path, file.mode);
        await chown(path, file.uid, file.gid);
        const published = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          await published.sync();
        } finally {
          await published.close();
        }
        // customerFile returns a canonical path, which may differ from /var aliases.
        // Count validated components so publication never changes an ancestor outside this restore.
        let parent = dirname(path);
        for (let depth = 0; depth < file.path.split('/').length; depth++) {
          await chmod(parent, 0o755);
          await syncDirectory(parent);
          parent = dirname(parent);
        }
      }
      const config = isolatedBackupConfig(metadata.config, {
        sourceRoot: metadata.sourceRoot,
        customerRoot: metadata.customerRoot,
        filesRoot,
        declared: metadata.manifest.declaredFiles,
        databaseService: metadata.manifest.recipe.service,
      });
      const filename = `restore-${request.id}.json`;
      if (metadata.source.files.some((file) => file.path === filename))
        throw new CloudError(
          'invalid_input',
          'Restore configuration path collides with captured source.',
        );
      const releaseId = composeReleaseIdSchema.parse(request.id);
      const command = composeApplySchema.parse({
        kind: 'apply',
        app: request.app,
        releaseId,
        expectedReleaseId: null,
        file: filename,
        files: [
          ...metadata.source.files,
          {
            path: filename,
            content: Buffer.from(JSON.stringify(config)).toString('base64'),
            executable: false,
          },
        ],
        waitSeconds: Math.min(300, request.limits.timeoutSeconds),
      });
      const compose = backupComposeSystem(system, budget);
      let restoredVersion: string | undefined;
      const deployment = createComposeDeployments({
        directory: input.composeDirectory,
        system: {
          ...compose,
          compose: async (projectName, file, args) => {
            if (projectName !== project)
              throw new Error('Restore must only operate its isolated Compose project.');
            if (args[0] !== 'up') return compose.compose(projectName, file, args);
            const runtime = composeConfigSchema.parse(
              JSON.parse(await readOwnedFile(file, 'private', 16_777_216)),
            );
            const recipe = metadata.manifest.recipe;
            const database = runtime.services[recipe.service];
            if (!database) throw new Error('Restore database service is missing.');
            const environment = z
              .record(z.string(), z.unknown())
              .parse(database['environment'] ?? {});
            const data = z.string().parse(environment['PGDATA'] ?? '/var/lib/postgresql/data');
            if (
              posix.normalize(data) !== data ||
              !(data === '/var/lib/postgresql/data' || data.startsWith('/var/lib/postgresql/data/'))
            )
              throw new CloudError(
                'invalid_input',
                'Restore PostgreSQL data must stay inside its isolated named volume.',
              );
            const bootstrapUser = `acld_restore_${request.id.replaceAll('-', '')}`;
            const bootstrapDb = bootstrapUser;
            const bootstrap = structuredClone(runtime);
            bootstrap.services = {
              [recipe.service]: {
                image: database.image,
                volumes: database.volumes?.filter(
                  (volume) => volume.target === '/var/lib/postgresql/data',
                ),
                environment: {
                  POSTGRES_USER: bootstrapUser,
                  POSTGRES_DB: bootstrapDb,
                  POSTGRES_PASSWORD: randomBytes(32).toString('base64url'),
                  PGDATA: data,
                },
                entrypoint: ['docker-entrypoint.sh'],
                command: ['postgres'],
                networks: ['default'],
                healthcheck: {
                  test: ['CMD-SHELL', `pg_isready -U ${bootstrapUser} -d ${bootstrapDb}`],
                  interval: '1s',
                  timeout: '3s',
                  retries: 30,
                },
                restart: 'no',
              },
            };
            const temporary = join(work, 'bootstrap.compose.json');
            await atomicWrite(temporary, JSON.stringify(bootstrap) + '\n', 0o600);
            await compose.compose(projectName, temporary, [
              'up',
              '--detach',
              '--wait',
              '--wait-timeout',
              '60',
              '--no-build',
              '--pull',
              'never',
              recipe.service,
            ]);
            const id = await container(
              projectName,
              temporary,
              recipe.service,
              budget,
              database.image,
            );
            restoredVersion = await postgresVersion(
              system,
              id,
              { user: bootstrapUser, database: bootstrapDb },
              budget,
            );
            await system.docker(
              postgresCommand(
                id,
                [
                  'psql',
                  '--no-psqlrc',
                  '--no-password',
                  '--set',
                  'ON_ERROR_STOP=1',
                  '--username',
                  bootstrapUser,
                  '--dbname',
                  bootstrapDb,
                ],
                true,
              ),
              { ...budget, maximum: 65_536, inputFile: join(work, 'globals.sql') },
            );
            await system.docker(
              postgresCommand(
                id,
                [
                  'pg_restore',
                  '--no-password',
                  '--exit-on-error',
                  '--clean',
                  '--if-exists',
                  '--create',
                  '--no-tablespaces',
                  '--username',
                  bootstrapUser,
                  '--dbname',
                  bootstrapDb,
                ],
                true,
              ),
              { ...budget, maximum: 65_536, inputFile: join(work, 'database.dump') },
            );
            await compose.compose(projectName, temporary, [
              'stop',
              '--timeout',
              '30',
              recipe.service,
            ]);
            await compose.compose(projectName, temporary, ['rm', '--force', recipe.service]);
            return compose.compose(projectName, file, args);
          },
        },
      });
      await deployment.command(command);
      await deployment.work();
      const release = await deployment.current(request.app);
      if (release?.id !== releaseId || release.phase !== 'succeeded' || !restoredVersion)
        throw new Error('Restored database or application services did not become healthy.');
      const result = restoreGuestStateSchema.parse({
        kind: 'restored',
        id: request.id,
        app: request.app,
        releaseId,
        postgresVersion: restoredVersion,
        integrity: 'database-restored-services-healthy',
      });
      await save(directory, 'result.json', result);
      await rm(work, { recursive: true, force: true });
      return result;
    } catch (error) {
      stream.destroy();
      const result = failed(
        error instanceof CloudError
          ? error.failure.message.slice(0, 256)
          : 'Restore failed or was interrupted; preserve this isolated target for inspection.',
      );
      await save(directory, 'result.json', result);
      await rm(work, { recursive: true, force: true });
      return result;
    }
  }
  return { capture, inspect, read, remove, restore, inspectRestore };
}

async function checkDump(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const header = Buffer.alloc(5);
    const { bytesRead } = await file.read(header, 0, 5, 0);
    if (bytesRead !== 5 || header.toString('ascii') !== 'PGDMP')
      throw new CloudError('invalid_input', 'Backup requires a PostgreSQL custom-format dump.');
  } finally {
    await file.close();
  }
}

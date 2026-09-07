import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { CloudError, type BackupRecipe } from '@agent-cloud/contracts';
import { composeConfigSchema, type ComposeSystem } from './compose-system.js';
import { readBackupStream, writeBackupStream, type BackupBudget } from './backup-archive.js';

export type BackupSystem = {
  docker: (
    args: string[],
    options: BackupBudget & { inputFile?: string; outputFile?: string },
  ) => Promise<string>;
};

/** Fixed Docker argv only. Child output, SQL and secrets never enter guest service diagnostics. */
export const backupSystem: BackupSystem = {
  async docker(args, options) {
    options.signal.throwIfAborted();
    const child = spawn('/usr/bin/docker', args, {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: '/root',
        DOCKER_CONFIG: '/root/.docker',
        LANG: 'C',
        COMPOSE_ANSI: 'never',
        COMPOSE_PARALLEL_LIMIT: '2',
      },
    });
    const stop = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
        }
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    };
    options.signal.addEventListener('abort', stop, { once: true });
    let diagnosticBytes = 0;
    child.stderr.on('data', (chunk: Buffer) => {
      diagnosticBytes += chunk.length;
      if (diagnosticBytes > 65_536) stop();
    });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    const incoming = options.inputFile
      ? pipeline(readBackupStream(options.inputFile, options.signal), child.stdin)
      : Promise.resolve(child.stdin.end());
    const output = (async () => {
      if (options.outputFile) {
        await writeBackupStream(options.outputFile, child.stdout, options);
        return '';
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const value of child.stdout) {
        if (!Buffer.isBuffer(value) || (bytes += value.length) > options.maximum)
          throw new Error('Backup command output exceeds its limit.');
        chunks.push(value);
      }
      return Buffer.concat(chunks).toString('utf8');
    })();
    try {
      const values = await Promise.all([closed, incoming, output]);
      if (values[0] !== 0 || diagnosticBytes > 65_536 || options.signal.aborted)
        throw new Error('Backup command did not complete.');
      return values[2];
    } catch {
      stop();
      await Promise.allSettled([closed, incoming, output]);
      throw new CloudError(
        'provider_rejected',
        'Backup database or container operation failed. Inspect the isolated guest operation.',
        false,
      );
    } finally {
      options.signal.removeEventListener('abort', stop);
    }
  },
};

export function backupComposeSystem(system: BackupSystem, budget: BackupBudget): ComposeSystem {
  return {
    start: async () => {},
    compose: (project, file, args) =>
      system.docker(['compose', '--project-name', project, '--file', file, ...args], {
        ...budget,
        maximum: 16_777_216,
      }),
    imageId: async (image) =>
      z
        .string()
        .regex(/^sha256:[a-f0-9]{64}$/)
        .parse(
          (
            await system.docker(['image', 'inspect', '--format', '{{.Id}}', '--', image], {
              ...budget,
              maximum: 4096,
            })
          ).trim(),
        ),
    imageVolumes: async (image) =>
      Object.keys(
        z
          .record(z.string(), z.unknown())
          .nullable()
          .parse(
            JSON.parse(
              await system.docker(
                ['image', 'inspect', '--format', '{{json .Config.Volumes}}', '--', image],
                { ...budget, maximum: 65_536 },
              ),
            ),
          ) ?? {},
      ),
  };
}

const pgEnvironment =
  'if [ -n "${POSTGRES_PASSWORD_FILE:-}" ]; then PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; else PGPASSWORD="${POSTGRES_PASSWORD:-${PGPASSWORD:-}}"; fi; export PGPASSWORD; exec "$@"';
export const postgresCommand = (container: string, args: string[], stdin = false) => [
  'exec',
  ...(stdin ? ['-i'] : []),
  container,
  '/bin/sh',
  '-c',
  pgEnvironment,
  '--',
  ...args,
];
export async function postgresVersion(
  system: BackupSystem,
  container: string,
  recipe: Pick<BackupRecipe, 'user' | 'database'>,
  budget: BackupBudget,
) {
  const server = (
    await system.docker(
      postgresCommand(container, [
        'psql',
        '--no-psqlrc',
        '--no-password',
        '--tuples-only',
        '--no-align',
        '--set',
        'ON_ERROR_STOP=1',
        '--username',
        recipe.user,
        '--dbname',
        recipe.database,
        '--command',
        'SHOW server_version_num',
      ]),
      { ...budget, maximum: 4096 },
    )
  ).trim();
  if (!/^17[0-9]{4}$/.test(server))
    throw new CloudError('invalid_input', 'This backup recipe requires a PostgreSQL 17 server.');
  let version = '';
  for (const tool of ['pg_dump', 'pg_dumpall', 'pg_restore']) {
    const text = (
      await system.docker(['exec', container, tool, '--version'], { ...budget, maximum: 4096 })
    ).trim();
    if (!new RegExp(`^${tool} \\(PostgreSQL\\) 17(?:[. ][^\\r\\n]*)?$`).test(text))
      throw new CloudError(
        'invalid_input',
        'Backup tools must be PostgreSQL 17 from the recipe container.',
      );
    if (tool === 'pg_dump') version = text;
  }
  return `${version}; server ${server}`;
}

/** Rebase captured configuration into a new project; it cannot attach production volumes. */
export function isolatedBackupConfig(
  value: unknown,
  input: {
    sourceRoot: string;
    customerRoot: string;
    filesRoot: string;
    declared: string[];
    databaseService: string;
  },
) {
  const config = composeConfigSchema.parse(structuredClone(value));
  const rebase = (path: string) => {
    const absolute = resolve(path);
    if (absolute === input.sourceRoot || absolute.startsWith(input.sourceRoot + sep))
      return `./${relative(input.sourceRoot, absolute)}`;
    if (absolute === input.customerRoot || absolute.startsWith(input.customerRoot + sep)) {
      const name = relative(input.customerRoot, absolute);
      if (!input.declared.some((file) => !name || file === name || file.startsWith(name + '/')))
        throw new CloudError(
          'invalid_input',
          'Restore bind mounts require explicitly captured customer files.',
        );
      return resolve(input.filesRoot, name);
    }
    throw new CloudError(
      'invalid_input',
      'Restore cannot use a bind or build path outside captured source and declared files.',
    );
  };
  const volumes = z
    .record(z.string(), z.record(z.string(), z.unknown()).nullable())
    .parse(config['volumes'] ?? {});
  for (const volume of Object.values(volumes)) {
    if (
      volume &&
      (volume['external'] ||
        volume['driver_opts'] ||
        (volume['driver'] && volume['driver'] !== 'local'))
    )
      throw new CloudError(
        'invalid_input',
        'Restore requires project-owned local volumes without external paths.',
      );
    if (volume) delete volume['name'];
  }
  config['volumes'] = volumes;
  const originalNetworks = z
    .record(z.string(), z.record(z.string(), z.unknown()).nullable())
    .parse(config['networks'] ?? {});
  if (
    Object.values(originalNetworks).some(
      (network) => network?.['external'] || (network?.['driver'] && network['driver'] !== 'bridge'),
    )
  )
    throw new CloudError('invalid_input', 'Restore cannot attach an external or host network.');
  config['networks'] = { default: { internal: true } };
  for (const name of ['configs', 'secrets']) {
    const resources = z
      .record(z.string(), z.record(z.string(), z.unknown()))
      .parse(config[name] ?? {});
    for (const resource of Object.values(resources)) {
      if (resource['external'])
        throw new CloudError(
          'invalid_input',
          'Restore cannot use external configuration or secrets.',
        );
      if (resource['file']) resource['file'] = rebase(z.string().parse(resource['file']));
      delete resource['name'];
    }
    if (Object.keys(resources).length) config[name] = resources;
  }
  for (const [name, service] of Object.entries(config.services)) {
    for (const key of [
      'privileged',
      'network_mode',
      'pid',
      'ipc',
      'uts',
      'devices',
      'device_cgroup_rules',
      'volumes_from',
      'external_links',
      'cap_add',
      'use_api_socket',
      'extra_hosts',
    ])
      if (service[key])
        throw new CloudError(
          'invalid_input',
          'Restore does not allow host access or privileged Compose services.',
        );
    delete service['container_name'];
    delete service['env_file']; // Compose config already materialized the captured environment.
    service['networks'] = ['default'];
    for (const volume of service.volumes ?? []) {
      if (volume.type === 'bind' && volume.source) volume.source = rebase(volume.source);
      else if (volume.type !== 'volume' || !volume.source)
        throw new CloudError(
          'invalid_input',
          'Restore requires named persistent volumes or captured regular-file binds.',
        );
    }
    if (service.build !== undefined) {
      const build = z.record(z.string(), z.unknown()).parse(service.build);
      if (build['additional_contexts'] || build['ssh'] || build['network'] === 'host')
        throw new CloudError(
          'invalid_input',
          'Restore does not support external build contexts or host build access.',
        );
      const context = z.string().parse(build['context']);
      build['context'] = rebase(context);
      if (build['dockerfile'] && isAbsolute(z.string().parse(build['dockerfile']))) {
        rebase(z.string().parse(build['dockerfile']));
        build['dockerfile'] = relative(context, z.string().parse(build['dockerfile']));
      }
      service.build = build;
    }
    if (service['ports']) {
      service['ports'] = z
        .array(z.record(z.string(), z.unknown()))
        .parse(service['ports'])
        .map((port) => ({ ...port, host_ip: '127.0.0.1' }));
    }
    if (
      name === input.databaseService &&
      !(service.volumes ?? []).some(
        (volume) =>
          volume.type === 'volume' && volume.source && volume.target === '/var/lib/postgresql/data',
      )
    )
      throw new CloudError(
        'invalid_input',
        'PostgreSQL restore requires its explicit named /var/lib/postgresql/data volume.',
      );
  }
  if (!config.services[input.databaseService])
    throw new CloudError('invalid_input', 'Captured database service is missing.');
  delete config['name'];
  return config;
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { CloudError } from '@agent-cloud/contracts';

export type ComposeSystem = {
  start: () => Promise<void>;
  compose: (project: string, file: string, args: string[]) => Promise<string>;
  imageId: (image: string) => Promise<string>;
  imageVolumes: (image: string) => Promise<string[]>;
};
export const composeSystem: ComposeSystem = {
  start: async () => {
    await promisify(execFile)(
      '/usr/bin/systemctl',
      ['start', '--no-block', 'agent-cloud-compose.service'],
      { timeout: 5000, maxBuffer: 4096 },
    );
  },
  compose: async (project, file, args) => {
    try {
      return (
        await promisify(execFile)(
          '/usr/bin/docker',
          ['compose', '--project-name', project, '--file', file, ...args],
          {
            env: {
              PATH: '/usr/local/bin:/usr/bin:/bin',
              LANG: 'C',
              DOCKER_CONFIG: '/root/.docker',
              COMPOSE_ANSI: 'never',
              COMPOSE_PARALLEL_LIMIT: '2',
            },
            timeout: 720_000,
            killSignal: 'SIGKILL',
            maxBuffer: 16_777_216,
          },
        )
      ).stdout;
    } catch {
      // Compose diagnostics can contain interpolated secrets. Only explicit logs
      // requests return customer output; service logs never receive it.
      throw new CloudError(
        'provider_rejected',
        'Compose operation failed. Inspect the release, application logs and saved configuration on the machine.',
      );
    }
  },
  imageId: async (image) => {
    try {
      const result = await promisify(execFile)(
        '/usr/bin/docker',
        ['image', 'inspect', '--format', '{{.Id}}', '--', image],
        { timeout: 15_000, maxBuffer: 4096 },
      );
      return z
        .string()
        .regex(/^sha256:[a-f0-9]{64}$/)
        .parse(result.stdout.trim());
    } catch {
      throw new CloudError('provider_rejected', 'A release image is unavailable on this machine.');
    }
  },
  imageVolumes: async (image) => {
    const result = await promisify(execFile)(
      '/usr/bin/docker',
      ['image', 'inspect', '--format', '{{json .Config.Volumes}}', '--', image],
      { timeout: 15_000, maxBuffer: 65_536 },
    );
    const volumes = z.record(z.string(), z.unknown()).nullable().parse(JSON.parse(result.stdout));
    return Object.keys(volumes ?? {});
  },
};

const volume = z.looseObject({
  type: z.string(),
  target: z.string(),
  source: z.string().optional(),
  read_only: z.boolean().optional(),
});
export const composeConfigSchema = z.looseObject({
  services: z
    .record(
      z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),
      z.looseObject({
        image: z.string().optional(),
        build: z.unknown().optional(),
        volumes: z.array(volume).optional(),
      }),
    )
    .refine((services) => Object.keys(services).length > 0 && Object.keys(services).length <= 32),
});
export const composePsSchema = z.object({
  ID: z.string(),
  Service: z.string(),
  State: z.string(),
  Health: z.string().default(''),
  ExitCode: z.int(),
});

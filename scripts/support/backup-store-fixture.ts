import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import type { Connection } from '../../packages/db/src/index.js';
import type { MachineProvider } from '../../packages/contracts/dist/index.js';
import type { Signer } from '../../packages/pki/dist/index.js';
import { createBackupRuntime } from '../../apps/control/src/backup-runtime.js';

const image = 'minio/minio@sha256:d249d1fb6966de4d8ad26c04754b545205ff15a62e4fd19ebd0f26fa5baacbc0';

/** A loopback-only S3 fixture for the native customer scenario. No provider resources or persistent bucket. */
export async function prepareBackupStoreFixture(input: {
  connection: Connection;
  provider: MachineProvider;
  signer: Signer;
  scratch: string;
}) {
  const id = randomUUID();
  const name = `agent-cloud-backup-${id.slice(0, 8)}`;
  const ownership = resolve(`.local/backup-store-${id}.json`);
  const directory = join(input.scratch, 'backup-store');
  await mkdir(directory, { mode: 0o700 });
  const administrator = {
    accessKeyId: 'fixture-administrator',
    secretAccessKey: randomBytes(32).toString('hex'),
  };
  const writer = {
    accessKeyId: 'fixture-writer',
    secretAccessKey: randomBytes(32).toString('hex'),
  };
  const reader = {
    accessKeyId: 'fixture-reader',
    secretAccessKey: randomBytes(32).toString('hex'),
  };
  const bucket = 'protected-backups';
  let container: string | undefined;
  let runtime: Awaited<ReturnType<typeof createBackupRuntime>> | undefined;
  async function docker(args: string[]) {
    try {
      return (
        await promisify(execFile)('docker', args, { timeout: 30_000, maxBuffer: 16_384 })
      ).stdout.trim();
    } catch {
      throw new Error('Owned backup S3 fixture command failed; inspect its ownership record.');
    }
  }
  async function stop() {
    await runtime?.close();
    if (container) {
      const actual = z
        .array(
          z.object({
            Id: z.literal(container),
            Name: z.literal(`/${name}`),
            Config: z.object({ Image: z.literal(image), Labels: z.record(z.string(), z.string()) }),
          }),
        )
        .parse(JSON.parse(await docker(['inspect', container])));
      if (actual.length !== 1 || actual[0]?.Config.Labels['agent-cloud.backup-fixture'] !== id)
        throw new Error('Backup S3 fixture ownership mismatch.');
      await docker(['rm', '--force', container]);
      container = undefined;
    }
    await rm(ownership, { force: true });
  }
  try {
    const environment = join(directory, 'environment');
    await writeFile(
      environment,
      `MINIO_ROOT_USER=${administrator.accessKeyId}\nMINIO_ROOT_PASSWORD=${administrator.secretAccessKey}\nMINIO_BROWSER=off\nMINIO_UPDATE=off\nMINIO_CONFIG_DIR=/tmp/minio\n`,
      { mode: 0o600 },
    );
    await writeFile(
      ownership,
      JSON.stringify({ purpose: 'agent-cloud-native-backup-store', id, name, image }) + '\n',
      { mode: 0o600, flag: 'wx' },
    );
    container = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(
        await docker([
          'create',
          '--name',
          name,
          '--label',
          `agent-cloud.backup-fixture=${id}`,
          '--publish',
          '127.0.0.1::9000',
          '--memory',
          '512m',
          '--cpus',
          '1',
          '--pids-limit',
          '128',
          '--read-only',
          '--tmpfs',
          '/data:size=256m',
          '--tmpfs',
          '/tmp:size=32m',
          '--mount',
          `type=bind,source=${directory},target=/fixture,readonly`,
          '--env-file',
          environment,
          image,
          'server',
          '/data',
          '--address',
          ':9000',
        ]),
      );
    await writeFile(
      ownership,
      JSON.stringify({ purpose: 'agent-cloud-native-backup-store', id, name, image, container }) +
        '\n',
      { mode: 0o600 },
    );
    await docker(['start', container]);
    const owned = container;
    const mc = (args: string[]) =>
      docker(['exec', owned, 'mc', '--config-dir', '/tmp/mc', ...args]);
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      ready = await mc([
        'alias',
        'set',
        'fixture',
        'http://127.0.0.1:9000',
        administrator.accessKeyId,
        administrator.secretAccessKey,
      ]).then(
        () => true,
        () => false,
      );
      if (ready) break;
      await setTimeout(100);
    }
    if (!ready) throw new Error('Owned backup S3 fixture did not become ready.');
    await mc(['mb', '--with-lock', `fixture/${bucket}`]);
    for (const [role, identity] of [
      ['writer', writer],
      ['reader', reader],
    ] satisfies Array<[string, typeof writer]>) {
      const policy = {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: [
              's3:GetBucketVersioning',
              's3:GetBucketObjectLockConfiguration',
              ...(role === 'writer' ? ['s3:ListBucketVersions'] : []),
            ],
            Resource: [`arn:aws:s3:::${bucket}`],
          },
          {
            Effect: 'Allow',
            Action: [
              's3:GetObjectVersion',
              's3:GetObjectRetention',
              ...(role === 'writer' ? ['s3:PutObject', 's3:PutObjectRetention'] : []),
            ],
            Resource: [`arn:aws:s3:::${bucket}/protected/*`],
          },
        ],
      };
      await writeFile(join(directory, `${role}-policy.json`), JSON.stringify(policy), {
        mode: 0o600,
      });
      await writeFile(join(directory, `${role}-credentials.json`), JSON.stringify(identity), {
        mode: 0o600,
      });
      await mc(['admin', 'user', 'add', 'fixture', identity.accessKeyId, identity.secretAccessKey]);
      await mc(['admin', 'policy', 'create', 'fixture', role, `/fixture/${role}-policy.json`]);
      await mc(['admin', 'policy', 'attach', 'fixture', role, '--user', identity.accessKeyId]);
    }
    const mapping = await docker(['port', container, '9000/tcp']);
    const port = z.coerce
      .number()
      .int()
      .positive()
      .max(65535)
      .parse(/^127\.0\.0\.1:(\d+)$/.exec(mapping)?.[1]);
    const configFile = join(directory, 'control.json');
    const keyringFile = join(directory, 'keyring.json');
    await writeFile(
      keyringFile,
      JSON.stringify({ current: 'v1', keys: { v1: randomBytes(32).toString('base64') } }),
      { mode: 0o600 },
    );
    await writeFile(
      configFile,
      JSON.stringify({
        version: 1,
        directory: join(directory, 'scratch'),
        store: {
          endpoint: `http://127.0.0.1:${port}`,
          region: 'us-east-1',
          bucket,
          keyPrefix: 'protected',
          maxBytes: 67_108_864,
          requestTimeoutMs: 120_000,
        },
        writerCredentialsFile: join(directory, 'writer-credentials.json'),
        readerCredentialsFile: join(directory, 'reader-credentials.json'),
        keyringFile,
        retentionDays: 1,
        retentionMode: 'COMPLIANCE',
        limits: { maxBytes: 67_108_864, timeoutSeconds: 900 },
        maxAccountBytes: 268_435_456,
        maxGlobalBytes: 268_435_456,
      }),
      { mode: 0o600 },
    );
    runtime = await createBackupRuntime({
      connection: input.connection,
      provider: input.provider,
      signer: () => Promise.resolve(input.signer),
      path: configFile,
    });
    return {
      runtime,
      stop,
      async rotateWrappingKey() {
        const keyring = z
          .object({ current: z.string(), keys: z.record(z.string(), z.string()) })
          .parse(JSON.parse(await readFile(keyringFile, 'utf8')));
        await writeFile(
          keyringFile,
          JSON.stringify({
            current: 'v2',
            keys: { ...keyring.keys, v2: randomBytes(32).toString('base64') },
          }),
          { mode: 0o600 },
        );
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

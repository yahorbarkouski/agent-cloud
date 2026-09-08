import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { z } from 'zod';
import { createFixtureDeleterPolicy } from './policies.js';

// Official multiarch releases; pulls are pinned, while fixture containers have no external network.
const image = 'minio/minio@sha256:d249d1fb6966de4d8ad26c04754b545205ff15a62e4fd19ebd0f26fa5baacbc0';
const nodeImage =
  'node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e';
const suffix = randomUUID().slice(0, 8);
const directory = await mkdtemp('/tmp/acld-backup-store-');
const administrator = {
  accessKeyId: 'fixture-administrator',
  secretAccessKey: randomBytes(24).toString('hex'),
};
const writer = { accessKeyId: 'fixture-writer', secretAccessKey: randomBytes(24).toString('hex') };
const reader = { accessKeyId: 'fixture-reader', secretAccessKey: randomBytes(24).toString('hex') };
const deleter = {
  accessKeyId: 'fixture-deleter',
  secretAccessKey: randomBytes(24).toString('hex'),
};
const bucket = 'protected-backups';
let container: string | undefined;
let runner: string | undefined;
let stage = 'fixture setup';
async function docker(args: string[], timeoutMs = 30_000) {
  try {
    return (
      await promisify(execFile)('docker', args, {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 16_384,
      })
    ).stdout.trim();
  } catch {
    throw new Error('Local S3 fixture command failed.');
  }
}
async function ensureImage(reference: string) {
  const cached = await docker(['image', 'inspect', reference, '--format', '{{.Id}}']).then(
    () => true,
    () => false,
  );
  if (!cached) await docker(['pull', '--quiet', reference], 120_000);
}
function containerId(value: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Local S3 container identity is invalid.');
  return value;
}
let passed = false;
try {
  stage = 'pinned MinIO image';
  await ensureImage(image);
  stage = 'pinned Node image';
  await ensureImage(nodeImage);
  stage = 'fixture setup';
  await writeFile(
    join(directory, 'environment'),
    `MINIO_ROOT_USER=${administrator.accessKeyId}\nMINIO_ROOT_PASSWORD=${administrator.secretAccessKey}\nMINIO_BROWSER=off\nMINIO_UPDATE=off\nMINIO_CONFIG_DIR=/tmp/minio\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(directory, 'identities.json'),
    JSON.stringify({ administrator, writer, reader, deleter }),
    { mode: 0o600 },
  );
  await build({
    entryPoints: [fileURLToPath(new URL('./smoke-client.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile: join(directory, 'client.cjs'),
    logLevel: 'silent',
  });
  container = containerId(
    await docker([
      'create',
      '--pull',
      'never',
      '--name',
      `acld-backup-store-${suffix}`,
      '--network',
      'none',
      '--memory',
      '512m',
      '--cpus',
      '1',
      '--pids-limit',
      '128',
      '--read-only',
      '--tmpfs',
      '/data:size=128m',
      '--tmpfs',
      '/tmp:size=32m',
      '--mount',
      `type=bind,source=${directory},target=/fixture,readonly`,
      '--env-file',
      join(directory, 'environment'),
      image,
      'server',
      '/data',
      '--address',
      ':9000',
    ]),
  );
  await docker(['start', container]);
  const mc = (args: string[]) =>
    docker(['exec', container ?? '', 'mc', '--config-dir', '/tmp/mc', ...args]);
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
  if (!ready) throw new Error('Local S3 fixture did not become ready.');
  stage = 'separate credentials';
  for (const [role, identity] of [
    ['writer', writer],
    ['reader', reader],
    ['deleter', deleter],
  ] satisfies Array<[string, typeof writer]>) {
    const policy =
      role === 'deleter'
        ? createFixtureDeleterPolicy(bucket, 'protected')
        : {
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
    await writeFile(join(directory, `${role}.json`), JSON.stringify(policy), { mode: 0o600 });
    await mc(['admin', 'user', 'add', 'fixture', identity.accessKeyId, identity.secretAccessKey]);
    await mc(['admin', 'policy', 'create', 'fixture', role, `/fixture/${role}.json`]);
    await mc(['admin', 'policy', 'attach', 'fixture', role, '--user', identity.accessKeyId]);
  }
  stage = 'protected ciphertext round trip';
  runner = containerId(
    await docker([
      'create',
      '--pull',
      'never',
      '--name',
      `acld-backup-client-${suffix}`,
      '--user',
      `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      '--network',
      `container:${container}`,
      '--memory',
      '512m',
      '--cpus',
      '1',
      '--pids-limit',
      '128',
      '--read-only',
      '--tmpfs',
      '/tmp:size=32m',
      '--mount',
      `type=bind,source=${directory},target=/fixture`,
      '--entrypoint',
      'node',
      nodeImage,
      '/fixture/client.cjs',
    ]),
  );
  const output = await docker(['start', '--attach', runner]);
  if (output !== 'protected-ciphertext-verified') {
    stage = z
      .strictObject({ passed: z.literal(false), stage: z.string().regex(/^[A-Za-z0-9 _-]{1,64}$/) })
      .parse(JSON.parse(output)).stage;
    throw new Error('Local S3 fixture did not confirm verification.');
  }
  passed = true;
} catch {
  process.stderr.write(JSON.stringify({ error: 'Local S3 adapter smoke failed.', stage }) + '\n');
  process.exitCode = 1;
} finally {
  if (runner) await docker(['rm', '--force', runner]);
  if (container) await docker(['rm', '--force', container]);
  await rm(directory, { recursive: true, force: true });
}
if (passed)
  process.stdout.write(
    JSON.stringify({
      passed: true,
      modes: ['GOVERNANCE', 'COMPLIANCE'],
      separateCredentials: true,
      exactVersionDeletionDenied: true,
      readerWriteDenied: true,
      exactVersionPurgeVerified: true,
      retentionExtensionsHonored: true,
      expiredReadOnlyRecoveryVerified: true,
      writerDeleteDenied: true,
      deleterWriteDenied: true,
      deleterBypassDenied: true,
      deleterUnversionedDeleteDenied: true,
      cleanup: true,
      providerProof: false,
    }) + '\n',
  );

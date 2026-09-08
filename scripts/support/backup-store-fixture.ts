import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { backupRestores, type Connection } from '../../packages/db/src/index.js';
import { CloudError, type MachineProvider } from '../../packages/contracts/dist/index.js';
import type { Signer } from '../../packages/pki/dist/index.js';
import { createFixtureDeleterPolicy } from '../../packages/backup-store/src/fixture/policies.js';
import { createBackupRuntime } from '../../apps/control/src/backup-runtime.js';
import { backupKeyringSchema } from '../../apps/control/src/backup-crypto.js';
import { restoreRecord, restoreWorkSchema } from '../../apps/control/src/backup-records.js';
import { readPrivateFile } from '../../apps/control/src/private-file.js';
import { atomicWrite, syncDirectory } from '../../packages/guestctl/src/files.js';

const image = 'minio/minio@sha256:d249d1fb6966de4d8ad26c04754b545205ff15a62e4fd19ebd0f26fa5baacbc0';

/** A loopback-only S3 fixture for the native customer scenario. No provider resources or persistent bucket. */
export async function prepareBackupStoreFixture(input: {
  connection: Connection;
  provider: MachineProvider;
  signer: Signer;
  scratch: string;
}) {
  const fixture = await prepareProtectedStoreFixture({ scratch: input.scratch });
  try {
    let backupCredentialsIssued = 0;
    const runtime = await createBackupRuntime({
      connection: input.connection,
      provider: input.provider,
      signer: () =>
        Promise.resolve({
          issueBackupCredential: (...args: Parameters<Signer['issueBackupCredential']>) => {
            backupCredentialsIssued++;
            return input.signer.issueBackupCredential(...args);
          },
        }),
      path: fixture.configFile,
    });
    return {
      runtime,
      rotateWrappingKey: () => fixture.rotateWrappingKey(),
      keyRecovery: {
        ...fixture.keyRecovery,
        async verifyUnavailable(id: string) {
          const readWork = async () => {
            const [row] = await input.connection.db
              .select()
              .from(backupRestores)
              .where(eq(backupRestores.id, id));
            assert.ok(row, 'Admitted native restore is missing.');
            assert.equal(restoreRecord(row).state.kind, 'pending');
            return restoreWorkSchema.parse(row.work);
          };
          // Provisioning still runs through Graphile and the actual native machine path.
          const deadline = Date.now() + 900_000;
          while ((await readWork()).kind === 'waiting' && Date.now() < deadline)
            await setTimeout(250);
          assert.deepEqual(await readWork(), { kind: 'prepare', attempts: 0 });
          const issuedBefore = backupCredentialsIssued;
          let refusals = 0;
          const refusalDeadline = Date.now() + 30_000;
          while (refusals < 6 && Date.now() < refusalDeadline) {
            try {
              await runtime.service.advance('restore', id);
              throw new Error('Restore advanced without its original wrapping key.');
            } catch (error) {
              assert.ok(error instanceof CloudError, 'Restore key failure was not sanitized.');
              assert.equal(error.failure.code, 'resource_busy');
              assert.equal(error.failure.retryable, true);
              if (
                error.failure.message.startsWith(
                  'Restore is waiting for its matching backup wrapping key.',
                )
              )
                refusals++;
              else {
                assert.equal(
                  error.failure.message,
                  'Another backup or restore owns the bounded worker scratch capacity.',
                );
                await setTimeout(100);
              }
            }
            assert.deepEqual(await readWork(), { kind: 'prepare', attempts: 0 });
            assert.equal(
              backupCredentialsIssued,
              issuedBefore,
              'Blocked restore requested guest backup access.',
            );
          }
          assert.equal(refusals, 6, 'Six actual key preflight refusals were not observed.');
          return refusals;
        },
      },
      stop: async () => {
        try {
          await runtime.close();
        } finally {
          await fixture.stop();
        }
      },
    };
  } catch (error) {
    await fixture.stop();
    throw error;
  }
}

export async function prepareProtectedStoreFixture(input: { scratch: string }) {
  const id = randomUUID();
  const name = `agent-cloud-backup-${id.slice(0, 8)}`;
  const ownership = resolve(`.local/backup-store-${id}.json`);
  await mkdir(dirname(ownership), { recursive: true, mode: 0o700 });
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
  const deleter = {
    accessKeyId: 'fixture-deleter',
    secretAccessKey: randomBytes(32).toString('hex'),
  };
  const bucket = 'protected-backups';
  let container: string | undefined;
  let offlineKeyDirectory: string | undefined;
  let offlineKeyDigest: string | undefined;
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
    if (offlineKeyDirectory) {
      await rm(offlineKeyDirectory, { recursive: true, force: true });
      offlineKeyDirectory = undefined;
    }
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
    return {
      configFile,
      deleterCredentialsFile: join(directory, 'deleter-credentials.json'),
      stop,
      keyRecovery: {
        async loseActive() {
          assert.equal(offlineKeyDirectory, undefined, 'Offline key copy already exists.');
          const original = await readPrivateFile(keyringFile);
          const keyring = backupKeyringSchema.parse(JSON.parse(original));
          assert.equal(keyring.current, 'v2');
          assert.ok(keyring.keys.v1, 'Original capture key version is missing.');
          offlineKeyDirectory = await mkdtemp(join(tmpdir(), `agent-cloud-backup-keyring-${id}-`));
          await atomicWrite(
            ownership,
            JSON.stringify({
              purpose: 'agent-cloud-native-backup-store',
              id,
              name,
              image,
              container,
              offlineKeyDirectory,
            }) + '\n',
            0o600,
          );
          const file = await open(join(offlineKeyDirectory, 'keyring.json'), 'wx', 0o600);
          try {
            await file.writeFile(original);
            await file.sync();
          } finally {
            await file.close();
          }
          await syncDirectory(offlineKeyDirectory);
          await syncDirectory(dirname(offlineKeyDirectory));
          offlineKeyDigest = createHash('sha256').update(original).digest('hex');
          await unlink(keyringFile);
          await syncDirectory(dirname(keyringFile));
        },
        async installWrong() {
          assert.ok(offlineKeyDirectory);
          const original = await readPrivateFile(join(offlineKeyDirectory, 'keyring.json'));
          assert.equal(createHash('sha256').update(original).digest('hex'), offlineKeyDigest);
          const keyring = backupKeyringSchema.parse(JSON.parse(original));
          const wrong = {
            current: keyring.current,
            keys: Object.fromEntries(
              Object.keys(keyring.keys).map((version) => [
                version,
                randomBytes(32).toString('base64'),
              ]),
            ),
          };
          await atomicWrite(keyringFile, JSON.stringify(wrong), 0o600);
        },
        async recover() {
          assert.ok(offlineKeyDirectory);
          const original = await readPrivateFile(join(offlineKeyDirectory, 'keyring.json'));
          assert.equal(createHash('sha256').update(original).digest('hex'), offlineKeyDigest);
          backupKeyringSchema.parse(JSON.parse(original));
          await atomicWrite(keyringFile, original, 0o600);
          assert.equal(
            createHash('sha256')
              .update(await readPrivateFile(keyringFile))
              .digest('hex'),
            offlineKeyDigest,
          );
        },
      },
      async rotateWrappingKey() {
        const keyring = z
          .object({ current: z.string(), keys: z.record(z.string(), z.string()) })
          .parse(JSON.parse(await readPrivateFile(keyringFile)));
        await atomicWrite(
          keyringFile,
          JSON.stringify({
            current: 'v2',
            keys: { ...keyring.keys, v2: randomBytes(32).toString('base64') },
          }),
          0o600,
        );
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

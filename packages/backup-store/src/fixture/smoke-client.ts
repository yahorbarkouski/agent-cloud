import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  PutObjectRetentionCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  backupStoreCredentialsSchema,
  createBackupDeleter,
  createBackupReader,
  createBackupWriter,
} from '../index.js';

async function denied(work: Promise<unknown>, objectLock = false) {
  try {
    await work;
  } catch (error) {
    const status = z
      .object({ $metadata: z.object({ httpStatusCode: z.number() }) })
      .safeParse(error);
    const code = z.object({ name: z.string().regex(/^[A-Za-z]{1,32}$/) }).safeParse(error);
    if (
      z.object({ $metadata: z.object({ httpStatusCode: z.literal(403) }) }).safeParse(error).success
    )
      return;
    // This pinned MinIO release reports ErrObjectLocked as this specific HTTP 400 response.
    if (
      objectLock &&
      z
        .object({
          name: z.literal('InvalidRequest'),
          message: z.literal('Object is WORM protected and cannot be overwritten'),
          $metadata: z.object({ httpStatusCode: z.literal(400) }),
        })
        .safeParse(error).success
    )
      return;
    stage += status.success ? ` status ${status.data.$metadata.httpStatusCode}` : ' missing status';
    if (code.success) stage += ` ${code.data.name}`;
    throw new Error('Unexpected fixture denial.', { cause: error });
  }
  stage += ' permitted';
  throw new Error('Fixture unexpectedly permitted a protected operation.');
}
let stage = 'client input';
async function prove() {
  const directory = '/fixture';
  const identities = z
    .strictObject({
      administrator: backupStoreCredentialsSchema,
      writer: backupStoreCredentialsSchema,
      reader: backupStoreCredentialsSchema,
      deleter: backupStoreCredentialsSchema,
    })
    .parse(JSON.parse(await readFile(join(directory, 'identities.json'), 'utf8')));
  const config = {
    endpoint: 'http://127.0.0.1:9000',
    region: 'us-east-1',
    bucket: 'protected-backups',
    keyPrefix: 'protected',
    maxBytes: 1_048_576,
    requestTimeoutMs: 5000,
  };
  const options = {
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    maxAttempts: 1,
  };
  const administrator = new S3Client({
    ...options,
    credentials: {
      accessKeyId: identities.administrator.accessKeyId,
      secretAccessKey: identities.administrator.secretAccessKey,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const readerClient = new S3Client({
    ...options,
    credentials: {
      accessKeyId: identities.reader.accessKeyId,
      secretAccessKey: identities.reader.secretAccessKey,
    },
  });
  const writerClient = new S3Client({
    ...options,
    credentials: {
      accessKeyId: identities.writer.accessKeyId,
      secretAccessKey: identities.writer.secretAccessKey,
    },
  });
  const deleterClient = new S3Client({
    ...options,
    credentials: {
      accessKeyId: identities.deleter.accessKeyId,
      secretAccessKey: identities.deleter.secretAccessKey,
    },
  });
  const writer = createBackupWriter(config, identities.writer);
  const reader = createBackupReader(config, identities.reader);
  const deleter = createBackupDeleter(config, identities.deleter);
  try {
    stage = 'bucket creation';
    await administrator.send(
      new CreateBucketCommand({ Bucket: config.bucket, ObjectLockEnabledForBucket: true }),
    );
    stage = 'writer protection';
    await writer.checkProtection();
    stage = 'reader protection';
    await reader.checkProtection();
    stage = 'deleter protection';
    await deleter.checkProtection();
    const file = join(directory, 'opaque-ciphertext');
    await writeFile(file, randomBytes(65_536), { mode: 0o600 });
    for (const mode of ['GOVERNANCE', 'COMPLIANCE'] satisfies Array<'GOVERNANCE' | 'COMPLIANCE'>) {
      stage = `${mode} preparation`;
      const intent = await writer.prepareUpload({
        attemptId: randomUUID(),
        file,
        // Short retention is confined to this disposable, network-isolated fixture.
        retention: { mode, retainUntil: new Date(Date.now() + 4000).toISOString() },
      });
      stage = `${mode} upload`;
      const receipt = await writer.upload({ intent, file });
      stage = `${mode} recovery`;
      const recovered = await writer.recover(intent);
      if (recovered.kind !== 'found' || recovered.receipt.versionId !== receipt.versionId)
        throw new Error('Fixture returned another version.');
      const destination = join(directory, `${mode}.restored`);
      stage = `${mode} download`;
      await reader.download({ receipt, destination });
      if (!(await readFile(destination)).equals(await readFile(file)))
        throw new Error('Fixture restore differs.');
      // This separate fixture administrator still cannot delete retained versions without bypass.
      stage = `${mode} deletion denial`;
      await denied(
        administrator.send(
          new DeleteObjectCommand({
            Bucket: config.bucket,
            Key: receipt.key,
            VersionId: receipt.versionId,
          }),
        ),
        true,
      );
      stage = `${mode} retained purge`;
      const retained = await deleter.purge(receipt);
      if (retained.kind !== 'retained' || retained.retainUntil !== receipt.retention.retainUntil)
        throw new Error('Fixture did not preserve retention.');
      const extendedUntil = new Date(Date.parse(receipt.retention.retainUntil) + 2000);
      await administrator.send(
        new PutObjectRetentionCommand({
          Bucket: config.bucket,
          Key: receipt.key,
          VersionId: receipt.versionId,
          Retention: { Mode: mode, RetainUntilDate: extendedUntil },
        }),
      );
      stage = `${mode} extended retention`;
      const extended = await deleter.purge(receipt);
      if (extended.kind !== 'retained' || extended.retainUntil !== extendedUntil.toISOString())
        throw new Error('Fixture did not honor extended retention.');
      // A new version at the same key must survive deletion of the recorded old version.
      const body = await readFile(file);
      const replacement = await administrator.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: receipt.key,
          Body: body,
          ContentMD5: createHash('md5').update(body).digest('base64'),
          ObjectLockMode: mode,
          ObjectLockRetainUntilDate: new Date(Date.now() + 86_400_000),
        }),
      );
      const replacementVersion = z.string().min(1).parse(replacement.VersionId);
      if (replacementVersion === receipt.versionId)
        throw new Error('Fixture version did not change.');
      stage = 'deleter unversioned delete denial';
      await denied(
        deleterClient.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: receipt.key })),
      );
      if (mode === 'GOVERNANCE') {
        stage = 'deleter bypass denial';
        // A negative IAM test only: the adapter never exposes or sets this option.
        await denied(
          deleterClient.send(
            new DeleteObjectCommand({
              Bucket: config.bucket,
              Key: receipt.key,
              VersionId: replacementVersion,
              BypassGovernanceRetention: true,
            }),
          ),
        );
      }
      await setTimeout(Math.max(0, extendedUntil.getTime() - Date.now()) + 100);
      stage = `${mode} expired read-only recovery`;
      const historical = await writer.recover(intent);
      if (historical.kind !== 'found' || historical.receipt.versionId !== receipt.versionId)
        throw new Error('Fixture did not recover its exact expired version.');
      const afterRecovery = await writerClient.send(
        new ListObjectVersionsCommand({ Bucket: config.bucket, Prefix: receipt.key, MaxKeys: 32 }),
      );
      const versions = afterRecovery.Versions?.filter((version) => version.Key === receipt.key);
      if (
        afterRecovery.IsTruncated !== false ||
        versions?.length !== 2 ||
        !versions.some((version) => version.VersionId === receipt.versionId) ||
        !versions.some((version) => version.VersionId === replacementVersion)
      )
        throw new Error('Fixture recovery changed stored versions.');
      stage = `${mode} expired writer delete denial`;
      await denied(
        writerClient.send(
          new DeleteObjectCommand({
            Bucket: config.bucket,
            Key: receipt.key,
            VersionId: receipt.versionId,
          }),
        ),
      );
      stage = `${mode} exact expired purge`;
      if ((await deleter.purge(receipt)).kind !== 'absent')
        throw new Error('Fixture expired version was not removed.');
      if ((await deleter.purge(receipt)).kind !== 'absent')
        throw new Error('Fixture repeated purge did not confirm absence.');
      const survivor = await administrator.send(
        new HeadObjectCommand({
          Bucket: config.bucket,
          Key: receipt.key,
          VersionId: replacementVersion,
        }),
      );
      if (survivor.VersionId !== replacementVersion || survivor.ContentLength !== body.length)
        throw new Error('Fixture removed another version.');
    }
    stage = 'reader write denial';
    await denied(
      readerClient.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: `protected/${randomUUID()}.enc`,
          Body: 'fixture write must be rejected',
        }),
      ),
    );
    stage = 'deleter write denial';
    await denied(
      deleterClient.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: `protected/${randomUUID()}.enc`,
          Body: 'fixture write must be rejected',
        }),
      ),
    );
  } finally {
    writer.close();
    reader.close();
    deleter.close();
    administrator.destroy();
    readerClient.destroy();
    writerClient.destroy();
    deleterClient.destroy();
  }
}
void prove().then(
  () => process.stdout.write('protected-ciphertext-verified\n'),
  () => {
    process.stdout.write(JSON.stringify({ passed: false, stage }) + '\n');
  },
);

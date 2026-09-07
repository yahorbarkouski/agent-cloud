import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { backupStoreCredentialsSchema, createBackupReader, createBackupWriter } from '../index.js';

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
  const writer = createBackupWriter(config, identities.writer);
  const reader = createBackupReader(config, identities.reader);
  try {
    stage = 'bucket creation';
    await administrator.send(
      new CreateBucketCommand({ Bucket: config.bucket, ObjectLockEnabledForBucket: true }),
    );
    stage = 'writer protection';
    await writer.checkProtection();
    stage = 'reader protection';
    await reader.checkProtection();
    const file = join(directory, 'opaque-ciphertext');
    await writeFile(file, randomBytes(65_536), { mode: 0o600 });
    for (const mode of ['GOVERNANCE', 'COMPLIANCE'] satisfies Array<'GOVERNANCE' | 'COMPLIANCE'>) {
      stage = `${mode} preparation`;
      const intent = await writer.prepareUpload({
        attemptId: randomUUID(),
        file,
        retention: { mode, retainUntil: new Date(Date.now() + 86_400_000).toISOString() },
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
  } finally {
    writer.close();
    reader.close();
    administrator.destroy();
    readerClient.destroy();
  }
}
void prove().then(
  () => process.stdout.write('protected-ciphertext-verified\n'),
  () => {
    process.stdout.write(JSON.stringify({ passed: false, stage }) + '\n');
  },
);

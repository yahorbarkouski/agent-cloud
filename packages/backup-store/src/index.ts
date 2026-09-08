import {
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  GetObjectRetentionCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  type HeadObjectCommandOutput,
} from '@aws-sdk/client-s3';
import type { FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import {
  backupObjectReceiptSchema,
  backupStoreConfigurationSchema,
  backupStoreCredentialsSchema,
  backupUploadIntentSchema,
  BackupStoreError,
  prepareBackupUploadSchema,
  sanitized,
  sha256,
  type BackupObjectReceipt,
  type BackupStoreConfiguration,
  type BackupStoreCredentials,
  type BackupUploadIntent,
  type PrepareBackupUpload,
} from './schema.js';
import { downloadFile, hashFile, openCiphertext, readCiphertext } from './file.js';
export {
  backupObjectReceiptSchema,
  backupRetentionSchema,
  backupStoreConfigurationSchema,
  backupStoreCredentialsSchema,
  backupUploadIntentSchema,
  BackupStoreError,
  type BackupObjectReceipt,
  type BackupStoreConfiguration,
  type BackupStoreCredentials,
  type BackupUploadIntent,
  type PrepareBackupUpload,
} from './schema.js';

function connect(value: BackupStoreConfiguration, identity: BackupStoreCredentials) {
  try {
    const config = backupStoreConfigurationSchema.parse(value);
    const credentials = backupStoreCredentialsSchema.parse(identity);
    const endpoint = new URL(config.endpoint).href;
    const storeId = sha256(
      JSON.stringify({
        endpoint,
        region: config.region,
        bucket: config.bucket,
        keyPrefix: config.keyPrefix,
      }),
    );
    const client = new S3Client({
      endpoint,
      region: config.region,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        ...(credentials.sessionToken === undefined
          ? {}
          : { sessionToken: credentials.sessionToken }),
      },
      forcePathStyle: true,
      maxAttempts: 1,
      followRegionRedirects: false,
      // Explicit Content-MD5 works with Ceph; every accepted version is also read and SHA256-verified.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      requestHandler: {
        connectionTimeout: config.requestTimeoutMs,
        requestTimeout: config.requestTimeoutMs,
      },
    });
    return { config, client, storeId };
  } catch {
    throw new BackupStoreError('configuration');
  }
}

function store(value: BackupStoreConfiguration, credentials: BackupStoreCredentials) {
  const { config, client, storeId } = connect(value, credentials);
  const bucket = { Bucket: config.bucket };
  const signal = () => ({ abortSignal: AbortSignal.timeout(config.requestTimeoutMs) });
  function bind(value: BackupUploadIntent, requireCurrentRetention = true) {
    const intent = backupUploadIntentSchema.parse(value);
    if (
      intent.storeId !== storeId ||
      intent.bucket !== config.bucket ||
      intent.key !== `${config.keyPrefix}/${intent.attemptId}.enc` ||
      intent.size > config.maxBytes ||
      (requireCurrentRetention && Date.parse(intent.retention.retainUntil) <= Date.now())
    )
      throw new Error('Backup receipt does not match this protected store.');
    return intent;
  }
  const metadata = (intent: BackupUploadIntent) => ({
    'acld-attempt': intent.attemptId,
    'acld-sha256': intent.ciphertextSha256,
    'acld-size': String(intent.size),
    'acld-intent': sha256(JSON.stringify(intent)),
  });
  async function checkProtection() {
    const [versioning, lock] = await Promise.all([
      client.send(new GetBucketVersioningCommand(bucket), signal()),
      client.send(new GetObjectLockConfigurationCommand(bucket), signal()),
    ]);
    if (
      versioning.Status !== 'Enabled' ||
      lock.ObjectLockConfiguration?.ObjectLockEnabled !== 'Enabled'
    )
      throw new Error('Object versioning and Object Lock must both be enabled.');
    return { storeId, bucket: config.bucket, versioning: true, objectLock: true };
  }
  async function checkRetention(receipt: BackupObjectReceipt, requireCurrentRetention = true) {
    const result = await client.send(
      new GetObjectRetentionCommand({ ...bucket, Key: receipt.key, VersionId: receipt.versionId }),
      signal(),
    );
    const retained = result.Retention;
    if (
      retained?.Mode !== receipt.retention.mode ||
      !(retained.RetainUntilDate instanceof Date) ||
      !Number.isFinite(retained.RetainUntilDate.getTime()) ||
      retained.RetainUntilDate.getTime() < Date.parse(receipt.retention.retainUntil) ||
      (requireCurrentRetention && retained.RetainUntilDate.getTime() <= Date.now())
    )
      throw new Error('Object retention does not meet its recorded protection.');
    return retained.RetainUntilDate.toISOString();
  }
  function checkMetadata(
    value: Pick<
      HeadObjectCommandOutput,
      'VersionId' | 'ContentLength' | 'Metadata' | 'DeleteMarker'
    >,
    receipt: BackupObjectReceipt,
  ) {
    if (
      value.DeleteMarker ||
      value.VersionId !== receipt.versionId ||
      value.ContentLength !== receipt.size
    )
      throw new Error('S3 returned a different object version or size.');
    for (const [key, expected] of Object.entries(
      metadata(backupUploadIntentSchema.strip().parse(receipt)),
    ))
      if (value.Metadata?.[key] !== expected)
        throw new Error('S3 returned inconsistent backup metadata.');
  }
  async function inspectMetadata(receipt: BackupObjectReceipt, requireCurrentRetention = true) {
    const result = await client.send(
      new HeadObjectCommand({ ...bucket, Key: receipt.key, VersionId: receipt.versionId }),
      signal(),
    );
    checkMetadata(result, receipt);
    await checkRetention(receipt, requireCurrentRetention);
  }
  async function readVersion(
    receipt: BackupObjectReceipt,
    destination?: FileHandle,
    requireCurrentRetention = true,
  ) {
    const result = await client.send(
      new GetObjectCommand({ ...bucket, Key: receipt.key, VersionId: receipt.versionId }),
      signal(),
    );
    try {
      checkMetadata(result, receipt);
      await readCiphertext(result.Body, receipt, config.requestTimeoutMs, destination);
    } finally {
      if (result.Body instanceof Readable) result.Body.destroy();
    }
    await checkRetention(receipt, requireCurrentRetention);
  }
  function receipt(value: BackupObjectReceipt) {
    const parsed = backupObjectReceiptSchema.parse(value);
    bind(backupUploadIntentSchema.strip().parse(parsed), false);
    return parsed;
  }
  return {
    config,
    client,
    storeId,
    bucket,
    signal,
    bind,
    metadata,
    checkProtection,
    checkRetention,
    checkMetadata,
    inspectMetadata,
    readVersion,
    receipt,
  };
}

/** The caller durably records submission before upload. After any upload error use recover only. */
export function createBackupWriter(
  config: BackupStoreConfiguration,
  credentials: BackupStoreCredentials,
) {
  const s3 = store(config, credentials);
  const submitted = new Set<string>();
  return {
    checkProtection: () => sanitized('protection', s3.checkProtection),
    prepareUpload: (value: PrepareBackupUpload): Promise<BackupUploadIntent> =>
      sanitized('prepare', async () => {
        const input = prepareBackupUploadSchema.parse(value);
        const { file, info } = await openCiphertext(input.file, s3.config.maxBytes);
        try {
          const digests = await hashFile(file, info.size);
          const after = await file.stat();
          if (
            after.size !== info.size ||
            after.mtimeMs !== info.mtimeMs ||
            after.ctimeMs !== info.ctimeMs
          )
            throw new Error('Ciphertext changed during preparation.');
          return s3.bind({
            storeId: s3.storeId,
            bucket: s3.config.bucket,
            key: `${s3.config.keyPrefix}/${input.attemptId}.enc`,
            attemptId: input.attemptId,
            ...digests,
            retention: {
              ...input.retention,
              retainUntil: new Date(
                Math.ceil(Date.parse(input.retention.retainUntil) / 1000) * 1000,
              ).toISOString(),
            },
          });
        } finally {
          await file.close();
        }
      }),
    upload: (input: { intent: BackupUploadIntent; file: string }): Promise<BackupObjectReceipt> =>
      sanitized('upload', async () => {
        const intent = s3.bind(input.intent);
        await s3.checkProtection();
        const { file, info } = await openCiphertext(input.file, s3.config.maxBytes);
        try {
          const digests = await hashFile(file, info.size);
          if (
            digests.size !== intent.size ||
            digests.ciphertextSha256 !== intent.ciphertextSha256 ||
            digests.contentMd5 !== intent.contentMd5 ||
            submitted.has(intent.attemptId)
          )
            throw new Error('Ciphertext differs or this attempt was already submitted.');
          submitted.add(intent.attemptId);
          const body = file.createReadStream({ start: 0, end: intent.size - 1, autoClose: false });
          let versionId: string | undefined;
          try {
            const result = await s3.client.send(
              new PutObjectCommand({
                ...s3.bucket,
                Key: intent.key,
                Body: body,
                ContentLength: intent.size,
                ContentType: 'application/octet-stream',
                ContentMD5: intent.contentMd5,
                IfNoneMatch: '*',
                Metadata: s3.metadata(intent),
                ObjectLockMode: intent.retention.mode,
                ObjectLockRetainUntilDate: new Date(intent.retention.retainUntil),
              }),
              s3.signal(),
            );
            versionId = result.VersionId;
          } finally {
            body.destroy();
          }
          const receipt = backupObjectReceiptSchema.parse({ ...intent, versionId });
          await s3.inspectMetadata(receipt);
          await s3.readVersion(receipt);
          return receipt;
        } finally {
          await file.close();
        }
      }),
    recover: (
      value: BackupUploadIntent,
    ): Promise<{ kind: 'found'; receipt: BackupObjectReceipt } | { kind: 'unresolved' }> =>
      sanitized('recover', async () => {
        const intent = s3.bind(value);
        await s3.checkProtection();
        let keyMarker: string | undefined;
        let versionMarker: string | undefined;
        const candidates: string[] = [];
        for (let page = 0; page < 4; page++) {
          const result = await s3.client.send(
            new ListObjectVersionsCommand({
              ...s3.bucket,
              Prefix: intent.key,
              MaxKeys: 32,
              ...(keyMarker === undefined ? {} : { KeyMarker: keyMarker }),
              ...(versionMarker === undefined ? {} : { VersionIdMarker: versionMarker }),
            }),
            s3.signal(),
          );
          if (typeof result.IsTruncated !== 'boolean')
            throw new Error('Version listing is incomplete.');
          for (const version of result.Versions ?? []) {
            if (version.Key !== intent.key) continue;
            const receipt = backupObjectReceiptSchema.parse({
              ...intent,
              versionId: version.VersionId,
            });
            const head = await s3.client.send(
              new HeadObjectCommand({
                ...s3.bucket,
                Key: intent.key,
                VersionId: receipt.versionId,
              }),
              s3.signal(),
            );
            if (head.Metadata?.['acld-attempt'] !== intent.attemptId) continue;
            s3.checkMetadata(head, receipt);
            candidates.push(receipt.versionId);
            if (candidates.length > 1) return { kind: 'unresolved' };
          }
          if (!result.IsTruncated) {
            const versionId = candidates[0];
            if (!versionId) return { kind: 'unresolved' };
            const receipt = backupObjectReceiptSchema.parse({ ...intent, versionId });
            await s3.inspectMetadata(receipt);
            await s3.readVersion(receipt);
            return { kind: 'found', receipt };
          }
          if (
            !result.NextKeyMarker ||
            !result.NextVersionIdMarker ||
            (keyMarker === result.NextKeyMarker && versionMarker === result.NextVersionIdMarker)
          )
            throw new Error('Version listing did not advance.');
          keyMarker = result.NextKeyMarker;
          versionMarker = result.NextVersionIdMarker;
        }
        return { kind: 'unresolved' };
      }),
    close: () => {
      s3.client.destroy();
    },
  };
}

/** Readers receive their own S3 identity; this API has no write, delete or retention-bypass operation. */
export function createBackupReader(
  config: BackupStoreConfiguration,
  credentials: BackupStoreCredentials,
) {
  const s3 = store(config, credentials);
  return {
    checkProtection: () => sanitized('protection', s3.checkProtection),
    inspect: (value: BackupObjectReceipt): Promise<BackupObjectReceipt> =>
      sanitized('inspect', async () => {
        const receipt = s3.receipt(value);
        await s3.checkProtection();
        await s3.inspectMetadata(receipt, false);
        await s3.readVersion(receipt, undefined, false);
        return receipt;
      }),
    download: (input: {
      receipt: BackupObjectReceipt;
      destination: string;
    }): Promise<BackupObjectReceipt> =>
      sanitized('download', async () => {
        const receipt = s3.receipt(input.receipt);
        await s3.checkProtection();
        await s3.inspectMetadata(receipt, false);
        return downloadFile(input.destination, async (file) => {
          await s3.readVersion(receipt, file, false);
          return receipt;
        });
      }),
    close: () => {
      s3.client.destroy();
    },
  };
}

/** Separate operator credentials only. The caller persists purge intent before invoking this API. */
export function createBackupDeleter(
  config: BackupStoreConfiguration,
  credentials: BackupStoreCredentials,
) {
  const s3 = store(config, credentials);
  return {
    checkProtection: () => sanitized('protection', s3.checkProtection),
    purge: (
      value: BackupObjectReceipt,
    ): Promise<{ kind: 'absent' } | { kind: 'retained'; retainUntil: string }> =>
      sanitized('purge', async () => {
        const receipt = s3.receipt(value);
        const target = { ...s3.bucket, Key: receipt.key, VersionId: receipt.versionId };
        await s3.checkProtection();
        async function exists() {
          let head: HeadObjectCommandOutput;
          try {
            head = await s3.client.send(new HeadObjectCommand(target), s3.signal());
          } catch (error) {
            // A permission error, missing retention response or failed DELETE is not absence.
            if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404)
              return false;
            throw error;
          }
          s3.checkMetadata(head, receipt);
          return true;
        }
        if (!(await exists())) return { kind: 'absent' };
        const retainUntil = await s3.checkRetention(receipt, false);
        if (Date.parse(retainUntil) > Date.now()) return { kind: 'retained', retainUntil };
        // Never issue an unversioned delete or request governance bypass. Repeating this
        // exact version after an uncertain reply cannot affect a replacement version.
        await s3.client.send(new DeleteObjectCommand(target), s3.signal());
        if (await exists()) throw new Error('Backup version absence is not verified.');
        return { kind: 'absent' };
      }),
    close: () => {
      s3.client.destroy();
    },
  };
}

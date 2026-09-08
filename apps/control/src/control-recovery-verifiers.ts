import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  imageBuildAdmissionSchema,
  imageEffectLabels,
  imagePublicationSchema,
  imageResourceKindSchema,
  imageResourceRoleSchema,
  imageResourceStateSchema,
  type ImageProvider,
  type ImageProviderResource,
} from '@agent-cloud/contracts';
import { backupStoreCredentialsSchema, createBackupReader } from '@agent-cloud/backup-store';
import { databaseTime, type Connection } from '@agent-cloud/db';
import { HetznerImageProvider } from '@agent-cloud/hetzner';
import type { Config } from './config.js';
import type {
  BackupRecoveryVerifier,
  ImageRecoveryVerifier,
} from './control-recovery-inspection.js';
import { requireTrustedImageRelease } from './image-publication.js';
import { readPrivateFile } from './private-file.js';
import { createImageReleaseKeySource } from './runtime-identity.js';
import { readRuntimeConfig } from './runtime-config.js';
import { backupControlConfigSchema } from './backup-records.js';
import { matchesLabels } from './resource-journal.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failed = () => ({ ok: false, evidenceDigest: digest({ kind: 'failed' }) });

/** Lazily opens read-only recovery dependencies; callers must close the returned readers. */
export function createControlRecoveryVerifiers(input: {
  connection: Connection;
  config: Config;
  transport?: typeof fetch;
}) {
  let backupReader: ReturnType<typeof createBackupReader> | undefined;
  let backupLoad: Promise<ReturnType<typeof createBackupReader>> | undefined;
  async function getBackupReader() {
    const path = input.config.backupConfigFile;
    if (!path) throw new Error('Backup recovery config is unavailable.');
    backupLoad ??= (async () => {
      const config = backupControlConfigSchema.parse(JSON.parse(await readPrivateFile(path)));
      const credentials = backupStoreCredentialsSchema.parse(
        JSON.parse(await readPrivateFile(config.readerCredentialsFile)),
      );
      backupReader = createBackupReader(config.store, credentials);
      return backupReader;
    })().catch((error: unknown) => {
      backupLoad = undefined;
      throw error;
    });
    return backupLoad;
  }

  let imageLoad:
    | Promise<{
        provider: Pick<ImageProvider, 'get' | 'find'>;
        readKeys: ReturnType<typeof createImageReleaseKeySource>;
      }>
    | undefined;
  async function getImage() {
    if (input.config.provider !== 'hetzner')
      throw new Error('Image recovery requires the Hetzner provider.');
    imageLoad ??= Promise.all([
      readPrivateFile(input.config.providerTokenFile),
      readRuntimeConfig(input.config.runtimeConfigFile),
    ])
      .then(([token, runtime]) => ({
        provider: new HetznerImageProvider({
          token,
          ...(input.transport ? { transport: input.transport } : {}),
          renderBoot: () =>
            Promise.reject(new Error('Recovery inventory cannot render or submit image work.')),
        }),
        readKeys: createImageReleaseKeySource(runtime.identityDirectory),
      }))
      .catch((error: unknown) => {
        imageLoad = undefined;
        throw error;
      });
    return imageLoad;
  }

  const verifyBackup: BackupRecoveryVerifier = async ({ work }) => {
    if (work.kind !== 'stored') return failed();
    try {
      const receipt = await (await getBackupReader()).inspect(work.receipt);
      return { ok: true, evidenceDigest: digest(receipt) };
    } catch {
      return failed();
    }
  };

  const verifyImage: ImageRecoveryVerifier = async ({
    buildId,
    admission,
    publication,
    resources,
  }) => {
    try {
      const admitted = imageBuildAdmissionSchema.parse(admission);
      const published = imagePublicationSchema.parse(
        publication?.release
          ? { kind: 'published', release: publication.release }
          : { kind: 'waiting' },
      );
      if (published.kind !== 'published' || admitted.id !== buildId) return failed();
      const loaded = await getImage();
      const trusted = requireTrustedImageRelease(
        published.release,
        await loaded.readKeys(),
        await databaseTime(input.connection.db),
      );
      if (!isDeepStrictEqual(trusted.release.payload.manifest, admitted.source.manifest))
        return failed();
      const snapshotRows = resources.filter((row) => row.role === 'snapshot');
      if (snapshotRows.length !== 1) return failed();
      const observed: ImageProviderResource[] = [];
      let publishedSnapshot: Extract<ImageProviderResource, { kind: 'snapshot' }> | undefined;
      for (const row of resources) {
        const kind = imageResourceKindSchema.parse(row.kind);
        const role = imageResourceRoleSchema.parse(row.role);
        const state = imageResourceStateSchema.parse(row.state);
        const resource = await loaded.provider.get({ kind, id: row.providerId });
        if (state.kind === 'absent') {
          if (resource) return failed();
          continue;
        }
        if (
          state.kind !== 'observed' ||
          !resource ||
          !isDeepStrictEqual(resource, state.resource) ||
          !matchesLabels(
            resource.labels,
            imageEffectLabels({ buildId: admitted.id, role, effectId: row.effectId }),
          )
        )
          return failed();
        observed.push(resource);
        if (role === 'snapshot' && resource.kind === 'snapshot') publishedSnapshot = resource;
      }
      const snapshot = snapshotRows[0];
      const evidence = trusted.release.payload.snapshot;
      if (
        !snapshot ||
        snapshot.providerId !== evidence.id ||
        !publishedSnapshot ||
        publishedSnapshot.id !== evidence.id ||
        publishedSnapshot.status !== 'available' ||
        publishedSnapshot.deleteProtected ||
        publishedSnapshot.architecture !== trusted.release.payload.manifest.architecture ||
        publishedSnapshot.diskGb !== evidence.diskGb ||
        publishedSnapshot.createdAt !== evidence.createdAt ||
        (publishedSnapshot.sourceServerId !== null &&
          publishedSnapshot.sourceServerId !== evidence.sourceServerId)
      )
        return failed();
      return { ok: true, evidenceDigest: digest({ release: trusted.release, observed }) };
    } catch {
      return failed();
    }
  };

  const imageInventory: Pick<ImageProvider, 'get' | 'find'> | undefined =
    input.config.provider === 'hetzner'
      ? {
          get: async (resource) => (await getImage()).provider.get(resource),
          find: async (request) => (await getImage()).provider.find(request),
        }
      : undefined;
  return {
    verifyBackup,
    verifyImage,
    ...(imageInventory ? { imageInventory } : {}),
    close: () => backupReader?.close(),
  };
}

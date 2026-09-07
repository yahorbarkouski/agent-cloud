import { and, eq, isNull } from 'drizzle-orm';
import {
  CloudError,
  bootstrapSpecSchema,
  guestSubject,
  backupIdSchema,
  type MachineProvider,
} from '@agent-cloud/contracts';
import {
  allocations,
  guestBootstraps,
  machines,
  machineRecord,
  withMachineLock,
  type Connection,
} from '@agent-cloud/db';
import {
  createBackupWriter,
  createBackupReader,
  backupStoreCredentialsSchema,
} from '@agent-cloud/backup-store';
import type { Signer } from '@agent-cloud/pki';
import {
  runBackupCommand,
  withBackupStream,
  runRestoreCommand,
  inspectRestore,
} from '@agent-cloud/remote';
import { createBackups } from './backups.js';
import { backupControlConfigSchema } from './backup-records.js';
import { backupKeyringSchema } from './backup-crypto.js';
import { createBackupWorker, type WithBackupGuest } from './backup-work.js';
import { observeGuest } from './guest-observation.js';
import { readPrivateFile } from './private-file.js';

export function createBackupGuestTransport(input: {
  connection: Connection;
  provider: MachineProvider;
  signer: () => Promise<Pick<Signer, 'issueBackupCredential'>>;
}): WithBackupGuest {
  return async (scope, work) => {
    const result = await withMachineLock({
      pool: input.connection.pool,
      machineId: scope.machineId,
      work: async (db) => {
        const [row] = await db
          .select()
          .from(machines)
          .where(and(eq(machines.id, scope.machineId), eq(machines.accountId, scope.accountId)));
        if (!row) throw new CloudError('not_found', 'Backup machine not found.');
        const machine = machineRecord(row);
        if (
          machine.state.kind !== 'allocated' ||
          machine.state.allocationId !== scope.allocationId ||
          machine.state.guest.kind !== 'ssh'
        )
          throw new CloudError('resource_busy', 'The admitted backup allocation is unavailable.');
        const [allocation] = await db
          .select()
          .from(allocations)
          .where(
            and(
              eq(allocations.id, scope.allocationId),
              eq(allocations.accountId, scope.accountId),
              isNull(allocations.retiredAt),
            ),
          );
        const [bootstrap] = await db
          .select()
          .from(guestBootstraps)
          .where(
            and(
              eq(guestBootstraps.allocationId, scope.allocationId),
              eq(guestBootstraps.accountId, scope.accountId),
            ),
          );
        if (!allocation || !bootstrap)
          throw new CloudError('resource_busy', 'Backup guest identity is unavailable.');
        const spec = bootstrapSpecSchema.parse(bootstrap.spec);
        const observed = await observeGuest(db, input.provider, { allocation, spec });
        const subject = guestSubject(spec);
        async function target() {
          return {
            subject,
            address: observed.address,
            hostCa: spec.image.sshHostCa,
            credential: await (await input.signer()).issueBackupCredential(subject),
          };
        }
        return work({
          capture: async (command) =>
            (await runBackupCommand({ ...(await target()), command })).capture,
          read: async (id, maximumBytes, read) =>
            withBackupStream({ ...(await target()), id, maximumBytes }, read),
          remove: async (id) => {
            const reply = await runBackupCommand({
              ...(await target()),
              command: { kind: 'remove', id: backupIdSchema.parse(id) },
            });
            // The guest keeps a terminal tombstone so the same capture ID cannot be replayed.
            if (
              reply.capture.kind !== 'missing' &&
              !(reply.capture.kind === 'failed' && reply.capture.id === id)
            )
              throw new Error('Guest did not confirm backup scratch removal.');
          },
          restore: async (request, archive, beforeSubmit) => {
            const prepared = await target();
            return runRestoreCommand({ ...prepared, request, archive, beforeSubmit });
          },
          inspectRestore: async (id) => inspectRestore({ ...(await target()), id }),
        });
      },
    });
    if (result.kind === 'busy')
      throw new CloudError('resource_busy', 'Backup machine has another active operation.', true);
    return result.value;
  };
}

export async function createBackupRuntime(input: {
  connection: Connection;
  path: string;
  provider: MachineProvider;
  signer: () => Promise<Pick<Signer, 'issueBackupCredential'>>;
}) {
  const config = backupControlConfigSchema.parse(JSON.parse(await readPrivateFile(input.path)));
  if (
    config.store.maxBytes < config.limits.maxBytes ||
    config.maxAccountBytes < config.limits.maxBytes ||
    config.maxGlobalBytes < config.limits.maxBytes
  )
    throw new Error('Backup store and storage allowances must cover an admitted capture.');
  if (config.writerCredentialsFile === config.readerCredentialsFile)
    throw new Error('Backup writer and reader require separate credential files.');
  // Storage and wrapping credentials are lazy: their loss must not disable machine destruction or status.
  let loaded: Promise<Awaited<ReturnType<typeof load>>> | undefined;
  async function load() {
    const writerCredentials = backupStoreCredentialsSchema.parse(
      JSON.parse(await readPrivateFile(config.writerCredentialsFile)),
    );
    const readerCredentials = backupStoreCredentialsSchema.parse(
      JSON.parse(await readPrivateFile(config.readerCredentialsFile)),
    );
    if (writerCredentials.accessKeyId === readerCredentials.accessKeyId)
      throw new Error('Backup writer and reader require separate storage identities.');
    const writer = createBackupWriter(config.store, writerCredentials);
    const reader = createBackupReader(config.store, readerCredentials);
    const worker = createBackupWorker({
      connection: input.connection,
      config,
      writer,
      reader,
      keyring: async () =>
        backupKeyringSchema.parse(JSON.parse(await readPrivateFile(config.keyringFile))),
      withGuest: createBackupGuestTransport(input),
    });
    return {
      worker,
      close: () => {
        writer.close();
        reader.close();
      },
    };
  }
  const advance: ReturnType<typeof createBackupWorker>['advance'] = async (kind, id) => {
    loaded ??= load().catch((error: unknown) => {
      loaded = undefined;
      throw error;
    });
    await (await loaded).worker.advance(kind, id);
  };
  return {
    service: createBackups({ db: input.connection.db, config, advance }),
    close: async () => {
      if (loaded) (await loaded).close();
    },
  };
}

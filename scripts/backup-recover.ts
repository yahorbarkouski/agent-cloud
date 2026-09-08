import { resolve } from 'node:path';
import { CloudError, backupIdSchema } from '../packages/contracts/dist/index.js';
import { connect } from '../packages/db/dist/index.js';
import {
  backupStoreCredentialsSchema,
  createBackupWriter,
} from '../packages/backup-store/dist/index.js';
import { backupControlConfigSchema } from '../apps/control/dist/backup-records.js';
import {
  backupRecoveryRequestSchema,
  createBackupRecovery,
} from '../apps/control/dist/backup-recovery.js';
import { readPrivateFile } from '../apps/control/dist/private-file.js';
import { openControlFence, openControlRecoveryFence } from '../apps/control/dist/control-fence.js';

async function main() {
  const [command, argument, ...extra] = process.argv.slice(2);
  if (!['inspect', 'apply', 'apply-recovered'].includes(command ?? '') || !argument || extra.length)
    throw new CloudError(
      'invalid_input',
      'Usage: pnpm backup:recover inspect <backup-id> | apply|apply-recovered <private-request.json>',
    );
  const url = process.env.DATABASE_URL;
  if (!url) throw new CloudError('invalid_input', 'DATABASE_URL is required.');
  const connection = connect(url);
  const generationPath = resolve(
    process.env.ACLD_CONTROL_GENERATION_FILE ?? '.local/control-generation.json',
  );
  const fence =
    command === 'inspect'
      ? undefined
      : command === 'apply-recovered'
        ? await openControlRecoveryFence(connection, generationPath, {
            onLost: () => process.exit(1),
          })
        : await openControlFence(connection, generationPath, { onLost: () => process.exit(1) });
  let writer: ReturnType<typeof createBackupWriter> | undefined;
  const recovery = createBackupRecovery({
    connection,
    recover: async (intent) => {
      const path = process.env.ACLD_BACKUP_CONFIG;
      if (!path)
        throw new CloudError(
          'invalid_input',
          'ACLD_BACKUP_CONFIG is required for object verification.',
        );
      const config = backupControlConfigSchema.parse(
        JSON.parse(await readPrivateFile(resolve(path))),
      );
      writer = createBackupWriter(
        config.store,
        backupStoreCredentialsSchema.parse(
          JSON.parse(await readPrivateFile(config.writerCredentialsFile)),
        ),
      );
      return writer.recover(intent);
    },
  });
  try {
    if (command === 'inspect') return await recovery.inspect(backupIdSchema.parse(argument));
    const request = backupRecoveryRequestSchema.parse(
      JSON.parse(await readPrivateFile(resolve(argument))),
    );
    return { backup: await recovery.apply(request) };
  } finally {
    await fence?.close();
    writer?.close();
    await connection.pool.end();
  }
}
try {
  process.stdout.write(JSON.stringify(await main()) + '\n');
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      error:
        error instanceof CloudError
          ? error.failure
          : {
              code: 'provider_unavailable',
              message:
                'Backup recovery could not verify its recorded object. Check private operator configuration and storage access; no upload was repeated.',
              retryable: true,
            },
    }) + '\n',
  );
  process.exitCode = 1;
}

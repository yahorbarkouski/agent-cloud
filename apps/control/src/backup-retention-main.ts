import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { connect } from '@agent-cloud/db';
import {
  backupStoreConfigurationSchema,
  backupStoreCredentialsSchema,
  createBackupDeleter,
} from '@agent-cloud/backup-store';
import { readPrivateFile } from './private-file.js';
import { createBackupRetention } from './backup-retention.js';
import { resolve } from 'node:path';
import { openControlFence } from './control-fence.js';

// Deliberately independent of the API/guest/provider runtime and encryption keyring.
const configSchema = z.strictObject({
  version: z.literal(1),
  store: backupStoreConfigurationSchema,
  deleterCredentialsFile: z.string().refine(isAbsolute),
  pruneScheduled: z.boolean(),
  maxObjects: z.int().min(1).max(100).default(20),
  maxRunSeconds: z.int().min(10).max(300).default(60),
});
async function main() {
  const path = z.string().refine(isAbsolute).parse(process.env.ACLD_BACKUP_RETENTION_CONFIG);
  const config = configSchema.parse(JSON.parse(await readPrivateFile(path)));
  const credentials = backupStoreCredentialsSchema.parse(
    JSON.parse(await readPrivateFile(config.deleterCredentialsFile)),
  );
  const connection = connect(z.url().parse(process.env.DATABASE_URL));
  const fence = await openControlFence(
    connection,
    resolve(process.env.ACLD_CONTROL_GENERATION_FILE ?? '.local/control-generation.json'),
    { onLost: () => process.exit(1) },
  );
  const deleter = createBackupDeleter(config.store, credentials);
  try {
    await deleter.checkProtection();
    const result = await createBackupRetention({ connection, deleter }).run(config);
    process.stdout.write(JSON.stringify({ event: 'backup.retention_finished', ...result }) + '\n');
  } finally {
    deleter.close();
    await fence?.close();
    await connection.pool.end();
  }
}
try {
  await main();
} catch {
  process.stderr.write(
    'Backup retention failed. Check the private operator configuration and protected store; existing reservations remain.\n',
  );
  process.exitCode = 1;
}

import { resolve } from 'node:path';
import {
  CloudError,
  operationIdSchema,
  operatorRecoverySchema,
} from '../packages/contracts/dist/index.js';
import { connect } from '../packages/db/dist/index.js';
import { HetznerInventory } from '../packages/hetzner/dist/index.js';
import { readPrivateFile } from '../apps/control/dist/private-file.js';
import { SimulatedProvider } from '../apps/control/dist/simulated-provider.js';
import {
  applyOperatorRecovery,
  inspectOperatorRecovery,
} from '../apps/control/dist/operator-recovery.js';

async function main() {
  const [command, argument, ...extra] = process.argv.slice(2);
  if (!['inspect', 'apply'].includes(command ?? '') || !argument || extra.length)
    throw new CloudError(
      'invalid_input',
      'Usage: pnpm machine:recover inspect <cleanup-operation-id> | apply <request.json>',
    );
  const url = process.env.DATABASE_URL;
  if (!url)
    throw new CloudError('invalid_input', 'DATABASE_URL is required; apply migrations first.');
  const connection = connect(url);
  try {
    if (command === 'inspect')
      return await inspectOperatorRecovery(connection, operationIdSchema.parse(argument));
    const request = operatorRecoverySchema.parse(
      JSON.parse(await readPrivateFile(resolve(argument))),
    );
    const inspection = await inspectOperatorRecovery(connection, request.operationId);
    const provider =
      inspection.allocation.provider === 'simulated'
        ? new SimulatedProvider({ db: connection.db })
        : inspection.allocation.provider === 'hetzner'
          ? new HetznerInventory({
              token: await readPrivateFile(
                resolve(process.env.HCLOUD_TOKEN_FILE ?? '.local/hcloud-token'),
              ),
            })
          : undefined;
    if (!provider) throw new CloudError('invalid_input', 'Unsupported allocation provider.');
    return await applyOperatorRecovery({ connection, provider, request });
  } finally {
    await connection.pool.end();
  }
}

try {
  process.stdout.write(JSON.stringify(await main()) + '\n');
} catch (error) {
  // Never echo request contents, database URLs, token files or provider response bodies.
  process.stderr.write(
    JSON.stringify({
      error:
        error instanceof CloudError
          ? error.failure
          : {
              code: 'invalid_input',
              message: 'Recovery failed; check input, database and provider access.',
              retryable: false,
            },
    }) + '\n',
  );
  process.exitCode = 1;
}

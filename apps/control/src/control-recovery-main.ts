import { resolve } from 'node:path';
import { CloudError, operationIdSchema } from '@agent-cloud/contracts';
import { connect, controlState } from '@agent-cloud/db';
import { HetznerInventory } from '@agent-cloud/hetzner';
import { readConfig } from './config.js';
import { readPrivateFile } from './private-file.js';
import { SimulatedProvider } from './simulated-provider.js';
import type { RecoveryProvider } from './operator-recovery.js';
import { inspectControlRecovery } from './control-recovery-inspection.js';
import { createControlRecoveryVerifiers } from './control-recovery-verifiers.js';
import {
  applyControlRecovery,
  controlRecoveryRequestSchema,
  inspectControlOperation,
  prepareControlGeneration,
} from './control-recovery.js';

async function main() {
  const [command, argument, ...extra] = process.argv.slice(2);
  if (
    extra.length ||
    !['prepare', 'apply', 'inspect', 'operation'].includes(command ?? '') ||
    (command === 'inspect' ? argument !== undefined : !argument)
  )
    throw new CloudError(
      'invalid_input',
      'Usage: control-recover prepare <new-absolute-file> | apply <private-request.json> | inspect | operation <operation-id>',
    );
  if (command === 'prepare' && argument) return prepareControlGeneration(argument);
  const config = readConfig();
  const connection = connect(config.databaseUrl);
  const verifiers = createControlRecoveryVerifiers({ connection, config });
  let inventory: Promise<RecoveryProvider> | undefined;
  const getInventory = () =>
    (inventory ??=
      config.provider === 'hetzner'
        ? readPrivateFile(config.providerTokenFile).then((token) => new HetznerInventory({ token }))
        : Promise.resolve(new SimulatedProvider({ db: connection.db })));
  // Credential reads are lazy: fencing restored authority never needs a working provider or signer.
  const provider: RecoveryProvider = {
    kind: config.provider,
    getServer: async (input) => (await getInventory()).getServer(input),
    getPrimaryIp: async (input) => (await getInventory()).getPrimaryIp(input),
    getAction: async (input) => (await getInventory()).getAction(input),
    findServers: async (input) => (await getInventory()).findServers(input),
    findPrimaryIps: async (input) => (await getInventory()).findPrimaryIps(input),
  };
  try {
    if (command === 'inspect') {
      const [state] = await connection.db.select().from(controlState);
      return {
        state: state?.state ?? { kind: 'uninitialized' },
        ...(await inspectControlRecovery({ db: connection.db, provider, ...verifiers })),
      };
    }
    if (command === 'operation' && argument) {
      const result = await inspectControlOperation(
        connection.db,
        operationIdSchema.parse(argument),
      );
      return {
        operationId: result.operationId,
        expectedState: result.expectedState,
        resources: result.resources.map((row) => ({ kind: row.kind, id: row.providerId })),
        allocationId: result.allocation?.id ?? null,
      };
    }
    if (command === 'apply' && argument)
      return await applyControlRecovery({
        connection,
        provider,
        ...verifiers,
        path: config.controlGenerationFile ?? resolve('.local/control-generation.json'),
        request: controlRecoveryRequestSchema.parse(
          JSON.parse(await readPrivateFile(resolve(argument))),
        ),
      });
    throw new CloudError('invalid_input', 'Unknown recovery command.');
  } finally {
    verifiers.close();
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
              code: 'invalid_input',
              message:
                'Control recovery failed. Check private configuration and the recorded recovery state.',
              retryable: false,
            },
    }) + '\n',
  );
  process.exitCode = 1;
}

import { z } from 'zod';
import { connect } from '../../packages/db/src/index.js';
import {
  operationIdSchema,
  type MachineProvider,
  type Submission,
} from '../../packages/contracts/src/index.js';
import { SimulatedProvider } from '../../apps/control/src/simulated-provider.js';
import { advanceOperation } from '../../apps/control/src/advance-operation.js';

const url = z.url().parse(process.env.CRASH_TEST_DATABASE_URL);
if (!/^\/agentcloud_test_[0-9a-f]{32}$/.test(new URL(url).pathname)) {
  throw new Error('Crash fixture requires an isolated test database.');
}
const operationId = operationIdSchema.parse(process.env.CRASH_TEST_OPERATION_ID);
const connection = connect(url);
const target = z
  .enum(['create', 'create_primary_ip', 'delete_primary_ip'])
  .default('create')
  .parse(process.env.CRASH_TEST_EFFECT_KIND);

class CrashAfterSubmit extends SimulatedProvider {
  override async submit(input: Parameters<MachineProvider['submit']>[0]): Promise<Submission> {
    const outcome = await super.submit(input);
    if (input.command.kind !== target) return outcome;
    if (outcome.kind !== 'accepted' && outcome.kind !== 'completed')
      throw new Error('Crash fixture expected a submitted effect.');
    if (outcome.kind === 'accepted') await super.getAction({ actionId: outcome.actionId });
    // Exit after the external commit, while the control journal still says prepared.
    process.exit(86);
  }
}

for (let step = 0; step < 10; step++)
  await advanceOperation({
    limits: { currency: 'EUR', maxMachines: 100, maxHourlyMicros: 10000000 },
    connection,
    operationId,
    provider: new CrashAfterSubmit({ db: connection.db, retainPrimaryIps: true }),
  });
throw new Error('Crash fixture unexpectedly survived submission.');

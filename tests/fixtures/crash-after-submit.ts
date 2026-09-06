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

class CrashAfterSubmit extends SimulatedProvider {
  override async submit(input: Parameters<MachineProvider['submit']>[0]): Promise<Submission> {
    const outcome = await super.submit(input);
    if (outcome.kind !== 'accepted') throw new Error('Crash fixture expected a submitted action.');
    await super.getAction({ actionId: outcome.actionId });
    // Exit after the external commit, while the control journal still says prepared.
    process.exit(86);
  }
}

await advanceOperation({
  connection,
  operationId,
  provider: new CrashAfterSubmit({ db: connection.db }),
});
throw new Error('Crash fixture unexpectedly survived submission.');

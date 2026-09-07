import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  allocationIdSchema,
  operationResponseSchema,
  operationProgressSchema,
  simulatedCatalog,
  type GuestImage,
  type MachineProvider,
} from '../../packages/contracts/dist/index.js';
import { allocations, operations, type Connection } from '../../packages/db/src/index.js';
import { createApp } from '../../apps/control/src/app.js';
import { advanceOperation } from '../../apps/control/src/advance-operation.js';
import { BootstrapSeal } from '../../apps/control/src/bootstrap-seal.js';
import { recoverGuestBootstrap } from '../../apps/control/src/guest-bootstrap.js';
import { createGuestRenderer } from '../../apps/control/src/guest-renderer.js';
import { SimulatedProvider } from '../../apps/control/src/simulated-provider.js';
import { seedAccount } from '../../tests/database.js';

/** Real control state with simulated provider observations of an owned local SSH server. */
export async function prepareEnrollmentFixture(input: {
  connection: Connection;
  image: GuestImage;
  address: string;
  enrollmentUrl: string;
}) {
  const { connection, image, address, enrollmentUrl } = input;
  const db = connection.db;
  const account = await seedAccount(db);
  const seal = new BootstrapSeal(randomBytes(32).toString('base64'));
  const render = createGuestRenderer(db, seal);
  const limits = { currency: 'EUR', maxMachines: 1, maxHourlyMicros: 20_000 };
  const simulation = new SimulatedProvider({
    db,
    catalog: () => ({ ...simulatedCatalog(), provider: 'hetzner' }),
  });
  let userData: string | undefined;
  const provider: MachineProvider = {
    kind: 'hetzner',
    getCatalog: () => simulation.getCatalog(),
    submit: async (input) => {
      if (input.command.kind === 'create_guest')
        userData = (await render({ attemptId: input.attemptId, command: input.command })).userData;
      return simulation.submit(input);
    },
    getAction: (input) => simulation.getAction(input),
    findServers: (input) => simulation.findServers(input),
    findPrimaryIps: (input) => simulation.findPrimaryIps(input),
    getServer: async (input) => {
      const server = await simulation.getServer(input);
      return server && { ...server, ipv4: address };
    },
    getPrimaryIp: async (input) => {
      const ip = await simulation.getPrimaryIp(input);
      return ip && { ...ip, ipv4: address };
    },
  };
  const admission = createApp({ db, provider: provider.kind, limits, catalog: simulation.catalog });
  const response = await admission.request(`/v1/projects/${account.projectId}/machines`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${account.token}`,
      'Idempotency-Key': randomUUID(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'native-enrollment', size: 'small', region: 'nbg1' }),
  });
  assert.equal(response.status, 202);
  const { operation } = operationResponseSchema.parse(await response.json());
  for (let tick = 0; tick < 6; tick++)
    await advanceOperation({
      connection,
      operationId: operation.id,
      provider,
      limits,
      guest: { kind: 'enabled', image, seal, enrollmentUrl },
    });
  const [allocation] = await db
    .select()
    .from(allocations)
    .where(eq(allocations.machineId, operation.machineId));
  if (!allocation || !userData)
    throw new Error('Expected guest allocation and rendered user data.');
  const progress = operationProgressSchema.parse(
    (await db.select().from(operations).where(eq(operations.id, operation.id)))[0]?.progress,
  );
  assert.equal(progress.kind, 'waiting_guest');
  const bootstrap = await recoverGuestBootstrap(db, {
    reference: { version: 1, allocationId: allocationIdSchema.parse(allocation.id) },
    seal,
  });
  return {
    provider,
    seal,
    limits,
    catalog: simulation.catalog,
    operation,
    allocation,
    bootstrap,
    userData,
  };
}

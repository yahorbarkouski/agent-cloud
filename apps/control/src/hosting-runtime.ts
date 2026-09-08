import { and, eq, isNull } from 'drizzle-orm';
import {
  CloudError,
  bootstrapSpecSchema,
  guestSubject,
  hostingGuestRouteSchema,
  hostingControlConfigSchema,
  type routeSchema,
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
import type { Signer } from '@agent-cloud/pki';
import { guestName } from '@agent-cloud/pki';
import { runHostingCommand } from '@agent-cloud/remote';
import type { z } from 'zod';
import { observeGuest } from './guest-observation.js';
import { createHosting } from './hosting.js';
import { readPrivateFile } from './private-file.js';

export async function createHostingRuntime(input: {
  connection: Connection;
  path: string;
  controlOrigin: string;
  provider: MachineProvider;
  signer: () => Promise<Pick<Signer, 'issueHostingCredential'>>;
  remote?: typeof runHostingCommand;
}) {
  const config = hostingControlConfigSchema.parse(JSON.parse(await readPrivateFile(input.path)));
  const service = createHosting({
    db: input.connection.db,
    config,
    applyGuest,
    reservedHostnames: [new URL(input.controlOrigin).hostname],
  });
  async function applyGuest(route: z.infer<typeof routeSchema>) {
    const locked = await withMachineLock({
      pool: input.connection.pool,
      machineId: route.machineId,
      work: async (db) => {
        const [row] = await db
          .select()
          .from(machines)
          .where(and(eq(machines.id, route.machineId), eq(machines.accountId, route.accountId)));
        if (!row) throw new CloudError('not_found', 'Route machine not found.');
        const machine = machineRecord(row);
        if (route.state === 'removed' && machine.state.kind === 'destroyed') return null;
        if (
          machine.state.kind !== 'allocated' ||
          machine.state.allocationId !== route.allocationId ||
          machine.state.guest.kind !== 'ssh'
        )
          throw new CloudError('resource_busy', 'Route allocation is no longer available.');
        const [allocation] = await db
          .select()
          .from(allocations)
          .where(and(eq(allocations.id, route.allocationId), isNull(allocations.retiredAt)));
        const [bootstrap] = await db
          .select()
          .from(guestBootstraps)
          .where(eq(guestBootstraps.allocationId, route.allocationId));
        if (!allocation || !bootstrap)
          throw new CloudError('resource_busy', 'Route guest identity is unavailable.');
        const spec = bootstrapSpecSchema.parse(bootstrap.spec);
        const observed = await observeGuest(db, input.provider, { allocation, spec });
        const subject = guestSubject(spec);
        const credential = await (await input.signer()).issueHostingCredential(subject);
        const retainFromVersion = route.gatewayAppliedVersion ?? 1;
        const command =
          route.state === 'removed'
            ? ({
                kind: 'remove',
                hostname: route.hostname,
                version: route.version,
                retainFromVersion,
              } satisfies Parameters<typeof runHostingCommand>[0]['command'])
            : ({
                kind: 'put',
                hostname: route.hostname,
                version: route.version,
                port: route.port,
                retainFromVersion,
              } satisfies Parameters<typeof runHostingCommand>[0]['command']);
        const reply = await (input.remote ?? runHostingCommand)({
          subject,
          address: observed.address,
          hostCa: spec.image.sshHostCa,
          credential,
          command,
        });
        const expected = hostingGuestRouteSchema.parse(
          route.state === 'removed'
            ? { kind: 'remove', hostname: route.hostname, version: route.version }
            : { kind: 'put', hostname: route.hostname, version: route.version, port: route.port },
        );
        if (JSON.stringify(reply.route) !== JSON.stringify(expected))
          throw new CloudError(
            'guest_unreachable',
            'Guest did not acknowledge the requested route version.',
            true,
          );
        return { address: observed.address, serverName: guestName(subject) };
      },
    });
    if (locked.kind === 'busy')
      throw new CloudError('resource_busy', 'Route machine has another active operation.', true);
    return locked.value;
  }
  return { service, gatewayTokenFile: config.gatewayTokenFile };
}

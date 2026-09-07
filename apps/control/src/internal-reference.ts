import { and, eq, isNull } from 'drizzle-orm';
import {
  CloudError,
  bootstrapSpecSchema,
  guestSubject,
  type GrantId,
  type Principal,
  type MachineId,
  type MachineProvider,
  type ReferenceInput,
} from '@agent-cloud/contracts';
import {
  allocations,
  grants,
  guestBootstraps,
  machines,
  machineRecord,
  withMachineLock,
  type Connection,
} from '@agent-cloud/db';
import type { Signer } from '@agent-cloud/pki';
import { runReferenceCommand } from '@agent-cloud/remote';
import { authorize, loadAuthority } from './auth.js';
import { lockAccount } from './lifecycle.js';
import { observeGuest } from './guest-observation.js';

/** Explicit root-grant allowlist for the original plan's private internal deployment slice. */
export function createInternalReference(input: {
  connection: Connection;
  grantId: GrantId;
  provider: MachineProvider;
  signer: () => Promise<Pick<Signer, 'issueDeploymentCredential'>>;
  remote?: typeof runReferenceCommand;
}) {
  return async (principal: Principal, machineId: MachineId, command: ReferenceInput) => {
    if (principal.grantId !== input.grantId)
      throw new CloudError(
        'permission_denied',
        'Reference deployment is restricted to the configured internal identity.',
      );
    const locked = await withMachineLock({
      pool: input.connection.pool,
      machineId,
      work: (db) =>
        db.transaction(async (tx) => {
          await lockAccount(tx, principal);
          const authority = await loadAuthority(tx, principal.grantId);
          const [root] = await tx
            .select({ id: grants.id })
            .from(grants)
            .where(and(eq(grants.id, input.grantId), isNull(grants.parentId)));
          if (
            !root ||
            authority.principal.accountId !== principal.accountId ||
            authority.expiresAt.getTime() - authority.checkedAt.getTime() < 60_000
          )
            throw new CloudError(
              'permission_denied',
              'Internal deployment requires an active root identity with at least one minute remaining.',
            );
          const [row] = await tx
            .select()
            .from(machines)
            .where(and(eq(machines.id, machineId), eq(machines.accountId, principal.accountId)));
          if (!row) throw new CloudError('not_found', 'Machine not found.');
          const machine = machineRecord(row);
          authorize(
            authority.principal,
            command.kind === 'apply' ? 'deploy:write' : 'machine:read',
            machine.projectId,
          );
          if (command.kind === 'apply')
            authorize(authority.principal, 'route:publish', machine.projectId);
          if (machine.state.kind !== 'allocated' || machine.state.guest.kind !== 'ssh')
            throw new CloudError(
              'resource_busy',
              'Reference deployment requires a verified allocated guest.',
            );
          const [allocation] = await tx
            .select()
            .from(allocations)
            .where(
              and(eq(allocations.id, machine.state.allocationId), isNull(allocations.retiredAt)),
            );
          const [bootstrap] = await tx
            .select()
            .from(guestBootstraps)
            .where(eq(guestBootstraps.allocationId, machine.state.allocationId));
          if (!allocation || !bootstrap)
            throw new CloudError('resource_busy', 'Guest allocation is unavailable.');
          const spec = bootstrapSpecSchema.parse(bootstrap.spec);
          const observed = await observeGuest(db, input.provider, { allocation, spec });
          const subject = guestSubject(spec);
          const credential = await (await input.signer()).issueDeploymentCredential(subject);
          // Generated test hostname points only to the currently owned provider address. No arbitrary ACME names.
          const hostname = `acld-${machine.id.slice(-12)}.${observed.address.replaceAll('.', '-')}.sslip.io`;
          return (input.remote ?? runReferenceCommand)({
            subject,
            address: observed.address,
            hostCa: spec.image.sshHostCa,
            credential,
            command: command.kind === 'apply' ? { ...command, hostname } : command,
          });
        }),
    });
    if (locked.kind === 'busy')
      throw new CloudError('resource_busy', 'Machine has another active operation.', true);
    return locked.value;
  };
}
export type InternalReference = ReturnType<typeof createInternalReference>;

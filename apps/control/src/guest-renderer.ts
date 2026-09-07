import { isDeepStrictEqual } from 'node:util';
import { and, eq, isNull } from 'drizzle-orm';
import {
  CloudError,
  catalogItemSchema,
  providerCommandSchema,
  attemptOutcomeSchema,
  effectResolutionSchema,
} from '@agent-cloud/contracts';
import { allocations, attempts, type Database } from '@agent-cloud/db';
import type { GuestRenderer } from '@agent-cloud/hetzner';
import type { BootstrapSeal } from './bootstrap-seal.js';
import { recoverGuestBootstrap } from './guest-bootstrap.js';
import { matchesLabels } from './resource-journal.js';

/** Called only for the initial journaled submission, never by effect reconciliation. */
export function createGuestRenderer(db: Database, seal: BootstrapSeal): GuestRenderer {
  return async (input) => {
    const [attempt] = await db.select().from(attempts).where(eq(attempts.id, input.attemptId));
    const [allocation] = await db
      .select()
      .from(allocations)
      .where(
        and(
          eq(allocations.id, input.command.bootstrap.allocationId),
          isNull(allocations.retiredAt),
        ),
      );
    if (
      !attempt ||
      !allocation ||
      attempt.accountId !== allocation.accountId ||
      allocation.provider !== 'hetzner' ||
      attemptOutcomeSchema.parse(attempt.outcome).kind !== 'prepared' ||
      effectResolutionSchema.parse(attempt.resolution).kind !== 'pending' ||
      !isDeepStrictEqual(
        providerCommandSchema.parse(attempt.command),
        providerCommandSchema.parse(input.command),
      )
    )
      throw new CloudError(
        'provider_rejected',
        'Guest rendering requires its exact prepared provider attempt.',
      );
    const offer = catalogItemSchema.parse(allocation.offer);
    if (
      input.command.serverType !== offer.serverType ||
      input.command.region !== offer.region ||
      input.command.name !== allocation.machineId.replaceAll('_', '-')
    )
      throw new CloudError(
        'provider_rejected',
        'Guest create does not match its admitted allocation.',
      );
    const { spec, token } = await recoverGuestBootstrap(db, {
      reference: input.command.bootstrap,
      seal,
    });
    const labels = {
      managed_by: 'agent-cloud',
      account_id: spec.accountId,
      machine_id: spec.machineId,
      allocation_id: spec.allocationId,
      operation_id: spec.operationId,
    };
    if (spec.operationId !== attempt.operationId || !matchesLabels(input.command.labels, labels))
      throw new CloudError('provider_rejected', 'Guest command does not own its bootstrap.');
    // JSON is valid YAML. Fixed paths and argv avoid shell interpolation of bootstrap fields.
    const configuration = {
      users: [],
      disable_root: true,
      ssh_pwauth: false,
      allow_public_ssh_keys: false,
      ssh_deletekeys: true,
      // An explicit key map suppresses cloud-init generation; guestctl owns the host identity.
      ssh_keys: {},
      ssh_publish_hostkeys: { enabled: false },
      write_files: [
        {
          path: '/var/lib/agent-cloud/bootstrap.json',
          owner: 'root:root',
          permissions: '0600',
          content: JSON.stringify({ spec, token }) + '\n',
        },
      ],
      runcmd: [['systemctl', 'start', '--no-block', 'agent-cloud-enroll.service']],
    };
    return {
      image: spec.image.providerImage,
      userData: '#cloud-config\n' + JSON.stringify(configuration) + '\n',
    };
  };
}

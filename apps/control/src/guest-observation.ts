import { and, eq, isNull } from 'drizzle-orm';
import {
  CloudError,
  providerServerSchema,
  providerPrimaryIpSchema,
  catalogItemSchema,
  type BootstrapSpec,
  type MachineProvider,
} from '@agent-cloud/contracts';
import { type allocations, providerResources, type Database } from '@agent-cloud/db';
import { matchesLabels, ownedLabels } from './resource-journal.js';

export async function observeGuest(
  db: Database,
  provider: MachineProvider,
  context: { allocation: typeof allocations.$inferSelect; spec: BootstrapSpec },
) {
  if (context.allocation.provider !== provider.kind || !context.allocation.serverId)
    throw new CloudError(
      'provider_unavailable',
      'Guest provider allocation is not recorded yet.',
      true,
    );
  const resources = await db
    .select()
    .from(providerResources)
    .where(
      and(
        eq(providerResources.allocationId, context.spec.allocationId),
        eq(providerResources.accountId, context.spec.accountId),
        isNull(providerResources.absentAt),
      ),
    );
  const servers = resources.filter((value) => value.kind === 'server');
  const ips = resources.filter((value) => value.kind === 'primary_ip');
  const serverResource = servers[0];
  const ipResource = ips[0];
  if (
    servers.length !== 1 ||
    ips.length !== 1 ||
    !serverResource ||
    !ipResource ||
    serverResource.providerId !== context.allocation.serverId ||
    resources.some((value) => value.provider !== provider.kind)
  )
    throw new CloudError(
      'provider_unavailable',
      'Guest needs one recorded owned VM and Primary IP.',
      true,
    );
  const expectedLabels = {
    managed_by: 'agent-cloud',
    account_id: context.spec.accountId,
    machine_id: context.spec.machineId,
    allocation_id: context.spec.allocationId,
    operation_id: context.spec.operationId,
  };
  if (
    !matchesLabels(ownedLabels(serverResource), expectedLabels) ||
    !matchesLabels(ownedLabels(ipResource), expectedLabels)
  )
    throw new CloudError(
      'provider_unavailable',
      'Guest ownership journal is incomplete or inconsistent.',
      true,
    );
  const [serverValue, ipValue] = await Promise.all([
    provider.getServer({ serverId: serverResource.providerId }),
    provider.getPrimaryIp({ primaryIpId: ipResource.providerId }),
  ]);
  if (!serverValue || !ipValue)
    throw new CloudError('provider_unavailable', 'Guest provider resources are not visible.', true);
  const server = providerServerSchema.parse(serverValue);
  const ip = providerPrimaryIpSchema.parse(ipValue);
  const offer = catalogItemSchema.parse(context.allocation.offer);
  if (
    server.serverType !== offer.serverType ||
    server.region !== offer.region ||
    ip.region !== offer.region
  )
    throw new CloudError(
      'provider_unavailable',
      'Guest resources do not match the admitted type and region.',
      true,
    );
  if (
    server.id !== serverResource.providerId ||
    ip.id !== ipResource.providerId ||
    !matchesLabels(server.labels, expectedLabels) ||
    !matchesLabels(ip.labels, expectedLabels) ||
    server.primaryIpId !== ip.id ||
    server.ipv4 !== ip.ipv4 ||
    ip.assignment.kind !== 'server' ||
    ip.assignment.serverId !== server.id ||
    server.power !== 'running'
  )
    throw new CloudError(
      'provider_unavailable',
      'Guest provider identity or IP assignment does not match.',
      true,
    );
  return { address: ip.ipv4, server };
}

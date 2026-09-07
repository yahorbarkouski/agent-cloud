import { z } from 'zod';
import { CloudError } from '@agent-cloud/contracts';
import { HttpError, type createHetznerRequest } from './http.js';

/** Guest services authenticate SSH with certificates and control HTTPS with mutual TLS. */
export const customerFirewallRules = ['22', '80', '443'].map((port) => ({
  direction: 'in',
  protocol: 'tcp',
  port,
  source_ips: ['0.0.0.0/0'],
}));
const firewallSchema = z.object({
  firewall: z.object({
    id: z.int().positive(),
    labels: z.record(z.string(), z.string()),
    rules: z.array(
      z.object({
        direction: z.string(),
        protocol: z.string(),
        port: z.string().nullable().optional(),
        source_ips: z.array(z.string()),
        destination_ips: z.array(z.string()),
      }),
    ),
  }),
});

/** Read-only check before fresh allocation effects; cleanup never depends on this policy. */
export async function checkCustomerFirewalls(
  request: ReturnType<typeof createHetznerRequest>,
  ids: number[],
) {
  for (const id of ids) {
    let firewall;
    try {
      ({ firewall } = firewallSchema.parse(await request({ path: `/firewalls/${id}` })));
    } catch (error) {
      if (error instanceof HttpError && error.status === 404 && error.code === 'not_found')
        throw new CloudError('permission_denied', 'Configured customer firewall no longer exists.');
      throw new CloudError(
        'provider_unavailable',
        'Customer firewall observation is unavailable or invalid.',
        true,
      );
    }
    const allowed = new Set(['22', '80', '443']);
    if (
      firewall.id !== id ||
      firewall.labels.managed_by !== 'agent-cloud' ||
      firewall.labels.role !== 'customer_access' ||
      firewall.rules.length !== 3 ||
      !firewall.rules.every((rule) => {
        if (
          rule.direction !== 'in' ||
          rule.protocol !== 'tcp' ||
          rule.destination_ips.length !== 0 ||
          rule.source_ips.length !== 1 ||
          rule.source_ips[0] !== '0.0.0.0/0' ||
          !rule.port ||
          !allowed.delete(rule.port)
        )
          return false;
        return true;
      }) ||
      allowed.size !== 0
    )
      throw new CloudError(
        'permission_denied',
        'Customer firewall ownership or ingress policy differs from its configuration.',
      );
  }
}

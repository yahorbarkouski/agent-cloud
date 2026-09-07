import { z } from 'zod';
import { createHetznerRequest, HttpError } from './http.js';
export { createHetznerRequest } from './http.js';
export { checkCustomerFirewalls, customerFirewallRules } from './customer-firewall.js';
export { HetznerImageProvider, type ImageBootRenderer } from './image-release.js';
export { readHetznerImagePrice } from './image-pricing.js';
import {
  readHetznerCatalog,
  offerConfigurationSchema,
  type OfferConfiguration,
} from './catalog.js';
export {
  readHetznerCatalog,
  offerConfigurationSchema,
  type OfferConfiguration,
} from './catalog.js';
import {
  CloudError,
  type MachineProvider,
  type ProviderServer,
  type ProviderAction,
  type Submission,
  type ProviderPrimaryIp,
  type ProviderCommand,
} from '@agent-cloud/contracts';

const numericId = z.int().positive();
const actionSchema = z.object({ id: numericId, status: z.enum(['running', 'success', 'error']) });
const serverSchema = z.object({
  id: numericId,
  name: z.string(),
  status: z.string(),
  server_type: z.object({ name: z.string() }),
  location: z.object({ name: z.string() }),
  labels: z.record(z.string(), z.string()),
  public_net: z.object({ ipv4: z.object({ id: numericId, ip: z.string() }).nullable() }),
});

const primaryIpSchema = z
  .object({
    id: numericId,
    name: z.string(),
    type: z.enum(['ipv4', 'ipv6']),
    ip: z.string(),
    location: z.object({ name: z.string() }),
    labels: z.record(z.string(), z.string()),
    auto_delete: z.boolean(),
    assignee_type: z.enum(['server', 'unassigned']),
    assignee_id: numericId.nullable(),
  })
  .refine(
    (value) => (value.assignee_type === 'unassigned') === (value.assignee_id === null),
    'Primary IP assignment type and ID must agree.',
  );
function primaryIpRecord(value: z.infer<typeof primaryIpSchema>): ProviderPrimaryIp {
  if (value.type !== 'ipv4')
    throw new CloudError('provider_outcome_unknown', 'Expected an IPv4 Primary IP.');
  return {
    id: String(value.id),
    name: value.name,
    region: value.location.name,
    ipv4: z.ipv4().parse(value.ip),
    labels: value.labels,
    autoDelete: value.auto_delete,
    assignment:
      value.assignee_id === null
        ? { kind: 'unassigned' }
        : { kind: 'server', serverId: String(value.assignee_id) },
  };
}

function serverRecord(value: z.infer<typeof serverSchema>): ProviderServer {
  const power =
    value.status === 'running' ||
    value.status === 'off' ||
    value.status === 'starting' ||
    value.status === 'stopping'
      ? value.status
      : 'unknown';
  return {
    id: String(value.id),
    name: value.name,
    serverType: value.server_type.name,
    region: value.location.name,
    power,
    labels: value.labels,
    ipv4: value.public_net.ipv4?.ip ?? null,
    primaryIpId: value.public_net.ipv4 ? String(value.public_net.ipv4.id) : null,
  };
}

const accessSchema = z.strictObject({
  firewallIds: z.array(numericId).min(1),
});
const renderedGuestSchema = z.strictObject({
  image: z.string().min(1),
  userData: z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value) <= 32768, 'Cloud-init must fit 32 KiB.'),
});
export type GuestRenderer = (input: {
  attemptId: Parameters<MachineProvider['submit']>[0]['attemptId'];
  command: Extract<ProviderCommand, { kind: 'create_guest' }>;
}) => Promise<z.infer<typeof renderedGuestSchema>>;

/** Transport adapter only. Activating live work also requires the control-plane guest and cleanup checks. */
export class HetznerProvider implements MachineProvider {
  readonly kind = 'hetzner';
  private readonly request: ReturnType<typeof createHetznerRequest>;
  private readonly offers: OfferConfiguration;
  private readonly access: z.infer<typeof accessSchema>;
  private readonly renderGuest: GuestRenderer;

  constructor(input: {
    token: string;
    offers: OfferConfiguration;
    access: z.infer<typeof accessSchema>;
    renderGuest: GuestRenderer;
    transport?: typeof fetch;
  }) {
    this.offers = offerConfigurationSchema.parse(input.offers);
    this.request = createHetznerRequest(input);
    this.access = accessSchema.parse(input.access);
    this.renderGuest = input.renderGuest;
  }

  getCatalog() {
    return readHetznerCatalog({
      request: (input) => this.request(input),
      configuration: this.offers,
    });
  }

  async submit(input: Parameters<MachineProvider['submit']>[0]): Promise<Submission> {
    const { command } = input;
    try {
      if (command.kind === 'create_primary_ip') {
        const result = z
          .object({ primary_ip: primaryIpSchema, action: actionSchema.nullable().optional() })
          .parse(
            await this.request({
              path: '/primary_ips',
              method: 'POST',
              body: {
                name: command.name,
                type: 'ipv4',
                location: command.region,
                auto_delete: true,
                labels: { ...command.labels, attempt_id: input.attemptId },
              },
            }),
          );
        const resource = { kind: 'primary_ip', id: String(result.primary_ip.id) } satisfies {
          kind: 'primary_ip';
          id: string;
        };
        return result.action
          ? { kind: 'accepted', resource, actionId: String(result.action.id) }
          : { kind: 'completed', resource };
      }
      if (command.kind === 'delete_primary_ip') {
        const id = z
          .string()
          .regex(/^[1-9][0-9]*$/)
          .parse(command.primaryIpId);
        await this.request({ path: `/primary_ips/${id}`, method: 'DELETE' });
        return { kind: 'completed', resource: { kind: 'primary_ip', id } };
      }
      if (command.kind === 'create')
        return {
          kind: 'rejected',
          error: {
            code: 'invalid_input',
            message: 'New live VMs require an allocation bootstrap reference.',
            retryable: false,
          },
        };
      if (command.kind === 'create_guest') {
        let guest: z.infer<typeof renderedGuestSchema>;
        try {
          guest = renderedGuestSchema.parse(
            await this.renderGuest({ attemptId: input.attemptId, command }),
          );
        } catch {
          // No provider request has happened. Do not classify a local preparation failure as uncertain.
          return {
            kind: 'rejected',
            error: {
              code: 'provider_rejected',
              message: 'Guest bootstrap could not be prepared for submission.',
              retryable: false,
            },
          };
        }
        const primaryIpId = z
          .string()
          .regex(/^[1-9][0-9]*$/)
          .parse(command.network.id);
        const body = await this.request({
          path: '/servers',
          method: 'POST',
          body: {
            name: command.name,
            server_type: command.serverType,
            location: command.region,
            image: guest.image,
            labels: { ...command.labels, attempt_id: input.attemptId },
            firewalls: this.access.firewallIds.map((firewall) => ({ firewall })),
            ssh_keys: [],
            user_data: guest.userData,
            start_after_create: true,
            automount: false,
            public_net: { enable_ipv4: true, ipv4: Number(primaryIpId), enable_ipv6: false },
          },
        });
        const result = z
          .object({ server: z.object({ id: numericId }), action: actionSchema })
          .parse(body);
        return {
          kind: 'accepted',
          resource: { kind: 'server', id: String(result.server.id) },
          actionId: String(result.action.id),
        };
      }
      const id = z
        .string()
        .regex(/^[1-9][0-9]*$/)
        .parse(command.serverId);
      let path: string;
      let body: unknown;
      switch (command.kind) {
        case 'destroy':
          path = `/servers/${id}`;
          break;
        case 'reboot':
          path = `/servers/${id}/actions/reboot`;
          break;
        case 'power_on':
          path = `/servers/${id}/actions/poweron`;
          break;
        case 'power_off':
          path = `/servers/${id}/actions/shutdown`;
          break;
        case 'resize':
          path = `/servers/${id}/actions/change_type`;
          body = { server_type: command.serverType, upgrade_disk: true };
          break;
      }
      const response = await this.request({
        path,
        method: command.kind === 'destroy' ? 'DELETE' : 'POST',
        body,
      });
      const result = z.object({ action: actionSchema }).parse(response);
      return {
        kind: 'accepted',
        resource: { kind: 'server', id },
        actionId: String(result.action.id),
      };
    } catch (error) {
      if (
        error instanceof HttpError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408 &&
        error.code !== 'timeout' &&
        error.code !== 'invalid_response'
      ) {
        return {
          kind: 'rejected',
          error: {
            code:
              error.code === 'resource_unavailable' ? 'capacity_unavailable' : 'provider_rejected',
            message: `Hetzner rejected the request with HTTP ${error.status}.`,
            retryable: error.status === 429 || error.code === 'resource_unavailable',
          },
        };
      }
      return {
        kind: 'unknown',
        reason: 'Hetzner did not return a definitive, valid submission result.',
      };
    }
  }

  async getAction(input: { actionId: string }): Promise<ProviderAction> {
    const id = z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .parse(input.actionId);
    const { action } = z
      .object({ action: actionSchema })
      .parse(await this.request({ path: `/actions/${id}` }));
    switch (action.status) {
      case 'running':
        return { kind: 'running' };
      case 'success':
        return { kind: 'succeeded' };
      case 'error':
        return {
          kind: 'failed',
          error: { code: 'provider_rejected', message: 'Hetzner action failed.', retryable: false },
        };
    }
  }

  async getServer(input: { serverId: string }): Promise<ProviderServer | null> {
    const id = z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .parse(input.serverId);
    try {
      const { server } = z
        .object({ server: serverSchema })
        .parse(await this.request({ path: `/servers/${id}` }));
      return serverRecord(server);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404 && error.code === 'not_found')
        return null;
      throw error;
    }
  }

  async getPrimaryIp(input: { primaryIpId: string }): Promise<ProviderPrimaryIp | null> {
    const id = z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .parse(input.primaryIpId);
    try {
      const result = z
        .object({ primary_ip: primaryIpSchema })
        .parse(await this.request({ path: `/primary_ips/${id}` }));
      return primaryIpRecord(result.primary_ip);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404 && error.code === 'not_found')
        return null;
      throw error;
    }
  }
  async findPrimaryIps(input: {
    labels: Readonly<Record<string, string>>;
  }): Promise<ProviderPrimaryIp[]> {
    const selector = Object.entries(input.labels)
      .map(([key, value]) => `${key}=${value}`)
      .join(',');
    const ips: ProviderPrimaryIp[] = [];
    let page: number | null = 1;
    const seen = new Set<number>();
    while (page !== null) {
      if (seen.has(page) || seen.size >= 1000)
        throw new CloudError('provider_unavailable', 'Hetzner returned invalid pagination.', true);
      seen.add(page);
      const result = z
        .object({
          primary_ips: z.array(primaryIpSchema),
          meta: z.object({ pagination: z.object({ next_page: z.int().positive().nullable() }) }),
        })
        .parse(
          await this.request({
            path: `/primary_ips?per_page=50&page=${page}&label_selector=${encodeURIComponent(selector)}`,
          }),
        );
      ips.push(
        ...result.primary_ips
          .filter(
            (ip) =>
              ip.type === 'ipv4' &&
              Object.entries(input.labels).every(([key, value]) => ip.labels[key] === value),
          )
          .map(primaryIpRecord),
      );
      page = result.meta.pagination.next_page;
    }
    return ips;
  }

  async findServers(input: {
    labels: Readonly<Record<string, string>>;
  }): Promise<ProviderServer[]> {
    const selector = Object.entries(input.labels)
      .map(([key, value]) => `${key}=${value}`)
      .join(',');
    const servers: ProviderServer[] = [];
    let page: number | null = 1;
    const seen = new Set<number>();
    while (page !== null) {
      if (seen.has(page) || seen.size >= 1000)
        throw new CloudError('provider_unavailable', 'Hetzner returned invalid pagination.', true);
      seen.add(page);
      const result = z
        .object({
          servers: z.array(serverSchema),
          meta: z.object({ pagination: z.object({ next_page: z.int().positive().nullable() }) }),
        })
        .parse(
          await this.request({
            path: `/servers?per_page=50&page=${page}&label_selector=${encodeURIComponent(selector)}`,
          }),
        );
      servers.push(
        ...result.servers
          .map(serverRecord)
          .filter((server) =>
            Object.entries(input.labels).every(([key, value]) => server.labels[key] === value),
          ),
      );
      page = result.meta.pagination.next_page;
    }
    return servers;
  }
}

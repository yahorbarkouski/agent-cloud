import { z } from 'zod';
import { createHetznerRequest, HttpError } from './http.js';
export { createHetznerRequest } from './http.js';
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
  public_net: z.object({ ipv4: z.object({ ip: z.string() }).nullable() }),
});

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
  };
}

const templateSchema = z.object({
  image: z.string().min(1),
  firewallIds: z.array(numericId).min(1),
  sshKeys: z.array(z.string().min(1)).min(1),
  userData: z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value) <= 32768, 'Cloud-init must fit 32 KiB.'),
});

/** Transport adapter only. Activating live work also requires the control-plane guest and cleanup checks. */
export class HetznerProvider implements MachineProvider {
  readonly kind = 'hetzner';
  private readonly request: ReturnType<typeof createHetznerRequest>;
  private readonly offers: OfferConfiguration;
  private readonly template: z.infer<typeof templateSchema>;

  constructor(input: {
    token: string;
    offers: OfferConfiguration;
    template: z.infer<typeof templateSchema>;
    transport?: typeof fetch;
  }) {
    this.offers = offerConfigurationSchema.parse(input.offers);
    this.request = createHetznerRequest(input);
    this.template = templateSchema.parse(input.template);
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
      if (command.kind === 'create') {
        const body = await this.request({
          path: '/servers',
          method: 'POST',
          body: {
            name: command.name,
            server_type: command.serverType,
            location: command.region,
            image: this.template.image,
            labels: { ...command.labels, attempt_id: input.attemptId },
            firewalls: this.template.firewallIds.map((firewall) => ({ firewall })),
            ssh_keys: this.template.sshKeys,
            user_data: this.template.userData,
            start_after_create: true,
            automount: false,
            public_net: { enable_ipv4: true, enable_ipv6: true },
          },
        });
        const result = z
          .object({ server: z.object({ id: numericId }), action: actionSchema })
          .parse(body);
        return {
          kind: 'accepted',
          serverId: String(result.server.id),
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
          path = `/servers/${id}/actions/poweroff`;
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
      return { kind: 'accepted', serverId: id, actionId: String(result.action.id) };
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

import { z } from 'zod';
import {
  CloudError,
  imageProviderCommandSchema,
  imageProviderIdSchema,
  imageResourceRefSchema,
  imageEffectLabels,
  type ImageAction,
  type ImageProvider,
  type ImageResourceRef,
  type ImageSubmission,
} from '@agent-cloud/contracts';
import { createHetznerRequest, HttpError } from './http.js';
import {
  decodeBaseImage,
  decodeImageResource,
  imageResourceEndpoint,
  numericImageId,
} from './image-resources.js';

const actionSchema = z.object({
  id: numericImageId,
  status: z.enum(['running', 'success', 'error']),
  resources: z.array(z.object({ id: numericImageId, type: z.string() })),
});
const pagination = z.object({ pagination: z.object({ next_page: z.int().positive().nullable() }) });
const object = z.record(z.string(), z.unknown());
const receipt = z.object({ id: numericImageId });
export type ImageBootRenderer = (input: {
  effectId: string;
  command: Extract<Parameters<ImageProvider['submit']>[0]['command'], { kind: 'create_server' }>;
}) => Promise<string>;

/** HTTP transport only. The operator journal owns permissions, budgets and retries. */
export class HetznerImageProvider implements ImageProvider {
  readonly kind = 'hetzner';
  private readonly request: ReturnType<typeof createHetznerRequest>;
  private readonly renderBoot: ImageBootRenderer;

  constructor(
    input: Parameters<typeof createHetznerRequest>[0] & { renderBoot: ImageBootRenderer },
  ) {
    this.request = createHetznerRequest(input);
    this.renderBoot = input.renderBoot;
  }

  async submit(input: Parameters<ImageProvider['submit']>[0]): Promise<ImageSubmission> {
    const effectId = z.uuid().parse(input.effectId);
    const command = imageProviderCommandSchema.parse(input.command);
    try {
      const labels =
        'labels' in command
          ? imageEffectLabels({
              buildId: command.labels.build_id,
              role: command.labels.role,
              effectId,
            })
          : {};
      switch (command.kind) {
        case 'create_ssh_key': {
          const response = object.parse(
            await this.request({
              path: '/ssh_keys',
              method: 'POST',
              body: { name: command.name, public_key: command.publicKey, labels },
            }),
          );
          return {
            kind: 'completed',
            resource: { kind: 'ssh_key', id: String(receipt.parse(response['ssh_key']).id) },
          };
        }
        case 'create_firewall': {
          const response = object.parse(
            await this.request({
              path: '/firewalls',
              method: 'POST',
              body: {
                name: command.name,
                labels,
                apply_to: [],
                rules: [
                  {
                    direction: 'in',
                    protocol: 'tcp',
                    port: '22',
                    source_ips: [`${command.managementAddress}/32`],
                  },
                ],
              },
            }),
          );
          // There are no apply-to targets. Record the ID even if a future API returns extra actions;
          // the journal verifies rules and attachments from the authoritative firewall itself.
          return {
            kind: 'completed',
            resource: { kind: 'firewall', id: String(receipt.parse(response['firewall']).id) },
          };
        }
        case 'create_primary_ip': {
          const response = object.parse(
            await this.request({
              path: '/primary_ips',
              method: 'POST',
              body: {
                name: command.name,
                type: 'ipv4',
                location: command.region,
                auto_delete: false,
                labels,
              },
            }),
          );
          const resource = {
            kind: 'primary_ip',
            id: String(receipt.parse(response['primary_ip']).id),
          } satisfies ImageResourceRef;
          return response['action'] === null || response['action'] === undefined
            ? { kind: 'completed', resource }
            : this.accepted(resource, response['action']);
        }
        case 'create_server': {
          let userData: string;
          try {
            userData = z
              .string()
              .min(1)
              .refine((value) => Buffer.byteLength(value) <= 32768)
              .parse(await this.renderBoot({ effectId, command }));
          } catch {
            return {
              kind: 'rejected',
              reason: 'Builder boot data could not be prepared; no server request was made.',
            };
          }
          const response = object.parse(
            await this.request({
              path: '/servers',
              method: 'POST',
              body: {
                name: command.name,
                server_type: command.serverType,
                location: command.region,
                image: command.imageId,
                labels,
                ssh_keys: [numericImageId.parse(Number(command.sshKeyId))],
                firewalls: [{ firewall: numericImageId.parse(Number(command.firewallId)) }],
                user_data: userData,
                start_after_create: true,
                automount: false,
                public_net: {
                  enable_ipv4: true,
                  ipv4: numericImageId.parse(Number(command.primaryIpId)),
                  enable_ipv6: false,
                },
              },
            }),
          );
          return this.accepted(
            { kind: 'server', id: String(receipt.parse(response['server']).id) },
            response['action'],
          );
        }
        case 'power_off': {
          const response = object.parse(
            await this.request({
              path: `/servers/${command.serverId}/actions/poweroff`,
              method: 'POST',
            }),
          );
          return this.accepted({ kind: 'server', id: command.serverId }, response['action']);
        }
        case 'create_snapshot': {
          const response = object.parse(
            await this.request({
              path: `/servers/${command.serverId}/actions/create_image`,
              method: 'POST',
              body: { type: 'snapshot', description: command.name, labels },
            }),
          );
          return this.accepted(
            { kind: 'snapshot', id: String(receipt.parse(response['image']).id) },
            response['action'],
          );
        }
        case 'delete': {
          const endpoint = imageResourceEndpoint(command.resource.kind);
          const response = await this.request({
            path: `${endpoint.path}/${command.resource.id}`,
            method: 'DELETE',
          });
          return command.resource.kind === 'server'
            ? this.accepted(command.resource, object.parse(response)['action'])
            : { kind: 'completed', resource: command.resource };
        }
        default: {
          const exhaustive: never = command;
          return exhaustive;
        }
      }
    } catch (error) {
      if (
        error instanceof HttpError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408 &&
        error.code !== 'timeout' &&
        error.code !== 'invalid_response'
      )
        return {
          kind: 'rejected',
          reason: `Hetzner rejected the image operation with HTTP ${error.status}.`,
        };
      return {
        kind: 'unknown',
        reason: 'Hetzner did not return a definitive valid image-operation receipt.',
      };
    }
  }

  private accepted(resource: ImageResourceRef, value: unknown): ImageSubmission {
    // Preserve a syntactically valid action ID even if its resource list is unexpected.
    // Reconciliation checks the association before trusting action status.
    const action = z.object({ id: numericImageId }).parse(value);
    return { kind: 'accepted', resource, actionId: String(action.id) };
  }

  async get(input: ImageResourceRef) {
    const ref = imageResourceRefSchema.parse(input);
    const endpoint = imageResourceEndpoint(ref.kind);
    try {
      const response = object.parse(await this.request({ path: `${endpoint.path}/${ref.id}` }));
      const resource = decodeImageResource(ref.kind, response[endpoint.one]);
      if (resource.id !== ref.id)
        throw new CloudError(
          'provider_outcome_unknown',
          'Hetzner image-resource lookup returned another identity.',
        );
      return resource;
    } catch (error) {
      if (error instanceof HttpError && error.status === 404 && error.code === 'not_found')
        return null;
      throw error;
    }
  }

  async find(input: Parameters<ImageProvider['find']>[0]) {
    const endpoint = imageResourceEndpoint(input.kind);
    const labels = z
      .record(z.string().regex(/^[a-z0-9_]+$/), z.string().regex(/^[a-zA-Z0-9_.-]+$/))
      .parse(input.labels);
    if (Object.keys(labels).length === 0)
      throw new CloudError('invalid_input', 'Image reconciliation requires ownership labels.');
    const selector = Object.entries(labels)
      .map(([key, value]) => `${key}=${value}`)
      .join(',');
    const result = [];
    let page: number | null = 1;
    const visited = new Set<number>();
    while (page !== null) {
      if (visited.has(page) || visited.size >= 100)
        throw new CloudError(
          'provider_unavailable',
          'Image resource pagination did not complete safely.',
        );
      visited.add(page);
      const response = object.parse(
        await this.request({
          path: `${endpoint.path}?per_page=50&page=${page}&label_selector=${encodeURIComponent(selector)}${input.kind === 'snapshot' ? '&type=snapshot' : ''}`,
        }),
      );
      for (const value of z.array(z.unknown()).max(50).parse(response[endpoint.list])) {
        const resource = decodeImageResource(input.kind, value);
        if (!Object.entries(labels).every(([key, value]) => resource.labels[key] === value))
          throw new CloudError(
            'provider_outcome_unknown',
            'Hetzner lookup returned a resource outside the requested image build.',
          );
        result.push(resource);
      }
      page = pagination.parse(response['meta']).pagination.next_page;
    }
    return result;
  }

  async getAction(input: Parameters<ImageProvider['getAction']>[0]): Promise<ImageAction> {
    const id = imageProviderIdSchema.parse(input.actionId);
    const resource = imageResourceRefSchema.parse(input.resource);
    try {
      const response = object.parse(await this.request({ path: `/actions/${id}` }));
      const action = actionSchema.parse(response['action']);
      if (
        String(action.id) !== id ||
        !action.resources.some(
          (item) =>
            String(item.id) === resource.id &&
            item.type === (resource.kind === 'snapshot' ? 'image' : resource.kind),
        )
      )
        throw new CloudError(
          'provider_outcome_unknown',
          'Hetzner action belongs to another image resource.',
        );
      switch (action.status) {
        case 'running':
          return { kind: 'running' };
        case 'success':
          return { kind: 'succeeded' };
        case 'error':
          return {
            kind: 'failed',
            error: {
              code: 'provider_rejected',
              message: 'Hetzner image action failed.',
              retryable: false,
            },
          };
      }
    } catch (error) {
      if (error instanceof HttpError && error.status === 404 && error.code === 'not_found')
        return { kind: 'missing' };
      throw error;
    }
  }

  async getBaseImage(imageId: string) {
    const id = imageProviderIdSchema.parse(imageId);
    try {
      const response = object.parse(await this.request({ path: `/images/${id}` }));
      const image = decodeBaseImage(response['image']);
      if (image.id !== id)
        throw new CloudError(
          'provider_outcome_unknown',
          'Hetzner base-image lookup returned another identity.',
        );
      return image;
    } catch (error) {
      if (error instanceof HttpError && error.status === 404 && error.code === 'not_found')
        return null;
      throw error;
    }
  }
}

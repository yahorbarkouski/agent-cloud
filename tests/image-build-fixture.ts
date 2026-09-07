import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  imageBuildAdmissionSchema,
  imageEffectLabels,
  imageBuildIdSchema,
  catalogResponseSchema,
  type ImageProvider,
  type ImageProviderCommand,
  type ImageProviderResource,
  type ImageResourceRef,
  type ImageSubmission,
  type ImageBase,
  type ImageAction,
} from '../packages/contracts/dist/index.js';
import { digestManifest, verifyImageInputs } from '../packages/images/dist/index.js';
import { imageFixture } from './image-fixture.js';

export function imagePricing() {
  const now = Date.now();
  return {
    catalog: catalogResponseSchema.parse({
      provider: 'hetzner',
      currency: 'USD',
      pricing: 'account_gross',
      observedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 300000).toISOString(),
      items: [
        {
          size: 'small',
          serverType: 'cpx12',
          region: 'nbg1',
          architecture: 'x86',
          vcpus: 1,
          memoryGb: 2,
          diskGb: 40,
          available: true,
          currency: 'USD',
          priceBasis: 'account_gross',
          serverHourlyMicros: 26568,
          ipv4HourlyMicros: 1230,
          hourlyMicros: 27798,
        },
      ],
    }),
    storagePrice: {
      currency: 'USD',
      grossMicrosPerGbMonth: 24477,
      observedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 300000).toISOString(),
    },
  };
}

export async function imageBuildFixture(
  directory: string,
  trust?: Parameters<typeof imageFixture>[0],
) {
  const fixture = imageFixture(trust);
  await mkdir(join(directory, 'artifacts'), { recursive: true });
  await mkdir(join(directory, 'systemd'), { recursive: true });
  const files = new Map(fixture.files);
  files.set('image-inputs.json', JSON.stringify(fixture.inputs));
  files.set('image.json', JSON.stringify(fixture.manifest));
  const checksums = [...fixture.files.keys(), 'image-inputs.json', 'image.json'].map((path) => {
    const bytes = files.get(path);
    if (!bytes) throw new Error('Fixture file missing.');
    return `${createHash('sha256').update(bytes).digest('hex')}  ${path}`;
  });
  // Input inventories use sorted paths, including when the source map uses insertion order.
  checksums.splice(
    0,
    fixture.files.size,
    ...fixture.inputs.files.map((file) => `${file.sha256}  ${file.path}`),
  );
  files.set('SHA256SUMS', checksums.join('\n') + '\n');
  for (const [path, value] of files) await writeFile(join(directory, path), value);
  const source = await verifyImageInputs(directory, digestManifest(fixture.manifest));
  const pricing = imagePricing();
  const now = Date.now();
  const admission = imageBuildAdmissionSchema.parse({
    id: imageBuildIdSchema.parse(randomUUID()),
    provider: 'hetzner',
    source,
    offer: pricing.catalog.items[0],
    storagePrice: pricing.storagePrice,
    baseImageId: '100',
    access: {
      managementAddress: '203.0.113.7',
      publicKey: 'ssh-ed25519 AAAA',
      hostPublicKey: 'ssh-ed25519 BBBB',
      secretId: randomUUID(),
    },
    budget: {
      currency: 'USD',
      maxVmGrossMicros: 120000,
      maxSnapshotMonthlyGrossMicros: 1000000,
      maxSnapshotGb: 40,
    },
    admittedAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + 90 * 60000).toISOString(),
    retention: { kind: 'verification_only' },
  });
  const limits = {
    currency: 'USD',
    maxOpenBuilds: 1,
    maxVmGrossMicros: 120000,
    maxSnapshotMonthlyGrossMicros: 1000000,
  };
  return { admission, limits, ...pricing };
}

/** Protocol fixture only. It creates no provider resources. */
export class ImageProviderFixture implements ImageProvider {
  readonly kind = 'hetzner';
  readonly resources = new Map<string, ImageProviderResource>();
  readonly submitted: ImageProviderCommand[] = [];
  mode: 'normal' | 'lost' | 'rejected' | 'invisible' = 'normal';
  action: ImageAction = { kind: 'succeeded' };
  get(ref: ImageResourceRef) {
    return Promise.resolve(this.resources.get(`${ref.kind}:${ref.id}`) ?? null);
  }
  find(input: { kind: ImageResourceRef['kind']; labels: Readonly<Record<string, string>> }) {
    return Promise.resolve(
      [...this.resources.values()].filter(
        (resource) =>
          resource.kind === input.kind &&
          Object.entries(input.labels).every(([key, value]) => resource.labels[key] === value),
      ),
    );
  }
  getAction() {
    return Promise.resolve(this.action);
  }
  add(resource: ImageProviderResource) {
    this.resources.set(`${resource.kind}:${resource.id}`, resource);
  }
  getBaseImage(imageId: string): Promise<ImageBase | null> {
    return Promise.resolve({
      id: imageId,
      type: 'system',
      status: 'available',
      architecture: 'x86',
      osFlavor: 'ubuntu',
      osVersion: '24.04',
      diskGb: 10,
      deprecated: false,
      deleted: false,
    });
  }
  submit({ effectId, command }: Parameters<ImageProvider['submit']>[0]): Promise<ImageSubmission> {
    this.submitted.push(command);
    if (this.mode === 'rejected')
      return Promise.resolve({ kind: 'rejected', reason: 'Fixture rejection.' });
    if (this.mode === 'invisible')
      return Promise.resolve({ kind: 'unknown', reason: 'Fixture lost response.' });
    if (command.kind === 'delete') {
      this.resources.delete(`${command.resource.kind}:${command.resource.id}`);
      if (command.resource.kind === 'server') {
        for (const resource of this.resources.values()) {
          if (resource.kind === 'primary_ip' && resource.serverId === command.resource.id)
            this.add({ ...resource, serverId: null });
          if (resource.kind === 'firewall')
            this.add({
              ...resource,
              attachments: resource.attachments.filter(
                (attachment) =>
                  attachment.kind !== 'server' || attachment.id !== command.resource.id,
              ),
            });
        }
      }
      return Promise.resolve({ kind: 'completed', resource: command.resource });
    }
    if (command.kind === 'power_off') {
      const resource = this.resources.get(`server:${command.serverId}`);
      if (resource?.kind === 'server') this.add({ ...resource, power: 'off' });
      return Promise.resolve({
        kind: 'completed',
        resource: { kind: 'server', id: command.serverId },
      });
    }
    const base = {
      id: String(1000 + this.submitted.length),
      labels: imageEffectLabels({
        buildId: command.labels.build_id,
        role: command.labels.role,
        effectId,
      }),
    };
    let resource: ImageProviderResource;
    switch (command.kind) {
      case 'create_ssh_key':
        resource = {
          ...base,
          kind: 'ssh_key',
          publicKey: command.publicKey,
          fingerprint: 'fixture',
        };
        break;
      case 'create_firewall':
        resource = {
          ...base,
          kind: 'firewall',
          attachments: [],
          rules: [
            {
              direction: 'in',
              protocol: 'tcp',
              port: '22',
              sourceIps: [`${command.managementAddress}/32`],
              destinationIps: [],
            },
          ],
        };
        break;
      case 'create_primary_ip':
        resource = {
          ...base,
          kind: 'primary_ip',
          region: command.region,
          ipv4: '203.0.113.9',
          autoDelete: false,
          serverId: null,
        };
        break;
      case 'create_server':
        resource = {
          ...base,
          kind: 'server',
          name: command.name,
          serverType: command.serverType,
          region: command.region,
          architecture: 'x86',
          diskGb: 40,
          power: 'running',
          imageId: command.imageId,
          primaryIpId: command.primaryIpId,
          ipv4: '203.0.113.9',
          deleteProtected: false,
          firewalls: [{ id: command.firewallId, status: 'applied' }],
        };
        {
          const ip = this.resources.get(`primary_ip:${command.primaryIpId}`);
          if (ip?.kind === 'primary_ip') this.add({ ...ip, serverId: resource.id });
          const firewall = this.resources.get(`firewall:${command.firewallId}`);
          if (firewall?.kind === 'firewall')
            this.add({
              ...firewall,
              attachments: [...firewall.attachments, { kind: 'server', id: resource.id }],
            });
        }
        break;
      case 'create_snapshot':
        resource = {
          ...base,
          kind: 'snapshot',
          architecture: 'x86',
          status: 'available',
          sourceServerId: command.serverId,
          imageSizeGb: 2,
          diskGb: 40,
          deleteProtected: false,
          createdAt: new Date().toISOString(),
        };
        break;
      default: {
        const exhaustive: never = command;
        return exhaustive;
      }
    }
    this.add(resource);
    return Promise.resolve(
      this.mode === 'lost'
        ? { kind: 'unknown', reason: 'Fixture lost response.' }
        : { kind: 'completed', resource: { kind: resource.kind, id: resource.id } },
    );
  }
}

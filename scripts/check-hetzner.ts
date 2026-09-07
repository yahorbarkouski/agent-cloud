import { readPrivateFile } from '../apps/control/src/private-file.js';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  createHetznerRequest,
  readHetznerCatalog,
  offerConfigurationSchema,
} from '../packages/hetzner/src/index.js';
import { decodeBaseImage } from '../packages/hetzner/src/image-resources.js';
import { readHetznerImagePrice } from '../packages/hetzner/src/image-pricing.js';

// Read-only operator check; this command has no provider mutation path.
const tokenPath = resolve(process.env.HCLOUD_TOKEN_FILE ?? '.local/hcloud-token');
const request = createHetznerRequest({ token: await readPrivateFile(tokenPath) });
const configuration = offerConfigurationSchema.parse({
  currency: process.env.PROVIDER_CURRENCY,
  architecture: process.env.HCLOUD_ARCHITECTURE ?? 'x86',
  serverTypes: {
    small: process.env.HCLOUD_SERVER_TYPE_SMALL ?? 'cx23',
    medium: process.env.HCLOUD_SERVER_TYPE_MEDIUM ?? 'cx33',
    large: process.env.HCLOUD_SERVER_TYPE_LARGE ?? 'cx43',
  },
});
const catalog = await readHetznerCatalog({ request, configuration });
const countSchema = z.object({
  meta: z.object({ pagination: z.object({ total_entries: z.int().nonnegative() }) }),
});
const [servers, ips, snapshots, firewalls, sshKeys, imageResponse, storagePrice] =
  await Promise.all([
    request({ path: '/servers?per_page=1' }),
    request({ path: '/primary_ips?per_page=1' }),
    request({ path: '/images?type=snapshot&per_page=1' }),
    request({ path: '/firewalls?per_page=1' }),
    request({ path: '/ssh_keys?per_page=1' }),
    request({
      path: `/images?type=system&name=ubuntu-24.04&architecture=${configuration.architecture}&per_page=50`,
    }),
    readHetznerImagePrice(request),
  ]);
const baseImages = z
  .object({
    images: z.array(z.unknown()).min(1).max(50),
    meta: z.object({ pagination: z.object({ next_page: z.null() }) }),
  })
  .parse(imageResponse)
  .images.map(decodeBaseImage);
process.stdout.write(
  JSON.stringify(
    {
      observedAt: new Date().toISOString(),
      catalog,
      storagePrice,
      baseImages,
      resources: {
        servers: countSchema.parse(servers).meta.pagination.total_entries,
        primaryIps: countSchema.parse(ips).meta.pagination.total_entries,
        snapshots: countSchema.parse(snapshots).meta.pagination.total_entries,
        firewalls: countSchema.parse(firewalls).meta.pagination.total_entries,
        sshKeys: countSchema.parse(sshKeys).meta.pagination.total_entries,
      },
    },
    null,
    2,
  ) + '\n',
);

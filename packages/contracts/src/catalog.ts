import { z } from 'zod';
import { currencySchema, microsSchema } from './money.js';
import { CloudError } from './errors.js';

export const sizeSchema = z.enum(['small', 'medium', 'large']);
export const regionSchema = z.enum(['nbg1', 'fsn1', 'hel1']);
export const providerKindSchema = z.enum(['simulated', 'hetzner']);
export const architectureSchema = z.enum(['x86', 'arm']);
export type Size = z.infer<typeof sizeSchema>;
export type Region = z.infer<typeof regionSchema>;

export const providerBackupsSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('disabled') }),
  z.strictObject({ kind: z.literal('daily'), hourlyMicros: microsSchema }),
]);

export const catalogItemSchema = z
  .object({
    size: sizeSchema,
    serverType: z.string().min(1),
    region: regionSchema,
    architecture: architectureSchema,
    vcpus: z.int().positive(),
    memoryGb: z.number().positive(),
    diskGb: z.int().positive(),
    available: z.boolean(),
    currency: currencySchema,
    priceBasis: z.enum(['simulated', 'account_gross', 'legacy_estimate']),
    serverHourlyMicros: microsSchema,
    ipv4HourlyMicros: microsSchema,
    // Historical offers predate provider backup admission and did not reserve it.
    providerBackups: providerBackupsSchema.default({ kind: 'disabled' }),
    hourlyMicros: microsSchema,
  })
  .refine(
    (item) =>
      item.hourlyMicros ===
      item.serverHourlyMicros +
        item.ipv4HourlyMicros +
        (item.providerBackups.kind === 'daily' ? item.providerBackups.hourlyMicros : 0),
    'Hourly reservation must include the VM, IPv4 and enabled provider backups.',
  );
export type CatalogItem = z.infer<typeof catalogItemSchema>;

export const catalogResponseSchema = z
  .object({
    provider: providerKindSchema,
    currency: currencySchema,
    pricing: z.enum(['simulated', 'account_gross']),
    observedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    items: z.array(catalogItemSchema),
  })
  .superRefine((value, ctx) => {
    const keys = new Set<string>();
    for (const item of value.items) {
      const key = `${item.size}:${item.region}`;
      if (item.currency !== value.currency || item.priceBasis !== value.pricing || keys.has(key))
        ctx.addIssue({
          code: 'custom',
          message: 'Catalog currency, price basis, and offer identities must agree.',
        });
      keys.add(key);
    }
    if (Date.parse(value.expiresAt) <= Date.parse(value.observedAt))
      ctx.addIssue({ code: 'custom', message: 'Catalog expiry must follow observation.' });
  });
export type Catalog = z.infer<typeof catalogResponseSchema>;

/** A synchronous snapshot avoids network I/O inside admission transactions. */
export type CatalogSource = () => Catalog;

export function selectOffer(input: {
  catalog: Catalog;
  size: Size;
  region: Region;
  now?: number;
}): CatalogItem {
  const now = input.now ?? Date.now();
  if (
    Date.parse(input.catalog.expiresAt) <= now ||
    Date.parse(input.catalog.observedAt) > now + 5000
  )
    throw new CloudError(
      'provider_unavailable',
      'The provider catalog is stale; refresh before provisioning.',
      true,
    );
  const offer = input.catalog.items.find(
    (item) => item.size === input.size && item.region === input.region,
  );
  if (!offer?.available)
    throw new CloudError(
      'capacity_unavailable',
      'The configured offer has no capacity in this region.',
      true,
    );
  return offer;
}

export function simulatedCatalog(currency = 'EUR'): Catalog {
  const types = [
    { size: 'small', serverType: 'cx23', vcpus: 2, memoryGb: 4, diskGb: 40, hourlyMicros: 9600 },
    { size: 'medium', serverType: 'cx33', vcpus: 4, memoryGb: 8, diskGb: 80, hourlyMicros: 14400 },
    { size: 'large', serverType: 'cx43', vcpus: 8, memoryGb: 16, diskGb: 160, hourlyMicros: 26400 },
  ];
  return catalogResponseSchema.parse({
    provider: 'simulated',
    currency,
    pricing: 'simulated',
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    items: types.flatMap((type) =>
      regionSchema.options.map((region) => ({
        ...type,
        region,
        architecture: 'x86',
        available: true,
        currency,
        priceBasis: 'simulated',
        serverHourlyMicros: type.hourlyMicros - 1200,
        ipv4HourlyMicros: 1200,
        providerBackups: { kind: 'disabled' },
      })),
    ),
  });
}

import { z } from 'zod';
import {
  architectureSchema,
  catalogResponseSchema,
  currencySchema,
  decimalPriceSchema,
  decimalToMicros,
  regionSchema,
  sizeSchema,
  CloudError,
} from '@agent-cloud/contracts';

const priceSchema = z.object({
  location: z.string(),
  price_hourly: z.object({ gross: decimalPriceSchema }),
});
const pricingSchema = z.object({
  pricing: z.object({
    currency: currencySchema,
    server_types: z.array(z.object({ name: z.string(), prices: z.array(priceSchema) })),
    primary_ips: z.array(
      z.object({ type: z.enum(['ipv4', 'ipv6']), prices: z.array(priceSchema) }),
    ),
  }),
});
const serverTypeSchema = z.object({
  name: z.string(),
  architecture: architectureSchema,
  cores: z.int().positive(),
  memory: z.number().positive(),
  disk: z.int().positive(),
  deprecated: z.boolean(),
  locations: z.array(z.object({ name: z.string(), available: z.boolean() })),
});
const pageSchema = z.object({
  server_types: z.array(serverTypeSchema),
  meta: z.object({ pagination: z.object({ next_page: z.int().positive().nullable() }) }),
});

export const offerConfigurationSchema = z.object({
  serverTypes: z.object({
    small: z.string().min(1),
    medium: z.string().min(1),
    large: z.string().min(1),
  }),
  architecture: architectureSchema,
  currency: currencySchema,
});
export type OfferConfiguration = z.infer<typeof offerConfigurationSchema>;

/** Explicit type mapping only: capacity loss never selects a more expensive substitute. */
export async function readHetznerCatalog(input: {
  request: (input: { path: string }) => Promise<unknown>;
  configuration: OfferConfiguration;
}) {
  const configuration = offerConfigurationSchema.parse(input.configuration);
  const observedAt = new Date();
  const { pricing } = pricingSchema.parse(await input.request({ path: '/pricing' }));
  if (pricing.currency !== configuration.currency)
    throw new CloudError(
      'budget_exceeded',
      'Hetzner account currency differs from the configured spending limit.',
    );
  const types: z.infer<typeof serverTypeSchema>[] = [];
  let page: number | null = 1;
  const seen = new Set<number>();
  while (page !== null) {
    if (seen.has(page) || seen.size >= 100)
      throw new CloudError('provider_unavailable', 'Hetzner catalog pagination is invalid.', true);
    seen.add(page);
    const result = pageSchema.parse(
      await input.request({ path: `/server_types?per_page=50&page=${page}` }),
    );
    types.push(...result.server_types);
    page = result.meta.pagination.next_page;
  }
  if (new Set(types.map((type) => type.name)).size !== types.length)
    throw new CloudError('provider_unavailable', 'Hetzner catalog contains duplicate types.', true);
  const ipv4 = pricing.primary_ips.filter((ip) => ip.type === 'ipv4');
  if (ipv4.length !== 1)
    throw new CloudError(
      'provider_unavailable',
      'Hetzner did not supply unambiguous IPv4 prices.',
      true,
    );
  const items = sizeSchema.options.flatMap((size) => {
    const type = types.find((candidate) => candidate.name === configuration.serverTypes[size]);
    if (!type) return [];
    // VM, IP and denomination come from one account-price response.
    const priceEntries = pricing.server_types.filter((entry) => entry.name === type.name);
    const entry = priceEntries[0];
    if (!entry || priceEntries.length !== 1) return [];
    return regionSchema.options.flatMap((region) => {
      const prices = entry.prices.filter((price) => price.location === region);
      const ipPrices = ipv4[0]?.prices.filter((price) => price.location === region) ?? [];
      const price = prices[0];
      const ipPrice = ipPrices[0];
      // Missing or ambiguous prices are unusable, never zero-cost offers.
      if (!price || !ipPrice || prices.length !== 1 || ipPrices.length !== 1) return [];
      const serverHourlyMicros = decimalToMicros(price.price_hourly.gross);
      const ipv4HourlyMicros = decimalToMicros(ipPrice.price_hourly.gross);
      return [
        {
          size,
          region,
          serverType: type.name,
          architecture: type.architecture,
          vcpus: type.cores,
          memoryGb: type.memory,
          diskGb: type.disk,
          available:
            !type.deprecated &&
            type.architecture === configuration.architecture &&
            type.locations.some((location) => location.name === region && location.available),
          currency: pricing.currency,
          priceBasis: 'account_gross',
          serverHourlyMicros,
          ipv4HourlyMicros,
          hourlyMicros: serverHourlyMicros + ipv4HourlyMicros,
        },
      ];
    });
  });
  return catalogResponseSchema.parse({
    provider: 'hetzner',
    currency: pricing.currency,
    pricing: 'account_gross',
    observedAt: observedAt.toISOString(),
    expiresAt: new Date(observedAt.getTime() + 300_000).toISOString(),
    items,
  });
}

import { z } from 'zod';
import {
  currencySchema,
  decimalPriceSchema,
  decimalToMicros,
  imageStoragePriceSchema,
} from '@agent-cloud/contracts';

const pricing = z.object({
  pricing: z.object({
    currency: currencySchema,
    image: z.object({ price_per_gb_month: z.object({ gross: decimalPriceSchema }) }),
  }),
});

export async function readHetznerImagePrice(
  request: (input: { path: string }) => Promise<unknown>,
) {
  const startedAt = Date.now();
  const response = pricing.parse(await request({ path: '/pricing' })).pricing;
  return imageStoragePriceSchema.parse({
    currency: response.currency,
    grossMicrosPerGbMonth: decimalToMicros(response.image.price_per_gb_month.gross),
    observedAt: new Date(startedAt).toISOString(),
    expiresAt: new Date(startedAt + 300_000).toISOString(),
  });
}

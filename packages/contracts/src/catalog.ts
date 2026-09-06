import { z } from 'zod';

export const sizeSchema = z.enum(['small', 'medium', 'large']);
export const regionSchema = z.enum(['nbg1', 'fsn1', 'hel1']);
export const providerKindSchema = z.enum(['simulated', 'hetzner']);
export type Size = z.infer<typeof sizeSchema>;
export type Region = z.infer<typeof regionSchema>;

export const catalogItemSchema = z.object({
  size: sizeSchema,
  serverType: z.string(),
  vcpus: z.int().positive(),
  memoryGb: z.int().positive(),
  diskGb: z.int().positive(),
  estimatedProviderHourlyMicroEur: z.int().positive(),
});
export type CatalogItem = z.infer<typeof catalogItemSchema>;

// Planning rates include IPv4; a live adapter must validate actual availability and price.
export const catalog: Record<Size, CatalogItem> = {
  small: {
    size: 'small',
    serverType: 'cx23',
    vcpus: 2,
    memoryGb: 4,
    diskGb: 40,
    estimatedProviderHourlyMicroEur: 9_600,
  },
  medium: {
    size: 'medium',
    serverType: 'cx33',
    vcpus: 4,
    memoryGb: 8,
    diskGb: 80,
    estimatedProviderHourlyMicroEur: 14_400,
  },
  large: {
    size: 'large',
    serverType: 'cx43',
    vcpus: 8,
    memoryGb: 16,
    diskGb: 160,
    estimatedProviderHourlyMicroEur: 26_400,
  },
};

export const catalogResponseSchema = z.object({
  provider: providerKindSchema,
  currency: z.literal('EUR'),
  pricing: z.literal('estimate'),
  items: z.array(catalogItemSchema),
  regions: z.array(regionSchema),
});

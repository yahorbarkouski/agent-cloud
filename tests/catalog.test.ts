import { expect, it } from 'vitest';
import type { z } from 'zod';
import {
  decimalToMicros,
  decimalLimitToMicros,
  selectOffer,
  simulatedCatalog,
  catalogResponseSchema,
  catalogItemSchema,
} from '../packages/contracts/src/index.js';
import { readHetznerCatalog, type OfferConfiguration } from '../packages/hetzner/src/index.js';
import { readConfig } from '../apps/control/src/config.js';

const configuration: OfferConfiguration = {
  currency: 'USD',
  architecture: 'x86',
  serverTypes: { small: 'cpx12', medium: 'cx33', large: 'cx43' },
};
const price = (gross: string) => ({ location: 'nbg1', price_hourly: { gross } });
const type = (name: string) => ({
  name,
  architecture: 'x86',
  cores: 1,
  memory: 2,
  disk: 40,
  deprecated: false,
  locations: [{ name: 'nbg1', available: true }],
  prices: [price('0.0265680000000000')],
});
const pricing = {
  pricing: {
    currency: 'USD',
    server_backup: { percentage: '20.0000000000' },
    server_types: [{ name: 'cpx12', prices: [price('0.0265680000000000')] }],
    primary_ips: [{ type: 'ipv4', prices: [price('0.0012300000000000')] }],
  },
};
const page = (types: unknown[], next: number | null = null) => ({
  server_types: types,
  meta: { pagination: { next_page: next } },
});

it('reserves decimal prices without binary rounding, and never increases an operator limit', () => {
  expect(decimalToMicros('0.0265680000000000')).toBe(26568);
  expect(decimalToMicros('0.0012300000000000')).toBe(1230);
  expect(decimalToMicros('0.0000000000001')).toBe(1);
  expect(decimalToMicros('1.1234561')).toBe(1123457);
  expect(decimalLimitToMicros('0.0200000')).toBe(20000);
  expect(() => decimalLimitToMicros('0.0200001')).toThrow();
  for (const bad of ['NaN', 'Infinity', '-1', '1e-3', '0x10', ' 0.01', '99999999999999999999'])
    expect(() => decimalToMicros(bad)).toThrow();
});

it('requires explicit live currency and budget, rejecting the obsolete EUR-only environment', () => {
  const base = { DATABASE_URL: 'postgresql://localhost/test', PROVIDER: 'hetzner' };
  expect(() => readConfig(base)).toThrow('explicit');
  expect(() => readConfig({ ...base, MAX_PROVIDER_HOURLY_EUR: '0.02' })).toThrow('Replace');
  expect(
    readConfig({ ...base, PROVIDER_CURRENCY: 'USD', MAX_PROVIDER_HOURLY: '0.03' }).limits,
  ).toEqual({ currency: 'USD', maxHourlyMicros: 30000, maxMachines: 2 });
});

it('reads all catalog pages and reserves the account gross VM, IPv4 and daily backups', async () => {
  const paths: string[] = [];
  const catalog = await readHetznerCatalog({
    configuration,
    request: ({ path }) => {
      paths.push(path);
      return Promise.resolve(
        path === '/pricing'
          ? pricing
          : path.endsWith('page=1')
            ? page([type('other')], 2)
            : page([type('cpx12')]),
      );
    },
  });
  expect(paths).toEqual([
    '/pricing',
    '/server_types?per_page=50&page=1',
    '/server_types?per_page=50&page=2',
  ]);
  expect(selectOffer({ catalog, size: 'small', region: 'nbg1' })).toMatchObject({
    currency: 'USD',
    hourlyMicros: 33112,
    serverHourlyMicros: 26568,
    ipv4HourlyMicros: 1230,
    providerBackups: { kind: 'daily', hourlyMicros: 5314 },
    serverType: 'cpx12',
  });
  expect(() => selectOffer({ catalog, size: 'medium', region: 'nbg1' })).toThrow('no capacity');
});

it('refuses stale observations, currency mismatch, and looping pagination', async () => {
  const catalog = simulatedCatalog();
  expect(() =>
    selectOffer({ catalog, size: 'small', region: 'nbg1', now: Date.parse(catalog.expiresAt) }),
  ).toThrow('stale');
  await expect(
    readHetznerCatalog({
      configuration: { ...configuration, currency: 'EUR' },
      request: () => Promise.resolve(pricing),
    }),
  ).rejects.toThrow('currency');
  await expect(
    readHetznerCatalog({
      configuration,
      request: ({ path }) =>
        Promise.resolve(path === '/pricing' ? pricing : page([type('cpx12')], 1)),
    }),
  ).rejects.toThrow('pagination');
});

it('does not substitute unavailable, deprecated, or wrong-architecture types', async () => {
  for (const candidate of [
    { ...type('cpx12'), locations: [{ name: 'nbg1', available: false }] },
    { ...type('cpx12'), architecture: 'arm' },
    { ...type('cpx12'), deprecated: true },
  ]) {
    const catalog = await readHetznerCatalog({
      configuration,
      request: ({ path }) =>
        Promise.resolve(path === '/pricing' ? pricing : page([candidate, type('expensive')])),
    });
    expect(catalog.items).toHaveLength(1);
    expect(catalog.items[0]?.available).toBe(false);
    expect(() => selectOffer({ catalog, size: 'small', region: 'nbg1' })).toThrow('no capacity');
  }
});

it('excludes offers when IPv4 or server prices are missing or ambiguous', async () => {
  for (const candidate of [
    { ...type('cpx12'), prices: [] },
    { ...type('cpx12'), prices: [price('0.02'), price('0.03')] },
  ]) {
    const catalog = await readHetznerCatalog({
      configuration,
      request: ({ path }) =>
        Promise.resolve(
          path === '/pricing'
            ? { pricing: { ...pricing.pricing, server_types: [candidate] } }
            : page([type('cpx12')]),
        ),
    });
    expect(catalog.items).toEqual([]);
  }
  const catalog = await readHetznerCatalog({
    configuration,
    request: ({ path }) =>
      Promise.resolve(
        path === '/pricing'
          ? { pricing: { ...pricing.pricing, primary_ips: [{ type: 'ipv4', prices: [] }] } }
          : page([type('cpx12')]),
      ),
  });
  expect(catalog.items).toEqual([]);
});

it('uses VM and IP prices from the response declaring their currency when later type prices disagree', async () => {
  const catalog = await readHetznerCatalog({
    configuration,
    request: ({ path }) =>
      Promise.resolve(
        path === '/pricing' ? pricing : page([{ ...type('cpx12'), prices: [price('0.00001')] }]),
      ),
  });
  expect(selectOffer({ catalog, size: 'small', region: 'nbg1' }).hourlyMicros).toBe(33112);
});

it('rounds the exact decimal backup surcharge upward without rounding its inputs first', async () => {
  for (const [gross, percentage, surcharge] of [
    ['0.0000011', '90.0000000000', 1],
    ['0.0000000000001', '0.0000000001', 1],
    ['1.000001', '0.0001', 2],
    ['0.01', '20.0000000000000000000000000001', 2001],
    ['0.01', '0.0000000000', 0],
  ] satisfies Array<[string, string, number]>) {
    const catalog = await readHetznerCatalog({
      configuration,
      request: ({ path }) =>
        Promise.resolve(
          path === '/pricing'
            ? {
                pricing: {
                  ...pricing.pricing,
                  server_backup: { percentage },
                  server_types: [{ name: 'cpx12', prices: [price(gross)] }],
                  primary_ips: [{ type: 'ipv4', prices: [price('0')] }],
                },
              }
            : page([type('cpx12')]),
        ),
    });
    expect(selectOffer({ catalog, size: 'small', region: 'nbg1' })).toMatchObject({
      serverHourlyMicros: decimalToMicros(gross),
      providerBackups: { kind: 'daily', hourlyMicros: surcharge },
      hourlyMicros: decimalToMicros(gross) + surcharge,
    });
  }
});

it('fails closed when the account backup percentage is missing, malformed or ambiguous', async () => {
  for (const serverBackup of [
    undefined,
    null,
    {},
    [{ percentage: '20' }],
    ...[
      undefined,
      null,
      20,
      ['20', '30'],
      '',
      '20%',
      '-20',
      'NaN',
      'Infinity',
      '2e1',
      ' 20',
      '020',
      '9'.repeat(41),
    ].map((percentage) => ({ percentage })),
  ]) {
    const paths: string[] = [];
    await expect(
      readHetznerCatalog({
        configuration,
        request: ({ path }) => {
          paths.push(path);
          return Promise.resolve(
            path === '/pricing'
              ? {
                  pricing: { ...pricing.pricing, server_backup: serverBackup },
                }
              : page([type('cpx12')]),
          );
        },
      }),
    ).rejects.toThrow();
    expect(paths).toEqual(['/pricing']);
  }
});

it('rejects a backup surcharge or total reservation exceeding integer-micro storage', async () => {
  for (const [gross, percentage] of [
    ['1', '999999999999999999999999'],
    ['2147', '20'],
  ] satisfies Array<[string, string]>) {
    await expect(
      readHetznerCatalog({
        configuration,
        request: ({ path }) =>
          Promise.resolve(
            path === '/pricing'
              ? {
                  pricing: {
                    ...pricing.pricing,
                    server_backup: { percentage },
                    server_types: [{ name: 'cpx12', prices: [price(gross)] }],
                  },
                }
              : page([type('cpx12')]),
          ),
      }),
    ).rejects.toThrow();
  }
});

it('keeps the backup surcharge in the account response currency', async () => {
  const catalog = await readHetznerCatalog({
    configuration: { ...configuration, currency: 'EUR' },
    request: ({ path }) =>
      Promise.resolve(
        path === '/pricing'
          ? {
              pricing: { ...pricing.pricing, currency: 'EUR' },
            }
          : page([type('cpx12')]),
      ),
  });
  expect(selectOffer({ catalog, size: 'small', region: 'nbg1' })).toMatchObject({
    currency: 'EUR',
    providerBackups: { kind: 'daily', hourlyMicros: 5314 },
    hourlyMicros: 33112,
  });
  expect(catalogResponseSchema.safeParse({ ...catalog, currency: 'USD' }).success).toBe(false);
});

it('parses historical offers as backups disabled and validates the complete reservation', () => {
  const offer = simulatedCatalog().items[0];
  expect(offer).toBeDefined();
  if (!offer) throw new Error('Missing simulated offer.');
  const legacy: z.input<typeof catalogItemSchema> = { ...offer };
  delete legacy.providerBackups;
  expect(catalogItemSchema.parse(legacy)).toEqual({
    ...offer,
    providerBackups: { kind: 'disabled' },
  });
  const daily = { ...offer, providerBackups: { kind: 'daily', hourlyMicros: 100 } };
  expect(catalogItemSchema.safeParse(daily).success).toBe(false);
  expect(
    catalogItemSchema.safeParse({ ...daily, hourlyMicros: offer.hourlyMicros + 100 }).success,
  ).toBe(true);
  expect(
    catalogItemSchema.safeParse({
      ...offer,
      providerBackups: { kind: 'disabled', hourlyMicros: 100 },
    }).success,
  ).toBe(false);
});

it('rejects legacy or simulated item prices inside a catalog claiming account gross prices', () => {
  const simulated = simulatedCatalog();
  expect(catalogResponseSchema.safeParse({ ...simulated, pricing: 'account_gross' }).success).toBe(
    false,
  );
  expect(
    catalogResponseSchema.safeParse({
      ...simulated,
      items: simulated.items.map((item) => ({ ...item, priceBasis: 'legacy_estimate' })),
    }).success,
  ).toBe(false);
});

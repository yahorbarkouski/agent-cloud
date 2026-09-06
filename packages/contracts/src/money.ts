import { z } from 'zod';

export const currencySchema = z.string().regex(/^[A-Z]{3}$/);
export const microsSchema = z.int().nonnegative().max(2_147_483_647);
export const decimalPriceSchema = z
  .string()
  .max(40)
  .regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/);

/** Reserve fractional micro-units upwards. Never round a provider price down. */
export function decimalToMicros(value: string): number {
  const [whole = '0', fraction = ''] = decimalPriceSchema.parse(value).split('.');
  const remainder = fraction.slice(6);
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.slice(0, 6).padEnd(6, '0'));
  return microsSchema.parse(Number(micros + (/[1-9]/.test(remainder) ? 1n : 0n)));
}

/** Limits must be exactly representable; rounding up increases authorization. */
export function decimalLimitToMicros(value: string): number {
  const parsed = decimalPriceSchema.parse(value);
  if (/[1-9]/.test(parsed.split('.')[1]?.slice(6) ?? '')) {
    throw new Error('Spending limits allow at most six nonzero decimal places.');
  }
  return decimalToMicros(parsed);
}

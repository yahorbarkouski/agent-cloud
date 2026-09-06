import { z } from 'zod';
import { currencySchema, decimalLimitToMicros } from '@agent-cloud/contracts';

const environmentSchema = z.object({
  DATABASE_URL: z.url(),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4319),
  PUBLIC_URL: z.url().default('http://127.0.0.1:4319'),
  PROVIDER: z.enum(['simulated', 'hetzner']).default('simulated'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  MAX_LIVE_MACHINES: z.coerce.number().int().min(0).default(2),
  PROVIDER_CURRENCY: currencySchema.default('EUR'),
  MAX_PROVIDER_HOURLY: z.string().default('0.02').transform(decimalLimitToMicros),
});

export function readConfig(environment: NodeJS.ProcessEnv = process.env) {
  if (environment.MAX_PROVIDER_HOURLY_EUR !== undefined)
    throw new Error(
      'Replace MAX_PROVIDER_HOURLY_EUR with PROVIDER_CURRENCY and MAX_PROVIDER_HOURLY.',
    );
  const env = environmentSchema.parse(environment);
  if (
    env.PROVIDER === 'hetzner' &&
    (!environment.PROVIDER_CURRENCY || !environment.MAX_PROVIDER_HOURLY)
  )
    throw new Error('Live operation requires an explicit currency and hourly limit.');
  return {
    databaseUrl: env.DATABASE_URL,
    host: env.HOST,
    port: env.PORT,
    publicUrl: env.PUBLIC_URL,
    provider: env.PROVIDER,
    logLevel: env.LOG_LEVEL,
    limits: {
      maxMachines: env.MAX_LIVE_MACHINES,
      currency: env.PROVIDER_CURRENCY,
      maxHourlyMicros: env.MAX_PROVIDER_HOURLY,
    },
  };
}
export type Config = ReturnType<typeof readConfig>;

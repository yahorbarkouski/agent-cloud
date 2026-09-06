import { z } from 'zod';

const environmentSchema = z.object({
  DATABASE_URL: z.url(),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4319),
  PUBLIC_URL: z.url().default('http://127.0.0.1:4319'),
  PROVIDER: z.enum(['simulated', 'hetzner']).default('simulated'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  MAX_LIVE_MACHINES: z.coerce.number().int().min(0).default(2),
  MAX_PROVIDER_HOURLY_EUR: z.coerce.number().min(0).max(100).default(0.02),
});

export function readConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = environmentSchema.parse(environment);
  return {
    databaseUrl: env.DATABASE_URL,
    host: env.HOST,
    port: env.PORT,
    publicUrl: env.PUBLIC_URL,
    provider: env.PROVIDER,
    logLevel: env.LOG_LEVEL,
    limits: {
      maxMachines: env.MAX_LIVE_MACHINES,
      maxHourlyMicroEur: Math.floor(env.MAX_PROVIDER_HOURLY_EUR * 1_000_000),
    },
  };
}
export type Config = ReturnType<typeof readConfig>;

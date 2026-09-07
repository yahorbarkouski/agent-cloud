import type { Connection } from '@agent-cloud/db';
import type { Config } from './config.js';
import { readRuntimeConfig } from './runtime-config.js';
import { createImageRuntime } from './image-runtime.js';
import { createCustomerRuntime } from './customer-runtime.js';

/** Mode selection is explicit and contains no provider mutation. */
export async function createOperatorRuntime(
  connection: Connection,
  config: Extract<Config, { provider: 'hetzner' }>,
) {
  const runtime = await readRuntimeConfig(config.runtimeConfigFile);
  if (runtime.mode === 'image_factory')
    return { mode: runtime.mode, ...(await createImageRuntime({ connection, config, runtime })) };
  return { mode: runtime.mode, ...(await createCustomerRuntime({ connection, config, runtime })) };
}

import { z } from 'zod';
import { createPublicGatewayController, readGatewaySecret } from './controller.js';

const path = z.string().min(1).parse(process.env.ACLD_PUBLIC_GATEWAY_CONFIG);
const config: unknown = JSON.parse(await readGatewaySecret(path));
const { publicGatewayControllerSchema } = await import('./controller.js');
const controller = createPublicGatewayController(publicGatewayControllerSchema.parse(config));
const abort = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    abort.abort();
  });
await controller.run(abort.signal);

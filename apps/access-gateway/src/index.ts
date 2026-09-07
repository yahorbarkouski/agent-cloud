import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createAccessGateway } from './server.js';

const path = process.env.ACLD_GATEWAY_CONFIG;
if (!path) throw new Error('Set ACLD_GATEWAY_CONFIG to an owner-only gateway configuration file.');
const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
let value: unknown;
try {
  const info = await file.stat();
  if (
    !info.isFile() ||
    info.size > 16_384 ||
    info.mode & 0o077 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error('Gateway configuration must be a small owner-only regular file.');
  value = JSON.parse(await file.readFile('utf8'));
} finally {
  await file.close();
}
const { gatewayConfigSchema } = await import('./server.js');
const gateway = createAccessGateway(gatewayConfigSchema.parse(value));
await gateway.listen();
process.stdout.write(JSON.stringify({ event: 'access_gateway.listening' }) + '\n');
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    void gateway.close();
  });

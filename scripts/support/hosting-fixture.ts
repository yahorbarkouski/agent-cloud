import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import type { Connection } from '../../packages/db/src/index.js';
import type { MachineProvider } from '../../packages/contracts/dist/index.js';
import {
  generateGatewayTlsKey,
  gatewayTlsName,
  issueGatewayTls,
  renewGatewayTls,
  type Signer,
} from '../../packages/pki/src/index.js';
import { createHostingRuntime } from '../../apps/control/src/hosting-runtime.js';
import { readPrivateFile } from '../../apps/control/src/private-file.js';
import { createPublicGatewayController } from '../../apps/public-gateway/src/controller.js';

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port.');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    }),
  );
  return address.port;
}
export async function prepareHostingFixture(input: {
  connection: Connection;
  provider: MachineProvider;
  signer: Signer;
  scratch: string;
  controlUrl: string;
}) {
  const directory = join(input.scratch, 'hosting');
  await mkdir(directory, { mode: 0o700 });
  const gatewayToken = `acld_hosting_${randomBytes(32).toString('base64url')}`;
  const tokenFile = join(directory, 'gateway-token');
  await writeFile(tokenFile, gatewayToken, { mode: 0o600, flag: 'wx' });
  const httpPort = await availablePort();
  const httpsPort = await availablePort();
  const configPath = join(directory, 'control.json');
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      applicationDomain: 'apps.localhost',
      gatewayTokenFile: tokenFile,
      gatewayAddresses: ['127.0.0.1'],
      gatewayOrigin: `https://localhost:${httpsPort}`,
    }),
    { mode: 0o600 },
  );
  const runtime = await createHostingRuntime({
    connection: input.connection,
    provider: input.provider,
    path: configPath,
    signer: () => Promise.resolve(input.signer),
  });
  const keyFile = join(directory, 'client.key');
  const certificateFile = join(directory, 'client.crt');
  const rootFile = resolve('.local/pki/public/root_ca.crt');
  const privateKey = generateGatewayTlsKey();
  await writeFile(keyFile, privateKey, { mode: 0o600, flag: 'wx' });
  const tls = {
    binary: resolve('.local/tools/step-0.30.6'),
    caUrl: 'https://localhost:9449',
    tlsRoot: await readFile(rootFile, 'utf8'),
  };
  const name = gatewayTlsName(`fixture-${randomUUID()}`);
  const issued = await issueGatewayTls(
    {
      ...tls,
      provisioner: 'agent-cloud-gateway',
      provisionerPassword: await readPrivateFile(
        resolve('.local/pki/gateway-provisioner-password'),
      ),
    },
    { name, privateKey },
  );
  // Exercise key-authenticated renewal without carrying a provisioner password into the gateway.
  const renewed = await renewGatewayTls(tls, { name, privateKey, ...issued });
  await writeFile(certificateFile, renewed.certificate, { mode: 0o600, flag: 'wx' });
  const receiptFile = join(directory, 'client-receipt.json');
  await writeFile(receiptFile, JSON.stringify({ name, ...renewed }), { mode: 0o600, flag: 'wx' });
  const gatewayState = resolve(`.local/gw-${randomUUID().slice(0, 8)}`);
  const config = {
    apiUrl: input.controlUrl,
    tokenFile,
    clientIdentity: { name, receiptFile, step: tls.binary, caUrl: tls.caUrl },
    gateway: {
      caddy: resolve('.local/tools/caddy-2.11.4'),
      stateDirectory: gatewayState,
      guestCaFile: rootFile,
      clientCertificateFile: certificateFile,
      clientKeyFile: keyFile,
      publicTls: { kind: 'internal' },
      listenAddress: '127.0.0.1',
      httpPort,
      httpsPort,
    },
  } satisfies Parameters<typeof createPublicGatewayController>[0];
  let controller = createPublicGatewayController(config);
  let abort = new AbortController();
  let running: Promise<void> | undefined;
  let failure: unknown;
  const start = () => {
    running = controller.run(abort.signal).catch((error: unknown) => {
      failure = error;
    });
  };
  async function stop() {
    abort.abort();
    await running;
    if (failure) throw new Error('Public gateway fixture failed.', { cause: failure });
  }
  async function close() {
    await stop();
    await rm(gatewayState, { recursive: true, force: true });
  }
  async function restart() {
    await stop();
    controller = createPublicGatewayController(config);
    abort = new AbortController();
    start();
  }
  return { runtime, gatewayToken, gatewayState, httpsPort, start, stop: close, restart };
}

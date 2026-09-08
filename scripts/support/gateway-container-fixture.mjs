import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

// This fixture runs only inside the production image, with two separately mounted volumes.
const privateDirectory = '/work/.local';
const gatewayDirectory = '/run/agent-cloud';
const gatewayName = 'fixture.gateway.agent-cloud.internal';
const hostname = 'app.fixture.test';
const serverName = 'guest.fixture.test';
const { hostingSnapshotSchema } =
  await import('/opt/agent-cloud/public-gateway/node_modules/@agent-cloud/contracts/dist/hosting.js');
const routes = [{ hostname, address: '127.0.0.1', serverName, version: 1 }];
const snapshot = hostingSnapshotSchema.parse({
  revision: createHash('sha256').update(JSON.stringify(routes)).digest('hex'),
  routes,
});
const json = (value) => JSON.stringify(value) + '\n';
const digest = (value) => createHash('sha256').update(value).digest();
const file = (name) => join(privateDirectory, name);
const exported = (name) => join(gatewayDirectory, name);
let stage = 'arguments';

async function initialize(files) {
  const { prepareGatewayDirectory, readGatewayFile, writeGatewayFile } = files;
  stage = 'exclusive private directories';
  for (const directory of [privateDirectory, gatewayDirectory]) {
    await prepareGatewayDirectory(directory);
    assert.deepEqual(await readdir(directory), []);
  }
  // A partial attempt requires fresh owned volumes; it must not silently replace any key.
  await writeGatewayFile(
    file('initialization.json'),
    json({ startedAt: new Date().toISOString() }),
    true,
  );
  await writeGatewayFile(
    exported('initialization.json'),
    json({ startedAt: new Date().toISOString() }),
    true,
  );
  const step = async (args) => {
    await promisify(execFile)('/usr/local/bin/step', args, {
      cwd: privateDirectory,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', STEPPATH: privateDirectory },
      timeout: 20_000,
      killSignal: 'SIGKILL',
      maxBuffer: 16_384,
    });
  };
  const generated = async (path) => {
    const value = await readGatewayFile(path, true, 32_768);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return value;
  };
  const keyFlags = ['--kty', 'EC', '--curve', 'P-256', '--no-password', '--insecure'];
  stage = 'offline root issuance';
  await step([
    'certificate',
    'create',
    'Gateway Container Fixture Root',
    file('root.crt'),
    file('root.key'),
    '--profile',
    'root-ca',
    '--not-after',
    '2h',
    ...keyFlags,
  ]);
  const root = await generated(file('root.crt'));
  await generated(file('root.key'));
  const rootCertificate = new X509Certificate(root);
  assert.ok(rootCertificate.ca);
  assert.equal(rootCertificate.publicKey.asymmetricKeyDetails.namedCurve, 'prime256v1');
  for (const [name, usage, certificate, key] of [
    [serverName, 'serverAuth', file('server.crt'), file('server.key')],
    [gatewayName, 'clientAuth', exported('client.crt'), exported('client.key')],
  ]) {
    stage = `offline ${usage} issuance`;
    const template = file(`${usage}.json`);
    await writeGatewayFile(
      template,
      json({
        subject: { commonName: name },
        dnsNames: [name],
        keyUsage: ['digitalSignature'],
        extKeyUsage: [usage],
        basicConstraints: { isCA: false },
      }),
      true,
    );
    const before = Math.floor(Date.now() / 1000) * 1000;
    await step([
      'certificate',
      'create',
      name,
      certificate,
      key,
      '--template',
      template,
      '--ca',
      file('root.crt'),
      '--ca-key',
      file('root.key'),
      '--not-before',
      new Date(before).toISOString(),
      '--not-after',
      new Date(before + 3_600_000).toISOString(),
      ...keyFlags,
    ]);
    await generated(certificate);
    await generated(key);
  }
  stage = 'gateway receipt and configuration';
  const certificate = await readGatewayFile(exported('client.crt'));
  const leaf = new X509Certificate(certificate);
  assert.ok(leaf.validToDate.getTime() - leaf.validFromDate.getTime() <= 3_600_000);
  const receipt = files.gatewayCertificateReceiptSchema.parse({
    name: gatewayName,
    certificate,
    issuedAt: new Date().toISOString(),
    expiresAt: leaf.validToDate.toISOString(),
  });
  await writeGatewayFile(exported('client-receipt.json'), json(receipt), true);
  await writeGatewayFile(exported('root.crt'), root, true);
  // The server pins the public leaf; it receives neither the gateway private key nor its volume.
  await writeGatewayFile(file('expected-client.crt'), certificate, true);
  const hostingToken = `acld_hosting_${randomBytes(32).toString('base64url')}`;
  await writeGatewayFile(file('hosting-token'), hostingToken, true);
  await writeGatewayFile(exported('hosting-token'), hostingToken, true);
  await writeGatewayFile(file('management-token'), randomBytes(32).toString('base64url'), true);
  const { publicGatewayControllerSchema } =
    await import('/opt/agent-cloud/public-gateway/dist/controller.js');
  const configuration = publicGatewayControllerSchema.parse({
    apiUrl: 'http://127.0.0.1:4319',
    tokenFile: exported('hosting-token'),
    gateway: {
      caddy: '/usr/local/bin/caddy',
      stateDirectory: exported('state'),
      guestCaFile: exported('root.crt'),
      clientCertificateFile: exported('client.crt'),
      clientKeyFile: exported('client.key'),
      publicTls: { kind: 'internal' },
      listenAddress: '0.0.0.0',
      httpPort: 8080,
      httpsPort: 8444,
    },
    // No CA service runs here. Fresh one-hour credentials never reach the renewal window.
    clientIdentity: {
      name: gatewayName,
      receiptFile: exported('client-receipt.json'),
      step: '/usr/local/bin/step',
      caUrl: 'https://127.0.0.1:9443',
    },
  });
  await files.createGatewayCertificate(configuration).restore();
  await prepareGatewayDirectory(configuration.gateway.stateDirectory);
  await writeGatewayFile(exported('controller.json'), json(configuration), true);
  for (const directory of [privateDirectory, gatewayDirectory]) {
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  process.stdout.write(json({ initialized: true }));
}

function reply(response, status, value) {
  response
    .writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    .end(json(value));
}

async function readJson(incoming) {
  const chunks = [];
  let size = 0;
  for await (const chunk of incoming) {
    size += chunk.length;
    if (size > 4096) throw new Error('Fixture request exceeds its limit.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function serve({ readGatewayFile }) {
  stage = 'private server configuration';
  const hostingAuth = digest(`Bearer ${await readGatewayFile(file('hosting-token'))}`);
  const managementAuth = digest(`Bearer ${await readGatewayFile(file('management-token'))}`);
  const expectedPeer = new X509Certificate(await readGatewayFile(file('expected-client.crt'))).raw;
  const stats = { acks: 0, upstreamRequests: 0, outage: false };
  const control = createServer(
    { maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 },
    (incoming, outgoing) => {
      void (async () => {
        const hosting = incoming.url?.startsWith('/hosting/');
        const authorization = incoming.headers.authorization;
        if (
          typeof authorization !== 'string' ||
          !timingSafeEqual(digest(authorization), hosting ? hostingAuth : managementAuth)
        ) {
          reply(outgoing, 401, { error: 'unauthorized' });
        } else if (hosting && stats.outage) {
          reply(outgoing, 503, { error: 'unavailable' });
        } else if (incoming.method === 'GET' && incoming.url === '/hosting/v1/snapshot') {
          reply(outgoing, 200, snapshot);
        } else if (incoming.method === 'POST' && incoming.url === '/hosting/v1/ack') {
          assert.deepEqual(await readJson(incoming), { revision: snapshot.revision });
          stats.acks++;
          reply(outgoing, 200, {
            revision: snapshot.revision,
            appliedAt: new Date().toISOString(),
          });
        } else if (incoming.method === 'GET' && incoming.url === '/fixture/state') {
          reply(outgoing, 200, stats);
        } else if (
          incoming.method === 'POST' &&
          ['/fixture/outage', '/fixture/recover'].includes(incoming.url)
        ) {
          stats.outage = incoming.url === '/fixture/outage';
          reply(outgoing, 200, stats);
        } else {
          reply(outgoing, 404, { error: 'not_found' });
        }
      })().catch(() => {
        if (!outgoing.headersSent) reply(outgoing, 400, { error: 'invalid_request' });
        else outgoing.destroy();
      });
    },
  );
  const guest = createHttpsServer(
    {
      cert: await readGatewayFile(file('server.crt')),
      key: await readGatewayFile(file('server.key')),
      ca: await readGatewayFile(file('root.crt')),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      maxHeaderSize: 8192,
      requestTimeout: 5000,
      headersTimeout: 5000,
    },
    (incoming, outgoing) => {
      stats.upstreamRequests++;
      const peer = incoming.socket.getPeerCertificate().raw;
      if (
        !incoming.socket.authorized ||
        !peer?.equals(expectedPeer) ||
        incoming.headers.host !== hostname ||
        incoming.headers['x-agent-cloud-route-version'] !== '1'
      ) {
        reply(outgoing, 403, { error: 'forbidden' });
        return;
      }
      reply(outgoing, 200, { count: 42 });
    },
  );
  const servers = [control, guest];
  const close = async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise((resolve) => {
            server.close(resolve);
            server.closeAllConnections();
          }),
      ),
    );
  };
  stage = 'loopback server startup';
  try {
    for (const [server, port] of [
      [control, 4319],
      [guest, 8443],
    ]) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
    }
  } catch (error) {
    await close();
    throw error;
  }
  process.once('SIGTERM', () => {
    void close();
  });
  process.once('SIGINT', () => {
    void close();
  });
  process.stdout.write(json({ ready: true }));
}

async function manage(mode, { readGatewayFile }) {
  stage = 'authenticated fixture management';
  const token = await readGatewayFile(file('management-token'));
  const stats = await new Promise((resolve, reject) => {
    const call = request(
      {
        hostname: '127.0.0.1',
        port: 4319,
        path: `/fixture/${mode}`,
        method: mode === 'state' ? 'GET' : 'POST',
        agent: false,
        headers: { Authorization: `Bearer ${token}` },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error('Fixture management refused.'));
          return;
        }
        void readJson(response).then(resolve, reject);
      },
    );
    call.on('error', reject);
    call.setTimeout(5000, () => call.destroy(new Error('Fixture management timed out.')));
    call.end();
  });
  assert.deepEqual(Object.keys(stats).sort(), ['acks', 'outage', 'upstreamRequests']);
  assert.ok(Number.isSafeInteger(stats.acks) && stats.acks >= 0);
  assert.ok(Number.isSafeInteger(stats.upstreamRequests) && stats.upstreamRequests >= 0);
  assert.equal(typeof stats.outage, 'boolean');
  process.stdout.write(json(stats));
}

try {
  process.umask(0o077);
  const [mode, ...extra] = process.argv.slice(2);
  assert.equal(extra.length, 0);
  assert.ok(['initialize', 'serve', 'state', 'outage', 'recover'].includes(mode));
  const files = await import('/opt/agent-cloud/public-gateway/dist/certificate.js');
  if (mode === 'initialize') await initialize(files);
  else if (mode === 'serve') await serve(files);
  else await manage(mode, files);
} catch {
  // Never surface child output, certificate material, tokens or configuration in Docker logs.
  process.stderr.write(json({ error: 'Gateway container fixture failed.', stage }));
  process.exitCode = 1;
}

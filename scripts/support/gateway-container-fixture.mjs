import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual, X509Certificate } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { once } from 'node:events';

// This fixture runs only inside the production image, with two separately mounted volumes.
const privateDirectory = '/work/.local';
const gatewayDirectory = '/run/agent-cloud';
const gatewayName = 'fixture.gateway.agent-cloud.internal';
const hostname = 'app.fixture.test';
const serverName = 'guest.fixture.test';
const controlHostname = 'control.fixture.test';
const githubUserId = '700000001';
const githubToken = 'gho_fixture_gateway_customer_01';
const scratchDirectory = '/var/lib/agent-cloud/scratch';
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
const publicCaFile = file('gateway-public-root.crt');
let stage = 'arguments';

async function initialize(files) {
  const { prepareGatewayDirectory, readGatewayFile, writeGatewayFile } = files;
  stage = 'exclusive private directories';
  for (const directory of [privateDirectory, gatewayDirectory]) {
    await prepareGatewayDirectory(directory);
    assert.deepEqual(await readdir(directory), []);
  }
  stage = 'non-root customer scratch';
  const scratch = await lstat(scratchDirectory);
  assert.ok(scratch.isDirectory());
  assert.equal(scratch.uid, 1000);
  assert.equal(scratch.mode & 0o777, 0o700);
  const scratchProbe = join(scratchDirectory, 'fixture-write');
  const scratchFile = await open(scratchProbe, 'wx', 0o600);
  try {
    await scratchFile.writeFile('ok\n');
    await scratchFile.sync();
  } finally {
    await scratchFile.close();
  }
  await rm(scratchProbe);
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
  const generation = randomUUID();
  await writeGatewayFile(file('control-generation.json'), json({ version: 1, generation }), true);
  await writeGatewayFile(
    file('customer-request.json'),
    json({
      githubUserId,
      name: 'gateway-fixture-customer',
      policy: {
        capabilities: ['project:read', 'project:create'],
        projects: { kind: 'all' },
        sizes: ['small'],
        regions: ['nbg1'],
        maxMachines: 0,
        currency: 'EUR',
        maxHourlyMicros: 0,
      },
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }),
    true,
  );
  const { connect, controlState } =
    await import('/opt/agent-cloud/control/node_modules/@agent-cloud/db/dist/index.js');
  const connection = connect(process.env.DATABASE_URL);
  try {
    await connection.db.insert(controlState).values({
      id: 1,
      state: { kind: 'ready', generation },
    });
  } finally {
    await connection.pool.end();
  }
  const { publicGatewayControllerSchema } =
    await import('/opt/agent-cloud/public-gateway/dist/controller.js');
  const configuration = publicGatewayControllerSchema.parse({
    apiUrl: 'http://127.0.0.1:4319',
    tokenFile: exported('hosting-token'),
    gateway: {
      control: { hostname: controlHostname, port: 4319 },
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
  const [{ connect }, { createApp }, { createCustomerLogin }, { simulatedCatalog }, nodeServer] =
    await Promise.all([
      import('/opt/agent-cloud/control/node_modules/@agent-cloud/db/dist/index.js'),
      import('/opt/agent-cloud/control/dist/app.js'),
      import('/opt/agent-cloud/control/dist/customer-login.js'),
      import('/opt/agent-cloud/control/node_modules/@agent-cloud/contracts/dist/index.js'),
      import('/opt/agent-cloud/control/node_modules/@hono/node-server/dist/index.mjs'),
    ]);
  const connection = connect(process.env.DATABASE_URL);
  const application = createApp({
    db: connection.db,
    provider: 'simulated',
    limits: { currency: 'EUR', maxMachines: 0, maxHourlyMicros: 0 },
    catalog: () => simulatedCatalog('EUR'),
    login: createCustomerLogin({
      db: connection.db,
      clientId: 'fixture.client',
      verify: (token) => {
        assert.equal(token, githubToken);
        return Promise.resolve(githubUserId);
      },
    }),
  });
  const applicationListener = nodeServer.getRequestListener(application.fetch);
  const control = createServer(
    { maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 },
    (incoming, outgoing) => {
      if (
        incoming.url === '/healthz' ||
        incoming.url?.startsWith('/auth/') ||
        incoming.url?.startsWith('/v1/')
      ) {
        applicationListener(incoming, outgoing);
        return;
      }
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
    await connection.pool.end();
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

async function runCli(args, input) {
  const child = spawn(process.execPath, ['/opt/agent-cloud/entrypoint.mjs', 'cli', ...args], {
    cwd: '/work',
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      LANG: 'C',
      NODE_EXTRA_CA_CERTS: publicCaFile,
      ACLD_CREDENTIALS: file('customer.credentials.json'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderrBytes = 0;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (stdout.length > 65_536) child.kill('SIGKILL');
  });
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 65_536) child.kill('SIGKILL');
  });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  const timer = globalThis.setTimeout(() => child.kill('SIGKILL'), 20_000);
  try {
    const [code] = await once(child, 'exit');
    if (code !== 0) throw new Error('Packaged CLI command failed.');
    return JSON.parse(stdout);
  } finally {
    globalThis.clearTimeout(timer);
  }
}

async function controlRequest(path, { method = 'GET', authorization, body } = {}) {
  const ca = await open(publicCaFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  let certificate;
  try {
    certificate = await ca.readFile();
  } finally {
    await ca.close();
  }
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const call = httpsRequest(
      {
        protocol: 'https:',
        hostname: controlHostname,
        port: 8444,
        servername: controlHostname,
        ca: certificate,
        path,
        method,
        headers: {
          ...(authorization ? { Authorization: authorization } : {}),
          ...(encoded
            ? { 'Content-Type': 'application/json', 'Content-Length': String(encoded.length) }
            : {}),
        },
      },
      (response) => {
        void readJson(response).then(
          (value) => resolve({ status: response.statusCode, value }),
          reject,
        );
      },
    );
    call.on('error', reject);
    call.setTimeout(5000, () => call.destroy(new Error('Control HTTPS timed out.')));
    call.end(encoded);
  });
}

async function customerScenario(encodedCa, { readGatewayFile, writeGatewayFile }) {
  stage = 'public gateway CA import';
  assert.match(encodedCa, /^[A-Za-z0-9+/]+={0,2}$/);
  const decoded = Buffer.from(encodedCa, 'base64');
  assert.equal(decoded.toString('base64'), encodedCa);
  const pem = decoded.toString('utf8');
  const root = new X509Certificate(pem);
  assert.ok(root.ca);
  assert.equal(root.checkIssued(root), true);
  await writeGatewayFile(publicCaFile, pem, true);
  assert.equal(await readGatewayFile(publicCaFile), pem);
  stage = 'fixture-only GitHub exchange through trusted HTTPS';
  const cloudToken = `acld_${randomBytes(32).toString('base64url')}`;
  const login = await controlRequest('/auth/github', {
    method: 'POST',
    authorization: `Bearer ${githubToken}`,
    body: {
      id: randomUUID(),
      tokenHash: createHash('sha256').update(cloudToken).digest('hex'),
    },
  });
  assert.equal(login.status, 200);
  stage = 'packaged token-stdin login';
  const authenticated = await runCli(
    ['login', '--server', `https://${controlHostname}:8444`, '--token-stdin'],
    `${cloudToken}\n`,
  );
  const whoami = await runCli(['whoami']);
  assert.equal(authenticated.principal.accountId, whoami.principal.accountId);
  await runCli(['project', 'create', 'gateway-control']);
  const listed = await runCli(['project', 'list']);
  assert.equal(listed.projects.length, 2);
  process.stdout.write(
    json({ accountId: whoami.principal.accountId, projects: listed.projects.length }),
  );
}

async function disabledScenario() {
  stage = 'disabled credential rejection';
  let rejected = false;
  try {
    await runCli(['whoami']);
  } catch {
    rejected = true;
  }
  assert.equal(rejected, true);
  const response = await controlRequest('/auth/github', {
    method: 'POST',
    authorization: `Bearer ${githubToken}`,
    body: {
      id: randomUUID(),
      tokenHash: createHash('sha256').update('disabled').digest('hex'),
    },
  });
  assert.equal(response.status, 401);
  process.stdout.write(json({ disabled: true }));
}

try {
  process.umask(0o077);
  const [mode, ...extra] = process.argv.slice(2);
  assert.ok(
    ['initialize', 'serve', 'state', 'outage', 'recover', 'customer', 'disabled'].includes(mode),
  );
  assert.equal(extra.length, mode === 'customer' ? 1 : 0);
  const files = await import('/opt/agent-cloud/public-gateway/dist/certificate.js');
  if (mode === 'initialize') await initialize(files);
  else if (mode === 'serve') await serve(files);
  else if (mode === 'customer') await customerScenario(extra[0], files);
  else if (mode === 'disabled') await disabledScenario();
  else await manage(mode, files);
} catch {
  // Never surface child output, certificate material, tokens or configuration in Docker logs.
  process.stderr.write(json({ error: 'Gateway container fixture failed.', stage }));
  process.exitCode = 1;
}

import { randomBytes } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import type * as Net from 'node:net';
import {
  createConnection,
  createServer as createTcpServer,
  type Server,
  type Socket,
} from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  gatewayCheckSchema,
  gatewayClaimSchema,
  gatewayCloseSchema,
  type AccessCloseReason,
} from '../packages/contracts/src/index.js';
import { createAccessGateway } from '../apps/access-gateway/src/server.js';
import { pendingAccessSession } from './access-fixture.js';

const destination = vi.hoisted(() => ({ port: 0 }));
vi.mock('node:net', async (importOriginal) => {
  const net = await importOriginal<typeof Net>();
  return {
    ...net,
    // Keep the production port-22 contract while using an unprivileged real TCP listener.
    connect: (options: { host: string; port: number }) => {
      if (options.host !== '127.0.0.1' || options.port !== 22 || !destination.port)
        throw new Error('Gateway attempted a target outside the loopback fixture.');
      return net.connect({ ...options, port: destination.port });
    },
  };
});

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  destination.port = 0;
});

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback listener.');
  return address.port;
}

const closeServer = (server: Server) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

type Authority = 'valid' | 'rejected' | 'invalid_claim' | 'absent_check' | 'invalid_check';
async function fixture(options: { authority?: Authority; maximumSessionBytes?: number } = {}) {
  const targetSockets = new Set<Socket>();
  const targetBytes: Buffer[] = [];
  let openedTargets = 0;
  let closedTargets = 0;
  const target = createTcpServer((socket) => {
    openedTargets++;
    targetSockets.add(socket);
    socket.on('error', () => {});
    socket.on('data', (chunk: Buffer) => {
      targetBytes.push(chunk);
      socket.write(chunk);
    });
    socket.once('close', () => {
      closedTargets++;
      targetSockets.delete(socket);
    });
  });
  destination.port = await listen(target);
  cleanup.push(async () => {
    for (const socket of targetSockets) socket.destroy();
    await closeServer(target);
  });

  const session = pendingAccessSession();
  const token = `aclg_${randomBytes(32).toString('base64url')}`;
  const ticket = `aclt_${randomBytes(32).toString('base64url')}`;
  const requests: string[] = [];
  const reports: AccessCloseReason[] = [];
  const controlErrors: unknown[] = [];
  const lease = (connectionId: string) => ({
    sessionId: session.id,
    connectionId,
    remainingMs: 60_000,
    target: { ...session.identityPin, address: '127.0.0.1', port: 22 },
  });
  const control = createHttpServer((request, response) => {
    void (async () => {
      requests.push(request.url ?? '');
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        if (!Buffer.isBuffer(chunk)) throw new Error('Expected a binary HTTP request body.');
        chunks.push(chunk);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/gateway/v1/claim') {
        const claim = gatewayClaimSchema.parse(body);
        expect(claim.ticket).toBe(ticket);
        if (options.authority === 'rejected') {
          response.writeHead(401).end('{}');
          return;
        }
        response.end(
          JSON.stringify(options.authority === 'invalid_claim' ? {} : lease(claim.connectionId)),
        );
      } else if (request.url === '/gateway/v1/check') {
        const check = gatewayCheckSchema.parse(body);
        const leases = check.connections.map((connection) => lease(connection.connectionId));
        response.end(
          JSON.stringify(
            options.authority === 'invalid_check'
              ? { leases: [{}] }
              : { leases: options.authority === 'absent_check' ? [] : leases },
          ),
        );
      } else if (request.url === '/gateway/v1/close') {
        reports.push(gatewayCloseSchema.parse(body).reason);
        response.end(JSON.stringify({ closed: true }));
      } else response.writeHead(404).end('{}');
    })().catch((error: unknown) => {
      controlErrors.push(error);
      response.writeHead(500).end('{}');
    });
  });
  const controlPort = await listen(control);
  let authorityStopped = false;
  const stopAuthority = async () => {
    if (authorityStopped) return;
    authorityStopped = true;
    control.closeAllConnections();
    await closeServer(control);
  };
  cleanup.push(async () => {
    await stopAuthority();
    expect(controlErrors).toEqual([]);
  });
  const gateway = createAccessGateway({
    controlUrl: `http://127.0.0.1:${controlPort}`,
    token,
    port: 0,
    ...(options.maximumSessionBytes === undefined
      ? {}
      : { maximumSessionBytes: options.maximumSessionBytes }),
  });
  await gateway.listen();
  cleanup.push(() => gateway.close());
  const address = gateway.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing gateway listener.');
  const port = address.port;
  const clients = new Set<WebSocket>();
  cleanup.push(() => {
    for (const client of clients) client.terminate();
  });
  function websocket(authorization: string | null = `Bearer ${ticket}`) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ssh`, {
      headers: authorization === null ? {} : { Authorization: authorization },
      handshakeTimeout: 1500,
      perMessageDeflate: false,
    });
    clients.add(ws);
    let opened = false;
    ws.once('open', () => {
      opened = true;
    });
    ws.on('error', () => {});
    const closed = new Promise<number>((resolve) => ws.once('close', resolve));
    return { ws, closed, opened: () => opened };
  }
  async function connected() {
    const client = websocket();
    await new Promise<void>((resolve, reject) => {
      client.ws.once('open', resolve);
      client.ws.once('error', reject);
    });
    return client;
  }
  return {
    connected,
    websocket,
    port,
    ticket,
    requests,
    reports,
    stopAuthority,
    targetBytes: () => Buffer.concat(targetBytes),
    openedTargets: () => openedTargets,
    closedTargets: () => closedTargets,
    activeTargets: () => targetSockets.size,
  };
}

it('forwards binary bytes in both directions and closes the target with the client', async () => {
  const f = await fixture();
  const { ws, closed } = await f.connected();
  const received = new Promise<Buffer>((resolve, reject) =>
    ws.once('message', (data, binary) => {
      if (!binary || !Buffer.isBuffer(data)) reject(new Error('Expected binary gateway output.'));
      else resolve(data);
    }),
  );
  const bytes = Buffer.from([0, 1, 255, 13, 10, 128, 42]);
  ws.send(bytes);
  expect(await received).toEqual(bytes);
  expect(f.targetBytes()).toEqual(bytes);
  ws.close();
  await closed;
  await expect.poll(f.activeTargets).toBe(0);
  await expect.poll(() => f.reports).toContain('client_closed');
  expect(f.openedTargets()).toBe(1);
});

it('cuts off the real transport within its 15-second lease when authority goes offline', async () => {
  const f = await fixture();
  const { closed } = await f.connected();
  const started = performance.now();
  await f.stopAuthority();
  await closed;
  const elapsed = performance.now() - started;
  // The native CLI is absent here, so this measures gateway cutoff rather than SSH keepalives.
  expect(elapsed).toBeGreaterThan(13_000);
  expect(elapsed).toBeLessThan(16_000);
  await expect.poll(f.activeTargets).toBe(0);
  expect(f.openedTargets()).toBe(1);
  expect(f.closedTargets()).toBe(1);
});

it.each(['text', 'oversized'] satisfies Array<'text' | 'oversized'>)(
  'rejects a %s frame before forwarding its bytes to the target',
  async (kind) => {
    const f = await fixture();
    const { ws, closed } = await f.connected();
    ws.send(kind === 'text' ? 'must not reach SSH' : Buffer.alloc(65_537, 97));
    await closed;
    await expect.poll(f.activeTargets).toBe(0);
    await expect.poll(() => f.reports).toContain('transport_failed');
    expect(f.targetBytes()).toHaveLength(0);
  },
);

it('enforces the session byte limit across both directions', async () => {
  const f = await fixture({ maximumSessionBytes: 10 });
  const { ws, closed } = await f.connected();
  ws.send(Buffer.from('123456'));
  await closed;
  await expect.poll(f.activeTargets).toBe(0);
  await expect.poll(() => f.reports).toContain('limit_exceeded');
  expect(f.targetBytes().toString()).toBe('123456');
});

it.each([null, 'Bearer invalid-ticket'])(
  'rejects ticket %s before requesting authority',
  async (authorization) => {
    const f = await fixture();
    const client = f.websocket(authorization);
    await client.closed;
    expect(client.opened()).toBe(false);
    expect(f.requests).toEqual([]);
    expect(f.openedTargets()).toBe(0);
  },
);

it.each(['rejected', 'invalid_claim', 'absent_check', 'invalid_check'] satisfies Authority[])(
  'never opens the target with %s gateway authority',
  async (authority) => {
    const f = await fixture({ authority });
    const client = f.websocket();
    await client.closed;
    expect(client.opened()).toBe(false);
    expect(f.requests).toContain('/gateway/v1/claim');
    expect(f.openedTargets()).toBe(0);
  },
);

it('does not leak a target connection when the WebSocket upgrade is malformed', async () => {
  const f = await fixture();
  const socket = createConnection({ host: '127.0.0.1', port: f.port });
  const response: Buffer[] = [];
  socket.on('data', (chunk: Buffer) => response.push(chunk));
  const closed = new Promise<void>((resolve, reject) => {
    socket.once('close', () => {
      resolve();
    });
    socket.once('error', reject);
  });
  socket.setTimeout(1500, () => {
    socket.destroy(new Error('Upgrade did not finish.'));
  });
  socket.write(
    [
      'GET /v1/ssh HTTP/1.1',
      `Host: 127.0.0.1:${f.port}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      `Authorization: Bearer ${f.ticket}`,
      '',
      '',
    ].join('\r\n'),
  );
  await closed;
  expect(Buffer.concat(response).toString()).toContain('400 Bad Request');
  await expect.poll(f.closedTargets).toBe(1);
  await expect.poll(() => f.reports).toContain('transport_failed');
  expect(f.activeTargets()).toBe(0);
  expect(f.targetBytes()).toHaveLength(0);
});

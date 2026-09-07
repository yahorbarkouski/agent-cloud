import { createServer } from 'node:http';
import { connect, Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { z } from 'zod';
import {
  apiUrlSchema,
  accessTicketSchema,
  gatewayLeaseSchema,
  gatewayCheckResponseSchema,
  type gatewayConnectionSchema,
  type AccessCloseReason,
} from '@agent-cloud/contracts';

export const gatewayConfigSchema = z.strictObject({
  controlUrl: apiUrlSchema,
  token: z.string().regex(/^aclg_[A-Za-z0-9_-]{43}$/),
  host: z.string().default('127.0.0.1'),
  port: z.int().min(0).max(65535).default(4322),
  maximumConnections: z.int().min(1).max(1000).default(100),
  maximumSessionBytes: z.int().positive().max(1_073_741_824).default(268_435_456),
});

/** Separate process: no database, signing, provider, or customer owner credentials. */
export function createAccessGateway(value: z.input<typeof gatewayConfigSchema>) {
  const config = gatewayConfigSchema.parse(value);
  const gatewayInstanceId = randomUUID();
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 },
    (_req, res) => {
      res.writeHead(404, { 'Content-Length': '0' });
      res.end();
    },
  );
  server.maxHeadersCount = 32;
  server.maxConnections = config.maximumConnections + 10;
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.setTimeout(8000, () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65_536, perMessageDeflate: false });
  const connections = new Map<
    string,
    {
      identity: z.infer<typeof gatewayConnectionSchema>;
      refresh: (remaining: number, started: number) => void;
      stop: (reason: AccessCloseReason) => void;
    }
  >();
  async function rpc<T>(path: string, body: unknown, schema: z.ZodType<T>) {
    const response = await fetch(`${config.controlUrl.replace(/\/$/, '')}/gateway/v1/${path}`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(4000),
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error('Gateway authority was not established.');
    const bytes = await response.text();
    if (Buffer.byteLength(bytes) > 262_144) throw new Error('Oversized gateway response.');
    return schema.parse(JSON.parse(bytes));
  }
  let checking = false;
  const heartbeat = setInterval(() => {
    if (checking || connections.size === 0) return;
    checking = true;
    const snapshot = [...connections.values()];
    const started = performance.now();
    void (async () => {
      // RPC batches remain bounded even when an operator raises the socket ceiling.
      for (let offset = 0; offset < snapshot.length; offset += 100) {
        const batch = snapshot.slice(offset, offset + 100);
        const result = await rpc(
          'check',
          { connections: batch.map((c) => c.identity) },
          gatewayCheckResponseSchema,
        );
        const leases = new Map(result.leases.map((lease) => [lease.connectionId, lease]));
        for (const connection of batch) {
          const lease = leases.get(connection.identity.connectionId);
          if (!lease || lease.sessionId !== connection.identity.sessionId)
            connection.stop('authorization_changed');
          else connection.refresh(lease.remainingMs, started);
        }
      }
    })()
      .catch(() => {
        // Existing monotonic deadlines are not extended on failed, delayed or lost checks.
      })
      .finally(() => {
        checking = false;
      });
  }, 5000);
  heartbeat.unref();
  let pending = 0;
  server.on('upgrade', (request, socket, head) => {
    if (!(socket instanceof Socket)) {
      socket.destroy();
      return;
    }
    const parsed = accessTicketSchema.safeParse(
      request.headers.authorization?.replace(/^Bearer /, ''),
    );
    if (
      request.url !== '/v1/ssh' ||
      request.headers.origin !== undefined ||
      !request.headers.authorization?.startsWith('Bearer ') ||
      !parsed.success ||
      pending + connections.size >= config.maximumConnections
    ) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const socketClosed = () => socket.destroyed;
    pending++;
    void (async () => {
      const connectionId = randomUUID();
      const claimStarted = performance.now();
      const lease = await rpc(
        'claim',
        { ticket: parsed.data, gatewayInstanceId, connectionId },
        gatewayLeaseSchema,
      );
      const identity = { sessionId: lease.sessionId, gatewayInstanceId, connectionId };
      let hardDeadline = claimStarted + lease.remainingMs;
      const reportClose = (reason: AccessCloseReason) => {
        void rpc('close', { ...identity, reason }, z.object({ closed: z.literal(true) })).catch(
          () => {},
        );
      };
      if (socketClosed()) {
        reportClose('client_closed');
        return;
      }
      const checkStarted = performance.now();
      const check = await rpc('check', { connections: [identity] }, gatewayCheckResponseSchema);
      const current = check.leases.find(
        (l) => l.sessionId === identity.sessionId && l.connectionId === connectionId,
      );
      if (!current) {
        reportClose('authorization_changed');
        throw new Error('Connection authority changed.');
      }
      hardDeadline = Math.min(hardDeadline, checkStarted + current.remainingMs);
      if (performance.now() >= Math.min(hardDeadline, checkStarted + 15_000) || socketClosed()) {
        reportClose('expired');
        throw new Error('Connection lease expired.');
      }
      const target = connect({ host: current.target.address, port: current.target.port });
      target.pause();
      target.setTimeout(4000, () => target.destroy(new Error('Target connection timed out.')));
      try {
        await new Promise<void>((resolve, reject) => {
          target.once('connect', resolve);
          target.once('error', reject);
        });
      } catch {
        target.destroy();
        reportClose('transport_failed');
        throw new Error('Target unavailable.');
      }
      if (socketClosed()) {
        target.destroy();
        reportClose('client_closed');
        return;
      }
      target.setTimeout(0);
      socket.setTimeout(0);
      let upgraded = false;
      const wasUpgraded = () => upgraded;
      try {
        wss.handleUpgrade(request, socket, head, (ws) => {
          upgraded = true;
          let stopped = false;
          const isStopped = () => stopped;
          let deadlineTimer: ReturnType<typeof setTimeout>;
          const stop = (reason: AccessCloseReason) => {
            if (stopped) return;
            stopped = true;
            clearTimeout(deadlineTimer);
            connections.delete(connectionId);
            target.destroy();
            ws.terminate();
            reportClose(reason);
          };
          const refresh = (remaining: number, started: number) => {
            if (stopped) return;
            hardDeadline = Math.min(hardDeadline, started + remaining);
            const deadline = Math.min(hardDeadline, started + 15_000);
            clearTimeout(deadlineTimer);
            if (deadline <= performance.now()) {
              stop('expired');
              return;
            }
            deadlineTimer = setTimeout(() => {
              stop('expired');
            }, deadline - performance.now());
          };
          // Reject text before the stream adapter can forward it into SSH.
          ws.on('message', (_data, binary) => {
            if (!binary) stop('transport_failed');
          });
          const stream = createWebSocketStream(ws, { highWaterMark: 65_536 });
          let bytes = 0;
          const count = (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > config.maximumSessionBytes) stop('limit_exceeded');
          };
          stream.on('data', count);
          target.on('data', count);
          stream.on('error', () => {
            stop('transport_failed');
          });
          target.on('error', () => {
            stop('transport_failed');
          });
          ws.on('error', () => {
            stop('transport_failed');
          });
          ws.once('close', () => {
            stop('client_closed');
          });
          connections.set(connectionId, { identity, refresh, stop });
          refresh(current.remainingMs, checkStarted);
          if (!isStopped()) {
            stream.pipe(target);
            target.pipe(stream);
            target.resume();
          }
        });
      } finally {
        if (!wasUpgraded()) {
          target.destroy();
          reportClose('transport_failed');
        }
      }
    })()
      .catch(() => {
        socket.destroy();
      })
      .finally(() => {
        pending--;
      });
  });
  return {
    server,
    listen: () =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, resolve);
      }),
    close: async () => {
      clearInterval(heartbeat);
      for (const connection of connections.values()) connection.stop('gateway_unavailable');
      for (const socket of sockets) socket.destroy();
      wss.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    },
  };
}

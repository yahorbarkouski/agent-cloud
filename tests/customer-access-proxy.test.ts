import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';

it.each(['terminate', 'close'] satisfies Array<'terminate' | 'close'>)(
  'exits the actual access-proxy promptly after WebSocket %s while caller stdin stays open',
  async (ending) => {
    const directory = await mkdtemp(join(tmpdir(), 'acld-proxy-test-'));
    const profile = join(directory, 'proxy.json');
    const ticket = `aclt_${randomBytes(32).toString('base64url')}`;
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing proxy fixture address.');
    const origin = `ws://127.0.0.1:${address.port}`;
    await writeFile(
      profile,
      JSON.stringify({
        gateway: { id: 'proxy-test', origin, egressCidrs: ['127.0.0.1/32'] },
        ticket,
      }),
      { flag: 'wx', mode: 0o600 },
    );
    const connection = new Promise<WebSocket>((resolve, reject) => {
      server.once('connection', (socket, request) => {
        if (request.url !== '/v1/ssh' || request.headers.authorization !== `Bearer ${ticket}`)
          reject(new Error('Proxy did not use the expected ticket and endpoint.'));
        else resolve(socket);
      });
    });
    const child = spawn(
      process.execPath,
      ['apps/cli/dist/index.js', 'access-proxy', '--profile', profile],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
        killSignal: 'SIGKILL',
        env: {
          PATH: process.env.PATH,
          ACLD_CREDENTIALS: join(directory, 'unused-owner-credentials.json'),
        },
      },
    );
    child.stdin.on('error', () => {});
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    let exitCode: number | null | undefined;
    const exited = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        exitCode = code;
        resolve();
      });
    });
    try {
      const socket = await Promise.race([
        connection,
        exited.then(() => {
          throw new Error('Proxy exited before opening its WebSocket.');
        }),
      ]);
      socket.send(Buffer.from('SSH-2.0-loopback-fixture\r\n'));
      await expect
        .poll(() => Buffer.concat(stdout).toString())
        .toBe('SSH-2.0-loopback-fixture\r\n');
      expect(child.stdin.writableEnded).toBe(false);
      const started = performance.now();
      socket[ending]();
      await expect.poll(() => exitCode, { timeout: 1800, interval: 10 }).toBe(0);
      expect(performance.now() - started).toBeLessThan(2000);
      expect(child.stdin.writableEnded).toBe(false);
      expect(Buffer.concat(stdout).toString()).not.toContain(ticket);
      expect(Buffer.concat(stderr).toString()).not.toContain(ticket);
    } finally {
      child.stdin.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited.catch(() => {});
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      await rm(directory, { recursive: true, force: true });
    }
  },
);

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, access, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';

// Operator bootstrap helper: one credential, one local file, then stop listening.
const directory = resolve('.local');
const destination = resolve(directory, 'hcloud-token');
await mkdir(directory, { recursive: true, mode: 0o700 });
const info = await lstat(directory);
if (!info.isDirectory() || (info.mode & 0o077) !== 0)
  throw new Error('The .local directory must be a real owner-only directory, not a symlink.');
try {
  await access(destination);
  throw new Error('A Hetzner credential file already exists; refusing to replace it.');
} catch (error) {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
}
const route = `/setup/${randomBytes(24).toString('hex')}`;
let origin = '';
let consumed = false;
function consume() {
  if (consumed) return false;
  consumed = true;
  return true;
}
const server = createServer((request, response) => {
  void (async () => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.headers.host !== new URL(origin).host || request.url !== route || consumed) {
      response.writeHead(404).end();
      return;
    }
    if (request.method === 'GET') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(
        '<!doctype html><title>Local Hetzner credential setup</title><h1>Save the project token locally</h1><p>The token is written once to an owner-only file in this checkout. It is never printed.</p><form method="post"><label>Hetzner API token <input type="password" name="token" autocomplete="off" required minlength="32" maxlength="512"></label><button type="submit">Save token</button></form>',
      );
      return;
    }
    if (request.method !== 'POST' || request.headers.origin !== origin) {
      response.writeHead(403).end();
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    for await (const chunk of request) {
      if (typeof chunk !== 'string') throw new Error('Invalid request encoding.');
      body += chunk;
      if (body.length > 2048) {
        response.writeHead(413).end();
        return;
      }
    }
    const token = new URLSearchParams(body).get('token');
    if (!token || !/^[A-Za-z0-9_-]{32,512}$/.test(token)) {
      response.writeHead(400).end('Invalid token format.');
      return;
    }
    // Another request may have completed while this request was reading its body.
    if (!consume()) {
      response.writeHead(409).end();
      return;
    }
    await writeFile(destination, `${token}\n`, { mode: 0o600, flag: 'wx' });
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(
      '<!doctype html><title>Credential saved</title><h1>Credential saved securely</h1><p>The local setup listener has stopped. You can close this tab.</p>',
    );
    process.stdout.write(JSON.stringify({ event: 'credential.saved', path: destination }) + '\n');
    server.close();
    clearTimeout(deadline);
  })().catch(() => {
    if (!response.headersSent) response.writeHead(500);
    response.end('Credential could not be saved.');
    server.close();
    clearTimeout(deadline);
    process.exitCode = 1;
  });
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
const deadline = setTimeout(() => {
  server.close();
  server.closeAllConnections();
}, 10 * 60_000);
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a loopback TCP listener.');
  origin = `http://127.0.0.1:${address.port}`;
  process.stdout.write(
    JSON.stringify({ setupUrl: `${origin}${route}`, expiresInSeconds: 600 }) + '\n',
  );
});

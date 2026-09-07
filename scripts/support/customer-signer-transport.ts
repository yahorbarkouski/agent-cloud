import assert from 'node:assert/strict';
import { createServer, request } from 'node:https';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type AccessSessionRecord, newId } from '../../packages/contracts/src/index.js';
import { createCustomerSshSigner } from '../../packages/pki/src/customer-ssh.js';
import type { withCaFixture } from './ca-fixture.js';

/** Faults occur after the actual signer submits to a TLS-authenticated local endpoint. */
export async function checkCustomerSigningTransport(
  input: Parameters<Parameters<typeof withCaFixture>[0]>[0] & { session: AccessSessionRecord },
) {
  const { configuration, scratch, run } = input;
  const pki = join(scratch, '.local/pki');
  const certificate = join(scratch, 'proxy.crt');
  const key = join(scratch, 'proxy.key');
  await run(configuration.binary, [
    'certificate',
    'create',
    'localhost',
    certificate,
    key,
    '--profile',
    'leaf',
    '--san',
    'localhost',
    '--ca',
    join(pki, 'public/root_ca.crt'),
    '--ca-key',
    join(pki, 'offline/root_ca_key'),
    '--ca-password-file',
    join(pki, 'issuer/password'),
    '--no-password',
    '--insecure',
  ]);
  type Fault = 'lost_response' | 'rejected' | 'redirect' | 'oversized' | 'truncated' | 'cancelled';
  let mode: Fault = 'lost_response';
  let posts = 0;
  let caIssued = 0;
  let redirected = 0;
  let cancellation = new AbortController();
  const server = createServer(
    { cert: await readFile(certificate), key: await readFile(key) },
    (incoming, outgoing) => {
      if (incoming.url === '/redirected') redirected++;
      if (incoming.method === 'POST') {
        posts++;
        switch (mode) {
          case 'rejected':
            outgoing.writeHead(403).end('Deliberate fixture rejection.');
            return;
          case 'redirect':
            outgoing.writeHead(307, { Location: '/redirected' }).end();
            return;
          case 'oversized':
            outgoing.writeHead(201).end('x'.repeat(33 * 1024));
            return;
          case 'truncated':
            outgoing.writeHead(201, { 'Content-Length': 100 }).write('{');
            outgoing.destroy();
            return;
          case 'cancelled':
            cancellation.abort();
            return;
          case 'lost_response':
            break;
          default: {
            const exhaustive: never = mode;
            return exhaustive;
          }
        }
      }
      const upstream = request(
        new URL(incoming.url ?? '/', configuration.caUrl),
        {
          method: incoming.method,
          ca: configuration.tlsRoot,
          agent: false,
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(10_000),
        },
        (response) => {
          if (incoming.method === 'POST') {
            if (response.statusCode === 201) caIssued++;
            response.resume();
            response.on('end', () => outgoing.destroy());
          } else {
            outgoing.writeHead(response.statusCode ?? 502, { 'Content-Type': 'application/json' });
            response.pipe(outgoing);
          }
          response.on('error', () => outgoing.destroy());
        },
      );
      upstream.on('error', () => outgoing.destroy());
      incoming.on('error', () => upstream.destroy());
      incoming.pipe(upstream);
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected local TLS listener.');
    const signer = createCustomerSshSigner({
      ...configuration,
      caUrl: `https://localhost:${address.port}`,
    });
    const preSubmit = await createCustomerSshSigner({
      ...configuration,
      caUrl: `https://localhost:${address.port}`,
      binary: '/usr/bin/false',
    }).sign({
      session: input.session,
      authority: { checkedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) },
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(preSubmit.kind, 'failed');
    assert.equal(posts, 0, 'Failed token generation must not submit a signing request.');
    const results = [];
    for (const next of [
      'lost_response',
      'rejected',
      'redirect',
      'oversized',
      'truncated',
      'cancelled',
    ] satisfies Fault[]) {
      mode = next;
      const before: number = posts;
      cancellation = new AbortController();
      const now = Date.now();
      const session = {
        ...input.session,
        id: newId.accessSession(),
        admittedAt: new Date(now - 2000).toISOString(),
        issueDeadline: new Date(now + 88_000).toISOString(),
        hardDeadline: new Date(now + 3_598_000).toISOString(),
        issuance: { kind: 'attempted', attemptedAt: new Date(now - 1000).toISOString() },
      } satisfies AccessSessionRecord;
      const result = await signer.sign({
        session,
        authority: { checkedAt: new Date(now), expiresAt: new Date(now + 3_598_000) },
        signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(20_000)]),
      });
      assert.equal(posts - before, 1, 'A failed signing response must not trigger another POST.');
      assert.equal(result.kind, next === 'rejected' ? 'rejected' : 'unknown');
      results.push(next);
    }
    assert.equal(caIssued, 1, 'The lost response must follow real native CA issuance.');
    assert.equal(redirected, 0, 'The signer must not follow redirects.');
    process.stdout.write(
      JSON.stringify({
        transportFaults: results,
        exactlyOnePostPerAttempt: true,
        lostResponseAfterRealIssuance: true,
      }) + '\n',
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
}

import { createServer } from 'node:net';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { waitForSshBanner } from '../scripts/support/ssh-fixture.js';

it('waits through accepted TCP connections until the disposable server speaks SSH', async () => {
  let connections = 0;
  const server = createServer((socket) => {
    connections++;
    if (connections === 1) socket.end();
    else if (connections === 2) socket.end('HTTP/1.1 503 Not Ready\r\n');
    else {
      socket.write('SSH-2.0-');
      setTimeout(() => socket.end('OpenSSH_fixture\r\n'), 20);
    }
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port.');
    await waitForSshBanner(address.port);
    expect(connections).toBe(3);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
});

import { lstat, open, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:fs';
import { Buffer } from 'node:buffer';
import process from 'node:process';

const needle = await readFile('/tmp/agent-cloud-token-needle');
if (needle.byteLength !== 43) throw new Error('Expected one fixture token.');
const matches = [];
let files = 0;
let bytes = 0;
async function scan(path) {
  const info = await lstat(path);
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) await scan(join(path, entry));
  } else if (info.isFile()) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) throw new Error('Scan target changed file type.');
      const buffer = Buffer.alloc(65536);
      let tail = Buffer.alloc(0);
      for (;;) {
        const { bytesRead } = await file.read(buffer);
        if (!bytesRead) break;
        bytes += bytesRead;
        if (bytes > 512 * 1024 * 1024) throw new Error('Fixture scan exceeded its byte limit.');
        const chunk = Buffer.concat([tail, buffer.subarray(0, bytesRead)]);
        if (chunk.includes(needle)) {
          matches.push(path);
          break;
        }
        tail = chunk.subarray(-needle.byteLength + 1);
      }
      files++;
    } finally {
      await file.close();
    }
  }
  // Never open symlinks, sockets or cloud-init's hotplug FIFO.
}
for (const path of [
  '/var/lib/cloud',
  '/run/cloud-init',
  '/var/log',
  '/var/lib/agent-cloud',
  '/etc/cloud',
  '/tmp/agent-cloud-journal',
])
  await scan(path);
process.stdout.write(JSON.stringify({ files, bytes, matches }) + '\n');

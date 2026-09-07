import type { Readable } from 'node:stream';
import { Readable as NodeReadable } from 'node:stream';
import { CloudError } from '@agent-cloud/contracts';

/** SSH may split a UTF-8 codepoint between chunks; decode before parsing a bounded JSON request. */
export async function readJsonInput(stream: Readable, maximumBytes: number): Promise<unknown> {
  stream.setEncoding('utf8');
  const chunks: string[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const text = String(chunk);
    bytes += Buffer.byteLength(text);
    if (bytes > maximumBytes)
      throw new CloudError('invalid_input', 'Guest request exceeds its size limit.');
    chunks.push(text);
  }
  return JSON.parse(chunks.join(''));
}

/** Read one bounded UTF-8 JSON header without consuming the binary bytes that follow it. */
export async function readJsonHeader(
  stream: Readable,
  maximumBytes: number,
): Promise<{ value: unknown; body: Readable }> {
  const iterator = stream[Symbol.asyncIterator]();
  const chunks: Buffer[] = [];
  let bytes = 0;
  for (;;) {
    const next = await iterator.next();
    if (next.done) throw new CloudError('invalid_input', 'Guest request header is incomplete.');
    const chunk = toBuffer(next.value);
    const newline = chunk.indexOf(0x0a);
    const header = newline === -1 ? chunk : chunk.subarray(0, newline);
    bytes += header.length;
    if (bytes > maximumBytes)
      throw new CloudError('invalid_input', 'Guest request header exceeds its size limit.');
    chunks.push(Buffer.from(header));
    if (newline !== -1) {
      const remainder = chunk.subarray(newline + 1);
      const body = NodeReadable.from(
        (async function* () {
          if (remainder.length) yield remainder;
          for (;;) {
            const value = await iterator.next();
            if (value.done) return;
            yield toBuffer(value.value);
          }
        })(),
      );
      return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')), body };
    }
  }
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value);
  throw new CloudError('invalid_input', 'Guest request contains an invalid stream chunk.');
}

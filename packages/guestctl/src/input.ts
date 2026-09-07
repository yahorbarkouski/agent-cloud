import type { Readable } from 'node:stream';
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

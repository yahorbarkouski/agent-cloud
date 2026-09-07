import { resolve } from 'node:path';
import { z } from 'zod';
import { readPrivateFile } from '../../apps/control/src/private-file.js';

export const builderPath = resolve('.local/guest-image-builder.json');
export const builderSchema = z.strictObject({
  purpose: z.literal('agent-cloud-local-image-builder'),
  name: z.string().regex(/^agent-cloud-builder-[0-9a-f]{8}$/),
  builderId: z.uuid(),
  phase: z.enum(['building', 'sanitized']),
});
export const imageReceiptSchema = z.object({
  kind: z.literal('sanitized'),
  builderId: z.uuid(),
  manifestDigest: z.string().regex(/^[0-9a-f]{64}$/),
});
export async function readImageBuilder() {
  return builderSchema.parse(JSON.parse(await readPrivateFile(builderPath)));
}

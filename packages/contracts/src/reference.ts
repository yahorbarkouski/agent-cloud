import { z } from 'zod';

// This is an internal fixed recipe, not an arbitrary command or customer Compose upload.
export const referenceReleaseSchema = z.strictObject({
  releaseId: z.uuid(),
  expectedReleaseId: z.uuid().nullable(),
  revision: z.enum(['1', '2']),
  hostname: z
    .string()
    .max(253)
    .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/),
});
export type ReferenceRelease = z.infer<typeof referenceReleaseSchema>;
export const referenceCommandSchema = z.discriminatedUnion('kind', [
  referenceReleaseSchema.extend({ kind: z.literal('apply') }),
  z.strictObject({ kind: z.literal('inspect') }),
  z.strictObject({ kind: z.literal('logs') }),
]);
export type ReferenceCommand = z.infer<typeof referenceCommandSchema>;
export const referenceInputSchema = z.discriminatedUnion('kind', [
  referenceReleaseSchema.omit({ hostname: true }).extend({ kind: z.literal('apply') }),
  z.strictObject({ kind: z.literal('inspect') }),
  z.strictObject({ kind: z.literal('logs') }),
]);
export type ReferenceInput = z.infer<typeof referenceInputSchema>;
export const referenceStateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('absent') }),
  z.strictObject({
    kind: z.literal('release'),
    release: referenceReleaseSchema,
    phase: z.enum(['pending', 'running', 'succeeded', 'failed']),
    updatedAt: z.iso.datetime(),
  }),
]);
export type ReferenceState = z.infer<typeof referenceStateSchema>;
export const referenceResponseSchema = z.strictObject({
  state: referenceStateSchema,
  output: z.string().max(32768),
});

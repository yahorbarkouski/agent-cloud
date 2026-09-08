import { z } from 'zod';
import { failureSchema } from './errors.js';

export const composeAppSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export const composeReleaseIdSchema = z.uuidv4().regex(/^[a-f0-9-]{36}$/);
export const composePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      value.split('/').every((part) => part !== '' && part !== '.' && part !== '..') &&
      Array.from(value, (character) => character.charCodeAt(0)).every(
        (code) => code >= 32 && code !== 127 && code !== 92,
      ),
  );
export const composeFileSchema = z.strictObject({
  path: composePathSchema,
  content: z.base64().max(11_184_812),
  executable: z.boolean(),
});
export const composeBundleSchema = z
  .array(composeFileSchema)
  .min(1)
  .max(1024)
  .refine(
    (files) =>
      new Set(files.map((file) => file.path)).size === files.length &&
      files.reduce((bytes, file) => bytes + file.content.length, 0) <= 11_184_812,
  );
const mutation = {
  app: composeAppSchema,
  releaseId: composeReleaseIdSchema,
  expectedReleaseId: composeReleaseIdSchema.nullable(),
  waitSeconds: z.int().min(5).max(300).default(120),
};
export const composeApplySchema = z.strictObject({
  kind: z.literal('apply'),
  ...mutation,
  file: composePathSchema.default('compose.yaml'),
  files: composeBundleSchema,
});
export const composeRecoverSchema = z.strictObject({
  kind: z.literal('recover'),
  ...mutation,
  fromReleaseId: composeReleaseIdSchema,
});
export const composePromoteSchema = z.strictObject({
  kind: z.literal('promote'),
  ...mutation,
  expectedReleaseId: composeReleaseIdSchema,
  fromReleaseId: composeReleaseIdSchema,
});
export const composeCommandSchema = z.discriminatedUnion('kind', [
  composeApplySchema,
  composeRecoverSchema,
  composePromoteSchema,
  z.strictObject({ kind: z.literal('inspect'), app: composeAppSchema }),
  z.strictObject({
    kind: z.literal('logs'),
    app: composeAppSchema,
    service: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)
      .optional(),
  }),
]);
export type ComposeCommand = z.infer<typeof composeCommandSchema>;
export const composeReleaseSchema = z.strictObject({
  id: composeReleaseIdSchema,
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  previousSuccessfulReleaseId: composeReleaseIdSchema.nullable(),
  phase: z.enum(['queued', 'preparing', 'applying', 'succeeded', 'failed', 'interrupted']),
  submittedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  configDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  images: z.record(z.string(), z.string().regex(/^sha256:[a-f0-9]{64}$/)),
  failure: z.string().max(1024).nullable(),
});
export type ComposeRelease = z.infer<typeof composeReleaseSchema>;
export const composeResponseSchema = z.strictObject({
  app: composeAppSchema,
  project: z.string(),
  release: composeReleaseSchema.nullable(),
  containers: z.array(
    z.strictObject({
      id: z.string(),
      service: z.string(),
      state: z.string(),
      health: z.string(),
      exitCode: z.int(),
    }),
  ),
  output: z.string().max(131_072),
});
export const composeReplySchema = z.union([
  composeResponseSchema,
  z.strictObject({ error: failureSchema }),
]);

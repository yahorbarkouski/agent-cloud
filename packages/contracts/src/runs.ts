import { z } from 'zod';
import { failureSchema } from './errors.js';

const argument = z
  .string()
  .max(8192)
  .refine((value) => !value.includes('\0'));
const absolutePath = argument.refine((value) => value.startsWith('/'));
export const runIdSchema = z
  .uuidv4()
  .regex(/^[a-f0-9-]{36}$/)
  .brand<'RunId'>();
export type RunId = z.infer<typeof runIdSchema>;
export const runRequestSchema = z.strictObject({
  argv: z
    .tuple([absolutePath])
    .rest(argument)
    .refine((argv) => argv.length <= 128),
  cwd: absolutePath.default('/var/lib/agent-customer'),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), argument).default({}),
  stdin: z.string().max(65_536).default(''),
  timeoutSeconds: z.int().min(1).max(3600).default(300),
  maximumOutputBytes: z.int().min(1024).max(1_048_576).default(262_144),
});
export type RunRequest = z.infer<typeof runRequestSchema>;
export const runResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('exited'),
    code: z.int().min(0).max(255),
    finishedAt: z.iso.datetime(),
  }),
  z.strictObject({
    kind: z.literal('terminated'),
    reason: z.enum(['cancelled', 'timeout', 'output_limit', 'interrupted', 'start_failed']),
    finishedAt: z.iso.datetime(),
  }),
]);
export type RunResult = z.infer<typeof runResultSchema>;
export const runStateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('queued') }),
  z.strictObject({ kind: z.literal('running'), startedAt: z.iso.datetime() }),
  z.strictObject({ kind: z.literal('cancelling') }),
  ...runResultSchema.options,
]);
export const runSummarySchema = z.strictObject({
  id: runIdSchema,
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  submittedAt: z.iso.datetime(),
  state: runStateSchema,
});
export const runLogEntrySchema = z.strictObject({
  stream: z.enum(['stdout', 'stderr']),
  text: z.string().max(65_536),
});
export const runResponseSchema = z.strictObject({
  run: runSummarySchema,
  logs: z.array(runLogEntrySchema).max(64),
  nextCursor: z.int().nonnegative(),
  complete: z.boolean(),
});
export const runReplySchema = z.union([
  runResponseSchema,
  z.strictObject({ error: failureSchema }),
]);
export const runCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('submit'), id: runIdSchema, request: runRequestSchema }),
  z.strictObject({ kind: z.literal('inspect'), id: runIdSchema }),
  z.strictObject({ kind: z.literal('cancel'), id: runIdSchema }),
  z.strictObject({
    kind: z.literal('logs'),
    id: runIdSchema,
    cursor: z.int().nonnegative().default(0),
  }),
]);
export type RunCommand = z.infer<typeof runCommandSchema>;

import { z } from 'zod';
import { principalSchema } from './auth.js';

export const githubUserIdSchema = z.string().regex(/^[1-9][0-9]{0,19}$/);
export const loginConfigSchema = z.strictObject({
  provider: z.literal('github'),
  clientId: z.string().regex(/^[A-Za-z0-9.]{10,100}$/),
  invitationRequired: z.literal(true),
});
export const githubTokenSchema = z.string().regex(/^gho_[A-Za-z0-9_]{20,508}$/);
export const loginRequestSchema = z.strictObject({
  id: z.uuidv4(),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const loginResponseSchema = z.strictObject({
  principal: principalSchema,
  expiresAt: z.iso.datetime(),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

import { z } from 'zod';
import { grantIdSchema } from './ids.js';

export const apiUrlSchema = z.url().superRefine((value, ctx) => {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
  ) {
    ctx.addIssue({
      code: 'custom',
      message:
        'API URL must use HTTPS, or HTTP on loopback, without credentials, a query, or a fragment.',
    });
  }
});
export const credentialsSchema = z.object({
  server: apiUrlSchema,
  token: z.string().regex(/^acld_[A-Za-z0-9_-]{43}$/),
});
export const issuedGrantResponseSchema = z.object({
  grant: z.object({
    id: grantIdSchema,
    token: credentialsSchema.shape.token,
    expiresAt: z.iso.datetime(),
  }),
});
export const revokedResponseSchema = z.object({ revoked: z.literal(true) });

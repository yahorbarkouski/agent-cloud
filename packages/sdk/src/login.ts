import type { z } from 'zod';
import {
  CloudError,
  apiUrlSchema,
  loginConfigSchema,
  loginRequestSchema,
  loginResponseSchema,
  githubTokenSchema,
  errorResponseSchema,
  type LoginRequest,
} from '@agent-cloud/contracts';

export async function readLoginJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new CloudError('provider_unavailable', 'Sign-in response is empty.', true);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536)
        throw new CloudError('provider_unavailable', 'Sign-in response exceeds its limit.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function request<T>(input: {
  server: string;
  path: string;
  schema: z.ZodType<T>;
  token?: string;
  body?: unknown;
  transport?: typeof fetch;
}) {
  const response = await (input.transport ?? fetch)(
    `${apiUrlSchema.parse(input.server).replace(/\/$/, '')}${input.path}`,
    {
      method: input.body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: 'application/json',
        ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    },
  );
  const result = await readLoginJson(response);
  if (!response.ok) {
    const { error } = errorResponseSchema.parse(result);
    throw new CloudError(error.code, error.message, error.retryable);
  }
  return input.schema.parse(result);
}
export const loginConfiguration = (server: string, transport?: typeof fetch) =>
  request({
    server,
    path: '/auth/config',
    schema: loginConfigSchema,
    ...(transport ? { transport } : {}),
  });
export const exchangeGithubLogin = (input: {
  server: string;
  token: string;
  request: LoginRequest;
  transport?: typeof fetch;
}) =>
  request({
    server: input.server,
    path: '/auth/github',
    schema: loginResponseSchema,
    token: githubTokenSchema.parse(input.token),
    body: loginRequestSchema.parse(input.request),
    ...(input.transport ? { transport: input.transport } : {}),
  });

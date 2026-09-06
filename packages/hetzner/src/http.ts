import { z } from 'zod';
const errorSchema = z.object({ error: z.object({ code: z.string() }) });

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(`Hetzner request failed with HTTP ${status}.`);
    this.status = status;
    this.code = code;
  }
}

export function createHetznerRequest(input: { token: string; transport?: typeof fetch }) {
  const token = z
    .string()
    .regex(/^[A-Za-z0-9_-]{32,512}$/)
    .parse(input.token);
  const transport = input.transport ?? fetch;
  return async (input: {
    path: string;
    method?: 'POST' | 'DELETE';
    body?: unknown;
  }): Promise<unknown> => {
    const response = await transport(`https://api.hetzner.cloud/v1${input.path}`, {
      method: input.method ?? 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      const parsed = errorSchema.safeParse(body);
      throw new HttpError(
        response.status,
        parsed.success ? parsed.data.error.code : 'invalid_response',
      );
    }
    return body;
  };
}

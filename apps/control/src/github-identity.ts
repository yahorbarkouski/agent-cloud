import { z } from 'zod';
import { CloudError, githubTokenSchema } from '@agent-cloud/contracts';
import { readPrivateFile } from './private-file.js';

export const githubConfigSchema = z.strictObject({
  clientId: z.string().regex(/^[A-Za-z0-9.]{10,100}$/),
  clientSecret: z.string().min(20).max(512),
});
export async function readGithubConfig(path: string) {
  return githubConfigSchema.parse(JSON.parse(await readPrivateFile(path)));
}
export type GithubIdentityVerifier = (token: string) => Promise<string>;

/** Verify both the user and our OAuth app. A generic GitHub PAT is not a login credential. */
export function githubIdentityVerifier(
  config: z.infer<typeof githubConfigSchema>,
  transport: typeof fetch = fetch,
): GithubIdentityVerifier {
  return async (token) => {
    githubTokenSchema.parse(token);
    let response: Response;
    try {
      response = await transport(`https://api.github.com/applications/${config.clientId}/token`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2026-03-10',
          'User-Agent': 'agent-cloud',
        },
        body: JSON.stringify({ access_token: token }),
      });
    } catch {
      throw new CloudError(
        'provider_unavailable',
        'GitHub identity verification is unavailable.',
        true,
      );
    }
    if (response.status === 404 || response.status === 401)
      throw new CloudError(
        'unauthenticated',
        'GitHub sign-in token is invalid for this application.',
      );
    if (!response.ok)
      throw new CloudError(
        'provider_unavailable',
        'GitHub identity verification is unavailable.',
        true,
      );
    const reader = response.body?.getReader();
    if (!reader) throw new CloudError('provider_unavailable', 'GitHub returned no identity.', true);
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65_536)
          throw new CloudError('provider_unavailable', 'GitHub identity reply exceeds its limit.');
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const identity = z
      .object({
        app: z.object({ client_id: z.literal(config.clientId) }),
        user: z.object({ id: z.int().positive(), type: z.literal('User') }),
        scopes: z.array(z.string()),
      })
      .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    // This application requests public identity only. Reject tokens with unrelated data access.
    if (identity.scopes.some((scope) => scope !== 'offline_access'))
      throw new CloudError(
        'permission_denied',
        'Sign in with the application identity scope only.',
      );
    return String(identity.user.id);
  };
}

import { open, rm } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { CloudError, credentialsSchema, githubTokenSchema } from '@agent-cloud/contracts';
import {
  CloudClient,
  loginConfiguration,
  exchangeGithubLogin,
  readLoginJson,
} from '@agent-cloud/sdk';

import {
  readCredential,
  syncCredentialDirectories,
  withCredentialLock,
} from './credential-file.js';

const savedLogin = credentialsSchema.extend({ loginId: z.uuidv4() });
async function deviceToken(clientId: string) {
  async function post(path: string, body: Record<string, string>) {
    const response = await fetch(`https://github.com${path}`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
    if (!response.ok)
      throw new CloudError('provider_unavailable', 'GitHub device sign-in is unavailable.', true);
    return readLoginJson(response);
  }
  const device = z
    .object({
      device_code: z.string().min(20).max(512),
      user_code: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
      verification_uri: z.literal('https://github.com/login/device'),
      expires_in: z.int().positive().max(1800),
      interval: z.int().positive().max(30),
    })
    .parse(await post('/login/device/code', { client_id: clientId, scope: '' }));
  process.stderr.write(
    JSON.stringify({
      verificationUri: device.verification_uri,
      userCode: device.user_code,
      expiresIn: device.expires_in,
    }) + '\n',
  );
  const deadline = performance.now() + device.expires_in * 1000;
  let interval = device.interval * 1000;
  while (performance.now() < deadline) {
    await setTimeout(interval);
    const body = await post('/login/oauth/access_token', {
      client_id: clientId,
      device_code: device.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    const token = z
      .object({ access_token: githubTokenSchema, token_type: z.literal('bearer') })
      .safeParse(body);
    if (token.success) return token.data.access_token;
    const { error } = z.object({ error: z.string() }).parse(body);
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      interval += 5000;
      continue;
    }
    throw new CloudError(
      'unauthenticated',
      error === 'access_denied'
        ? 'GitHub device sign-in was denied.'
        : 'GitHub device sign-in expired or was rejected. Start it again.',
    );
  }
  throw new CloudError('unauthenticated', 'GitHub device sign-in expired. Start it again.');
}

export const loginWithDevice = (server: string, path: string) =>
  withCredentialLock(path, (lockedPath) => loginLocked(server, lockedPath));

async function loginLocked(server: string, path: string) {
  const config = await loginConfiguration(server);
  let saved: z.infer<typeof savedLogin>;
  try {
    saved = savedLogin.parse(await readCredential(path));
    if (saved.server !== server)
      throw new CloudError(
        'permission_denied',
        'Existing credential belongs to another cloud. Select another ACLD_CREDENTIALS path.',
      );
    try {
      return { ...(await new CloudClient(saved).whoami()), credentialsFile: path, recovered: true };
    } catch (error) {
      if (!(error instanceof CloudError && error.failure.code === 'unauthenticated')) throw error;
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    saved = {
      server,
      token: `acld_${randomBytes(32).toString('base64url')}`,
      loginId: randomUUID(),
    };
    const file = await open(path, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(saved) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    await syncCredentialDirectories(path);
  }
  const githubToken = await deviceToken(config.clientId);
  try {
    const result = await exchangeGithubLogin({
      server,
      token: githubToken,
      request: {
        id: saved.loginId,
        tokenHash: createHash('sha256').update(saved.token).digest('hex'),
      },
    });
    return { ...result, credentialsFile: path, recovered: false };
  } catch (error) {
    // The final cloud token was saved before issuance, so a lost reply is recoverable without
    // issuing another credential or retaining the GitHub access token on disk.
    try {
      return { ...(await new CloudClient(saved).whoami()), credentialsFile: path, recovered: true };
    } catch {
      throw error;
    }
  }
}

export const logout = (path: string) => withCredentialLock(path, logoutLocked);

async function logoutLocked(path: string) {
  const value = await readCredential(path);
  const client = new CloudClient(credentialsSchema.parse(value));
  try {
    const { principal } = await client.whoami();
    await client.revokeGrant(principal.grantId);
  } catch (error) {
    if (!(error instanceof CloudError && error.failure.code === 'unauthenticated')) throw error;
  }
  await rm(path);
  await syncCredentialDirectories(path);
  return { revoked: true, credentialsRemoved: true };
}

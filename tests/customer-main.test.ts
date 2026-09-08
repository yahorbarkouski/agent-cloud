import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { grantPolicySchema, simulatedCatalog } from '../packages/contracts/src/index.js';
import { createApp } from '../apps/control/src/app.js';
import { createCustomerLogin } from '../apps/control/src/customer-login.js';
import { generateToken, hashToken } from '../apps/control/src/auth.js';
import { testDatabase } from './database.js';

it('admits, disables and renews customer access through the packaged operator with generation and spending limits', async () => {
  const fixture = await testDatabase();
  const scratch = await mkdtemp(join(tmpdir(), 'acld-customer-operator-'));
  try {
    const generationFile = await fixture.controlIdentity();
    const environment = {
      DATABASE_URL: fixture.databaseUrl,
      PROVIDER: 'hetzner',
      PROVIDER_CURRENCY: 'USD',
      MAX_PROVIDER_HOURLY: '0.06',
      MAX_LIVE_MACHINES: '1',
      ACLD_CONTROL_GENERATION_FILE: generationFile,
    };
    // Deliberately no Hetzner, signer or storage credentials in this operator process.
    const execute = promisify(execFile);
    const operator = (args: string[], env = environment) =>
      execute(process.execPath, ['apps/control/dist/customer-main.js', ...args], {
        env,
        timeout: 10_000,
        maxBuffer: 16384,
      });
    const policy = grantPolicySchema.parse({
      capabilities: ['project:read', 'project:create'],
      projects: { kind: 'all' },
      sizes: ['small'],
      regions: ['nbg1'],
      maxMachines: 1,
      currency: 'USD',
      maxHourlyMicros: 60000,
    });
    const admission = {
      githubUserId: '10001',
      name: 'packaged-customer',
      policy,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const requestFile = join(scratch, 'admit.json');
    const save = (request: unknown) =>
      writeFile(requestFile, JSON.stringify(request), { mode: 0o600 });
    await save({ ...admission, policy: { ...policy, maxHourlyMicros: 60001 } });
    await expect(operator(['admit', requestFile])).rejects.toMatchObject({ code: 1 });
    await save(admission);
    const missingGeneration = {
      ...environment,
      ACLD_CONTROL_GENERATION_FILE: join(scratch, 'missing-generation'),
    };
    await expect(operator(['admit', requestFile], missingGeneration)).rejects.toMatchObject({
      code: 1,
    });
    const admitted = z
      .object({ accountId: z.string(), anchorGrantId: z.string() })
      .parse(JSON.parse((await operator(['admit', requestFile])).stdout));
    await expect(operator(['admit', requestFile])).rejects.toMatchObject({ code: 1 });
    const inspected = z
      .object({ revokedAt: z.null(), accountId: z.string() })
      .parse(JSON.parse((await operator(['inspect', '10001'])).stdout));
    expect(inspected.accountId).toBe(admitted.accountId);
    const login = createCustomerLogin({
      db: fixture.connection.db,
      clientId: 'fixtureClientId1234',
      verify: () => Promise.resolve('10001'),
    });
    const app = createApp({
      db: fixture.connection.db,
      provider: 'simulated',
      catalog: simulatedCatalog,
      limits: { maxMachines: 1, maxHourlyMicros: 60000, currency: 'USD' },
      login,
    });
    async function signIn() {
      const token = generateToken();
      const response = await app.request('/auth/github', {
        method: 'POST',
        headers: {
          Authorization: `Bearer gho_${'x'.repeat(36)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: randomUUID(), tokenHash: hashToken(token) }),
      });
      return { token, response };
    }
    const first = await signIn();
    expect(first.response.status).toBe(200);
    const whoami = (token: string) =>
      app.request('/v1/whoami', { headers: { Authorization: `Bearer ${token}` } });
    expect((await whoami(first.token)).status).toBe(200);
    await operator(['disable', '10001']);
    expect((await whoami(first.token)).status).toBe(401);
    expect((await signIn()).response.status).toBe(401);
    await save({
      githubUserId: admission.githubUserId,
      policy,
      expiresAt: admission.expiresAt,
      expectedAnchorGrantId: admitted.anchorGrantId,
    });
    await operator(['renew', requestFile]);
    const renewed = await signIn();
    expect(renewed.response.status).toBe(200);
    expect((await whoami(first.token)).status).toBe(401);
    expect((await whoami(renewed.token)).status).toBe(200);
    await writeFile(requestFile, '{"private-fixture-canary":broken', { mode: 0o600 });
    try {
      await operator(['admit', requestFile]);
      throw new Error('Expected refusal.');
    } catch (error) {
      const failed = z
        .object({ code: z.literal(1), stdout: z.string(), stderr: z.string() })
        .parse(error);
      expect(failed.stdout + failed.stderr).not.toContain('private-fixture-canary');
    }
  } finally {
    await fixture.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

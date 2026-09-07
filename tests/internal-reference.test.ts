import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { grants, guestIdentities } from '../packages/db/src/index.js';
import { guestImageSchema, newId } from '../packages/contracts/dist/index.js';
import { createInternalReference } from '../apps/control/src/internal-reference.js';
import { createApp } from '../apps/control/src/app.js';
import { advanceOperation } from '../apps/control/src/advance-operation.js';
import { issueGrant } from '../apps/control/src/auth.js';
import { prepareEnrollmentFixture } from '../scripts/support/enrollment-fixture.js';
import type { runReferenceCommand } from '../packages/remote/dist/index.js';
import type { Signer } from '../packages/pki/dist/index.js';
import { seedAccount, testDatabase } from './database.js';

let database: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  database = await testDatabase();
});
beforeEach(async () => {
  await database.reset();
});
afterAll(async () => {
  await database.close();
});
async function scenario() {
  const image = guestImageSchema.parse({
    providerImage: 'fixture',
    architecture: 'x86',
    version: 'reference',
    manifestDigest: 'a'.repeat(64),
    sshUserCa: 'ssh-ed25519 AAAA',
    sshHostCa: 'ssh-ed25519 BBBB',
    tlsRoot: 'fixture',
  });
  const fixture = await prepareEnrollmentFixture({
    connection: database.connection,
    image,
    address: '192.0.2.10',
    enrollmentUrl: 'https://example.test/guest/enroll',
  });
  const identity = {
    sshHostPublicKey: 'ssh-ed25519 CCCC',
    tlsCsr: 'fixture',
    imageVersion: image.version,
  };
  await database.connection.db.insert(guestIdentities).values({
    accountId: fixture.allocation.accountId,
    allocationId: fixture.allocation.id,
    identity: { kind: 'claimed', ...identity },
  });
  await database.connection.db
    .update(guestIdentities)
    .set({
      identity: {
        kind: 'issued',
        ...identity,
        sshHostCertificate: 'fixture',
        tlsCertificate: 'fixture',
        issuedAt: new Date().toISOString(),
      },
    })
    .where(eq(guestIdentities.allocationId, fixture.allocation.id));
  await advanceOperation({
    connection: database.connection,
    operationId: fixture.operation.id,
    provider: fixture.provider,
    limits: fixture.limits,
    guest: {
      kind: 'enabled',
      resolveImage: () => Promise.resolve(image),
      prepareBootstrap: () => Promise.reject(new Error('Already prepared')),
      runtime: {
        check: async () => {
          if (!fixture.allocation.serverId) throw new Error('Missing fixture VM');
          const server = await fixture.provider.getServer({
            serverId: fixture.allocation.serverId,
          });
          if (!server) throw new Error('Missing fixture VM');
          return {
            kind: 'ready',
            server,
            verification: {
              kind: 'ssh',
              verifiedAt: new Date().toISOString(),
              imageVersion: image.version,
              manifestDigest: image.manifestDigest,
              bootId: randomUUID(),
            },
          };
        },
      },
    },
  });
  const remote = vi
    .fn<typeof runReferenceCommand>()
    .mockResolvedValue({ state: { kind: 'absent' }, output: '' });
  const issue = vi.fn<Signer['issueDeploymentCredential']>().mockImplementation((subject) =>
    Promise.resolve({
      kind: 'deployment',
      subject,
      privateKey: 'fixture',
      certificate: 'fixture',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    }),
  );
  const create = (grantId = fixture.account.principal.grantId) =>
    createInternalReference({
      connection: database.connection,
      provider: fixture.provider,
      grantId,
      signer: () => Promise.resolve({ issueDeploymentCredential: issue }),
      remote,
    });
  const app = (enabled = true) =>
    createApp({
      db: database.connection.db,
      provider: fixture.provider.kind,
      limits: fixture.limits,
      catalog: fixture.catalog,
      ...(enabled ? { internalReference: create() } : {}),
    });
  const path = `/internal/v1/machines/${fixture.operation.machineId}/reference`;
  const request = (token: string, body: unknown = { kind: 'inspect' }) => ({
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ...fixture, remote, issue, create, app, path, request };
}

it('is absent by default, authenticates requests, and restricts access to the configured root identity', async () => {
  const f = await scenario();
  expect((await f.app(false).request(f.path, f.request(f.account.token))).status).toBe(404);
  expect((await f.app().request(f.path, { method: 'POST' })).status).toBe(401);
  const other = await seedAccount(database.connection.db);
  expect((await f.app().request(f.path, f.request(other.token))).status).toBe(403);
  const delegated = await issueGrant(database.connection.db, {
    principal: f.account.principal,
    name: 'delegate',
    policy: f.account.principal.policy,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  expect((await f.app().request(f.path, f.request(delegated.token))).status).toBe(403);
  // Even misconfiguring the allowlist to a delegated grant cannot turn it into an operator.
  await expect(
    f.create(delegated.id)(
      { ...f.account.principal, grantId: delegated.id },
      f.operation.machineId,
      { kind: 'inspect' },
    ),
  ).rejects.toMatchObject({ failure: { code: 'permission_denied' } });
  expect(f.issue).not.toHaveBeenCalled();
  expect(f.remote).not.toHaveBeenCalled();
});

it('targets current owned resources and does not accept a caller-selected hostname', async () => {
  const f = await scenario();
  const command = {
    kind: 'apply',
    releaseId: randomUUID(),
    expectedReleaseId: null,
    revision: '1',
  };
  expect(
    (
      await f
        .app()
        .request(f.path, f.request(f.account.token, { ...command, hostname: 'victim.example.com' }))
    ).status,
  ).toBe(400);
  expect((await f.app().request(f.path, f.request(f.account.token, command))).status).toBe(200);
  const sent = f.remote.mock.calls[0]?.[0];
  expect(sent?.address).toBe('192.0.2.10');
  expect(sent?.command).toMatchObject({
    hostname: `acld-${f.operation.machineId.slice(-12)}.192-0-2-10.sslip.io`,
  });
  await expect(
    f.create()(f.account.principal, newId.machine(), { kind: 'inspect' }),
  ).rejects.toMatchObject({ failure: { code: 'not_found' } });
  await database.connection.db
    .update(grants)
    .set({ revokedAt: new Date() })
    .where(eq(grants.id, f.account.principal.grantId));
  await expect(
    f.create()(f.account.principal, f.operation.machineId, { kind: 'inspect' }),
  ).rejects.toMatchObject({ failure: { code: 'unauthenticated' } });
  expect(f.issue).toHaveBeenCalledOnce();
});

it('rejects changed provider ownership before signing', async () => {
  const f = await scenario();
  const original = f.provider.getServer.bind(f.provider);
  f.provider.getServer = async (input) => {
    const server = await original(input);
    return server && { ...server, labels: { ...server.labels, account_id: newId.account() } };
  };
  await expect(
    f.create()(f.account.principal, f.operation.machineId, { kind: 'inspect' }),
  ).rejects.toMatchObject({ failure: { code: 'provider_unavailable' } });
  expect(f.issue).not.toHaveBeenCalled();
  expect(f.remote).not.toHaveBeenCalled();
});

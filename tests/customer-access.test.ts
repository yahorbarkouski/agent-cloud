import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  failureSchema,
  accessSessionResponseSchema,
  guestImageSchema,
  type Principal,
} from '../packages/contracts/src/index.js';
import {
  accessSessionRecord,
  accessSessions,
  guestIdentities,
  grants,
} from '../packages/db/src/index.js';
import { createAccessService } from '../apps/control/src/access-sessions.js';
import { createApp } from '../apps/control/src/app.js';
import { advanceOperation } from '../apps/control/src/advance-operation.js';
import { issueGrant, hashToken } from '../apps/control/src/auth.js';
import { prepareEnrollmentFixture } from '../scripts/support/enrollment-fixture.js';
import { accessPublicKey } from './access-fixture.js';
import { seedAccount, testDatabase } from './database.js';
import type { CustomerSshSigner } from '../packages/pki/src/index.js';

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
const makeRequest = () => {
  const ticket = `aclt_${randomBytes(32).toString('base64url')}`;
  return {
    ticket,
    key: randomUUID(),
    request: { publicKey: accessPublicKey(), ticketHash: hashToken(ticket) },
  };
};
async function fixture() {
  const image = guestImageSchema.parse({
    providerImage: 'fixture',
    architecture: 'x86',
    version: 'access',
    manifestDigest: 'b'.repeat(64),
    sshUserCa: accessPublicKey(),
    sshHostCa: accessPublicKey(),
    tlsRoot: 'fixture',
    customerSsh: 1,
  });
  const f = await prepareEnrollmentFixture({
    connection: database.connection,
    image,
    address: '192.0.2.10',
    enrollmentUrl: 'https://example.test/guest/enroll',
  });
  const identity = {
    sshHostPublicKey: accessPublicKey(),
    tlsCsr: 'fixture',
    imageVersion: image.version,
  };
  await database.connection.db.insert(guestIdentities).values({
    accountId: f.allocation.accountId,
    allocationId: f.allocation.id,
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
    .where(eq(guestIdentities.allocationId, f.allocation.id));
  await advanceOperation({
    connection: database.connection,
    operationId: f.operation.id,
    provider: f.provider,
    limits: f.limits,
    guest: {
      kind: 'enabled',
      resolveImage: () => Promise.resolve(image),
      prepareBootstrap: () => Promise.reject(new Error('Already prepared')),
      runtime: {
        check: async () => {
          if (!f.allocation.serverId) throw new Error('Missing VM');
          const server = await f.provider.getServer({ serverId: f.allocation.serverId });
          if (!server) throw new Error('Missing VM');
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
  const sign = vi.fn<CustomerSshSigner['sign']>().mockImplementation((input) =>
    Promise.resolve({
      kind: 'issued',
      certificate: 'Local service protocol fixture, not a cryptographic certificate.',
      expiresAt: new Date(
        Math.min(
          input.authority.checkedAt.getTime() + 60_000,
          input.authority.expiresAt.getTime(),
          Date.parse(input.session.hardDeadline),
        ),
      ).toISOString(),
    }),
  );
  const gatewayToken = `aclg_${randomBytes(32).toString('base64url')}`;
  const service = createAccessService({
    connection: database.connection,
    provider: f.provider,
    config: {
      tokenHash: hashToken(gatewayToken),
      gateway: { id: 'test', origin: 'ws://127.0.0.1:4322', egressCidrs: ['127.0.0.1/32'] },
    },
    signer: () => Promise.resolve({ userCa: image.sshUserCa, sign }),
    checkNetwork: async () => {},
  });
  const app = createApp({
    db: database.connection.db,
    provider: f.provider.kind,
    catalog: f.catalog,
    limits: f.limits,
    access: service,
  });
  const request = (path: string, token = f.account.token, body?: unknown, method?: string) =>
    app.request(path, {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const admit = (r = makeRequest(), principal: Principal = f.account.principal) =>
    service.admit(principal, f.operation.machineId, r.request, r.key);
  const read = async (id: string) => {
    const [row] = await database.connection.db
      .select()
      .from(accessSessions)
      .where(eq(accessSessions.id, id));
    if (!row) throw new Error('Missing session');
    return accessSessionRecord(row);
  };
  return { ...f, image, service, sign, gatewayToken, app, request, admit, read };
}

it('admits idempotently through the API, issues once, and consumes a ticket once', async () => {
  const f = await fixture();
  const r = makeRequest();
  const response = await f.app.request(`/v1/machines/${f.operation.machineId}/access-sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${f.account.token}`,
      'Idempotency-Key': r.key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(r.request),
  });
  expect(response.status).toBe(202);
  const first = accessSessionResponseSchema.parse(await response.json());
  expect(first).toEqual(await f.admit(r));
  expect(JSON.stringify(first)).not.toContain(r.ticket);
  expect(JSON.stringify(first)).not.toContain(r.request.ticketHash);
  await expect(f.admit({ ...r, request: makeRequest().request })).rejects.toMatchObject({
    failure: { code: 'idempotency_conflict' },
  });
  await Promise.all([f.service.issue(first.session.id), f.service.issue(first.session.id)]);
  expect(f.sign).toHaveBeenCalledTimes(1);
  expect((await f.read(first.session.id)).issuance.kind).toBe('issued');
  const claim = { ticket: r.ticket, gatewayInstanceId: randomUUID(), connectionId: randomUUID() };
  const lease = await f.service.claim(claim);
  expect(lease.target.address).toBe('192.0.2.10');
  expect(lease.target.port).toBe(22);
  await expect(f.service.claim({ ...claim, connectionId: randomUUID() })).rejects.toMatchObject({
    failure: { code: 'unauthenticated' },
  });
  const connection = {
    sessionId: first.session.id,
    gatewayInstanceId: claim.gatewayInstanceId,
    connectionId: claim.connectionId,
  };
  expect((await f.service.check([connection])).leases).toHaveLength(1);
  expect(
    (await f.service.check([{ ...connection, connectionId: randomUUID() }])).leases,
  ).toHaveLength(0);
  await f.service.close({ ...connection, reason: 'client_closed' });
  expect((await f.service.check([connection])).leases).toHaveLength(0);
  expect((await f.read(first.session.id)).connection.kind).toBe('closed');
});

it('enforces account/project/capability boundaries and separates gateway authority from customer tokens', async () => {
  const f = await fixture();
  const other = await seedAccount(database.connection.db);
  await expect(f.admit(makeRequest(), other.principal)).rejects.toMatchObject({
    failure: { code: 'not_found' },
  });
  const child = await issueGrant(database.connection.db, {
    principal: f.account.principal,
    name: 'reader',
    policy: { ...f.account.principal.policy, capabilities: ['machine:read'] },
    expiresAt: new Date(Date.now() + 60_000),
  });
  const response = await f.request(
    `/v1/machines/${f.operation.machineId}/access-sessions`,
    child.token,
    makeRequest().request,
  );
  expect(response.status).toBe(403);
  const { session } = await f.admit();
  expect((await f.request(`/v1/access-sessions/${session.id}`, other.token)).status).toBe(404);
  expect((await f.request(`/v1/access-sessions/${session.id}`, child.token)).status).toBe(404);
  expect((await f.request('/gateway/v1/check', f.account.token, { connections: [] })).status).toBe(
    401,
  );
  expect((await f.request('/v1/whoami', f.gatewayToken)).status).toBe(401);
  const disabled = createApp({
    db: database.connection.db,
    provider: f.provider.kind,
    catalog: f.catalog,
    limits: f.limits,
    customerAccess: 'disabled',
    access: f.service,
  });
  expect((await disabled.request('/gateway/v1/claim', { method: 'POST' })).status).toBe(404);
});

it('closes descendant access on revocation and refuses publication after revocation during signing', async () => {
  const f = await fixture();
  const child = await issueGrant(database.connection.db, {
    principal: f.account.principal,
    name: 'operator',
    policy: f.account.principal.policy,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const principal = { ...f.account.principal, grantId: child.id };
  const r = makeRequest();
  const { session } = await f.admit(r, principal);
  f.sign.mockImplementationOnce(async (input) => {
    expect(
      (await f.request(`/v1/grants/${child.id}`, f.account.token, undefined, 'DELETE')).status,
    ).toBe(200);
    return {
      kind: 'issued',
      certificate: 'must-not-be-published',
      expiresAt: new Date(input.authority.checkedAt.getTime() + 30_000).toISOString(),
    };
  });
  await f.service.issue(session.id);
  const stored = await f.read(session.id);
  expect(stored.issuance.kind).toBe('unavailable');
  expect(stored.connection.kind).toBe('closed');
  expect(JSON.stringify(stored)).not.toContain('must-not-be-published');
  expect((await f.request(`/v1/access-sessions/${session.id}`, child.token)).status).toBe(401);
  expect((await f.request(`/v1/access-sessions/${session.id}`)).status).toBe(200);
  await f.service.issue(session.id);
  expect(f.sign).toHaveBeenCalledTimes(1);
});

it('never retries a recorded signing attempt after a lost result and retains admission limits', async () => {
  const f = await fixture();
  const { session } = await f.admit();
  f.sign.mockRejectedValueOnce(new Error('Process lost after submission.'));
  await expect(f.service.issue(session.id)).rejects.toThrow('Process lost');
  expect((await f.read(session.id)).issuance.kind).toBe('attempted');
  await f.service.issue(session.id);
  expect((await f.read(session.id)).issuance).toEqual({
    kind: 'unavailable',
    reason: 'signing_unknown',
  });
  expect(f.sign).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 3; i++) await f.admit();
  await expect(f.admit()).rejects.toMatchObject({ failure: { code: 'quota_exceeded' } });
});

it('lets an exec-only issuing grant retrieve its own session without granting ancestor inspection', async () => {
  const f = await fixture();
  const child = await issueGrant(database.connection.db, {
    principal: f.account.principal,
    name: 'exec-only',
    policy: { ...f.account.principal.policy, capabilities: ['machine:exec'] },
    expiresAt: new Date(Date.now() + 60_000),
  });
  const response = await f.request(
    `/v1/machines/${f.operation.machineId}/access-sessions`,
    child.token,
    makeRequest().request,
  );
  expect(response.status).toBe(202);
  const { session } = accessSessionResponseSchema.parse(await response.json());
  expect((await f.request(`/v1/access-sessions/${session.id}`, child.token)).status).toBe(200);
  const ownerSession = await f.admit();
  expect(
    (await f.request(`/v1/access-sessions/${ownerSession.session.id}`, child.token)).status,
  ).toBe(403);
});

it('permits sequential recovery commands, serializes the final rate slot and bounds the whole account', async () => {
  const f = await fixture();
  async function complete(principal = f.account.principal, request = makeRequest()) {
    const { session } = await f.admit(request, principal);
    await f.service.issue(session.id);
    const claim = {
      ticket: request.ticket,
      gatewayInstanceId: randomUUID(),
      connectionId: randomUUID(),
    };
    await f.service.claim(claim);
    await f.service.close({
      sessionId: session.id,
      gatewayInstanceId: claim.gatewayInstanceId,
      connectionId: claim.connectionId,
      reason: 'client_closed',
    });
    return session;
  }
  const original = makeRequest();
  const first = await complete(f.account.principal, original);
  for (let index = 1; index < 29; index++) await complete();
  const attempts = await Promise.allSettled([complete(), complete()]);
  expect(attempts.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
  const rejected = attempts.find((value) => value.status === 'rejected');
  const error: unknown = rejected?.reason;
  const refusal = z.object({ failure: failureSchema }).parse(error);
  expect(['resource_busy', 'quota_exceeded']).toContain(refusal.failure.code);
  expect(refusal.failure.retryable).toBe(true);
  // Same-machine competitors can be refused by the nonblocking machine lock first.
  // Once the winning command closes, the remaining refusal must be the rolling rate.
  await expect(complete()).rejects.toMatchObject({
    failure: { code: 'quota_exceeded', retryable: true },
  });
  expect((await f.admit(original)).session.id).toBe(first.id);
  const child = await issueGrant(database.connection.db, {
    principal: f.account.principal,
    name: 'second-operator',
    policy: f.account.principal.policy,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const principal = { ...f.account.principal, grantId: child.id };
  for (let index = 0; index < 30; index++) await complete(principal);
  const third = await issueGrant(database.connection.db, {
    principal: f.account.principal,
    name: 'third-operator',
    policy: f.account.principal.policy,
    expiresAt: new Date(Date.now() + 60_000),
  });
  await expect(f.admit(makeRequest(), { ...principal, grantId: third.id })).rejects.toMatchObject({
    failure: { code: 'quota_exceeded', retryable: true },
  });
});

it('denies pending and connected access when authority expires or the owned provider address changes', async () => {
  const f = await fixture();
  const r = makeRequest();
  const { session } = await f.admit(r);
  await f.service.issue(session.id);
  const observe = f.provider.getPrimaryIp.bind(f.provider);
  f.provider.getPrimaryIp = async (request) => {
    const ip = await observe(request);
    return ip && { ...ip, ipv4: '192.0.2.11' };
  };
  await expect(
    f.service.claim({
      ticket: r.ticket,
      gatewayInstanceId: randomUUID(),
      connectionId: randomUUID(),
    }),
  ).rejects.toMatchObject({ failure: { code: 'provider_unavailable' } });
  f.provider.getPrimaryIp = observe;
  const claim = { ticket: r.ticket, gatewayInstanceId: randomUUID(), connectionId: randomUUID() };
  await f.service.claim(claim);
  await database.connection.db
    .update(grants)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(grants.id, f.account.principal.grantId));
  expect(
    (
      await f.service.check([
        {
          sessionId: session.id,
          gatewayInstanceId: claim.gatewayInstanceId,
          connectionId: claim.connectionId,
        },
      ])
    ).leases,
  ).toEqual([]);
});

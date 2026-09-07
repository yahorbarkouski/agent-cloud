import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  accessGatewaySchema,
  newId,
  type AccessSessionRecord,
} from '../packages/contracts/src/index.js';
import {
  accessSessions,
  accessSessionRecord,
  allocations,
  accessSigningAttempts,
  databaseTime,
  machines,
} from '../packages/db/src/index.js';
import { testDatabase, seedAccount, waitUntilDatabaseTime } from './database.js';
import {
  pendingAccessSession,
  issuedAccessSession,
  accessP256PublicKey,
} from './access-fixture.js';

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let session: ReturnType<typeof pendingAccessSession>;
beforeAll(async () => {
  fixture = await testDatabase();
});
afterAll(async () => {
  await fixture.close();
});
beforeEach(async () => {
  await fixture.reset();
  const account = await seedAccount(fixture.connection.db);
  const now = await databaseTime(fixture.connection.db);
  session = {
    ...pendingAccessSession(),
    accountId: account.principal.accountId,
    projectId: account.projectId,
    grantId: account.principal.grantId,
    admittedAt: new Date(now.getTime() - 30_000).toISOString(),
    issueDeadline: new Date(now.getTime() + 60_000).toISOString(),
    hardDeadline: new Date(now.getTime() + 3_570_000).toISOString(),
  };
  await fixture.connection.db.insert(machines).values({
    id: session.machineId,
    accountId: session.accountId,
    projectId: session.projectId,
    name: 'access-fixture',
    spec: { name: 'access-fixture', size: 'small', region: 'nbg1' },
    provider: 'simulated',
    state: { kind: 'pending' },
    version: session.machineVersion,
  });
  await fixture.connection.db.insert(allocations).values({
    id: session.allocationId,
    accountId: session.accountId,
    machineId: session.machineId,
    provider: 'simulated',
    serverId: session.identityPin.serverId,
    networkProfile: 'legacy',
    currency: 'EUR',
    hourlyMicros: 0,
  });
});

function insert(
  record: AccessSessionRecord = session,
  overrides: Partial<typeof accessSessions.$inferInsert> = {},
) {
  return fixture.connection.db.insert(accessSessions).values({
    ...record,
    admittedAt: new Date(record.admittedAt),
    issueDeadline: new Date(record.issueDeadline),
    hardDeadline: new Date(record.hardDeadline),
    ...overrides,
  });
}
function change(values: Partial<typeof accessSessions.$inferInsert>) {
  return fixture.connection.db
    .update(accessSessions)
    .set(values)
    .where(eq(accessSessions.id, session.id));
}
async function read() {
  const [row] = await fixture.connection.db
    .select()
    .from(accessSessions)
    .where(eq(accessSessions.id, session.id));
  if (!row) throw new Error('Expected the persisted test session.');
  return accessSessionRecord(row);
}
async function attempt() {
  await change({
    issuance: {
      kind: 'attempted',
      attemptedAt: new Date(Date.parse(session.admittedAt) + 10_000).toISOString(),
    },
  });
}
async function issue() {
  await attempt();
  const issuance = issuedAccessSession(session).issuance;
  await change({ issuance });
  return issuance;
}

it('requires immutable pending admission, scoped ownership and unique request/ticket identities', async () => {
  await expect(insert(issuedAccessSession(session))).rejects.toThrow();
  await insert();
  expect(await read()).toEqual(session);
  await expect(
    insert({ ...session, id: newId.accessSession(), requestKey: randomUUID() }),
  ).rejects.toThrow();
  await expect(
    insert({ ...session, id: newId.accessSession(), ticketHash: 'd'.repeat(64) }),
  ).rejects.toThrow();
  await expect(change({ ticketHash: 'e'.repeat(64) })).rejects.toThrow();
  await expect(
    change({ issueDeadline: new Date(Date.parse(session.issueDeadline) + 1) }),
  ).rejects.toThrow();
  await expect(
    change({ identityPin: { ...session.identityPin, serverId: 'changed' } }),
  ).rejects.toThrow();
  const other = await seedAccount(fixture.connection.db);
  await expect(
    insert({
      ...session,
      id: newId.accessSession(),
      requestKey: randomUUID(),
      ticketHash: 'f'.repeat(64),
      grantId: other.principal.grantId,
    }),
  ).rejects.toThrow();
  await expect(
    fixture.connection.db.delete(accessSessions).where(eq(accessSessions.id, session.id)),
  ).rejects.toThrow();
});

it('permits one signing attempt and retains its immutable receipt after an unknown result', async () => {
  await insert();
  await expect(change({ issuance: issuedAccessSession(session).issuance })).rejects.toThrow();
  await expect(
    change({ issuance: { kind: 'unavailable', reason: 'signing_unknown' } }),
  ).rejects.toThrow();
  await attempt();
  await change({ issuance: { kind: 'unavailable', reason: 'signing_unknown' } });
  await expect(attempt()).rejects.toThrow();
  await expect(change({ issuance: issuedAccessSession(session).issuance })).rejects.toThrow();
  const receipts = await fixture.connection.db
    .select()
    .from(accessSigningAttempts)
    .where(eq(accessSigningAttempts.sessionId, session.id));
  expect(receipts).toEqual([
    { sessionId: session.id, attemptedAt: new Date(Date.parse(session.admittedAt) + 10_000) },
  ]);
  await expect(
    fixture.connection.db.insert(accessSigningAttempts).values(receipts),
  ).rejects.toThrow();
  await expect(
    fixture.connection.db
      .update(accessSigningAttempts)
      .set({ attemptedAt: new Date() })
      .where(eq(accessSigningAttempts.sessionId, session.id)),
  ).rejects.toThrow();
  await expect(
    fixture.connection.db
      .delete(accessSigningAttempts)
      .where(eq(accessSigningAttempts.sessionId, session.id)),
  ).rejects.toThrow();
  expect((await read()).issuance).toEqual({ kind: 'unavailable', reason: 'signing_unknown' });
});

it('refuses a changed target, an extended certificate and overwritten issued credentials', async () => {
  await insert();
  await attempt();
  const issuance = issuedAccessSession(session).issuance;
  await expect(
    change({ issuance: { ...issuance, target: { ...issuance.target, address: 'other.example' } } }),
  ).rejects.toThrow();
  await expect(
    change({
      issuance: { ...issuance, target: { ...issuance.target, guestHostPublicKey: 'different' } },
    }),
  ).rejects.toThrow();
  await expect(
    change({
      issuance: {
        ...issuance,
        certificateExpiresAt: new Date(Date.parse(issuance.issuedAt) + 300_001).toISOString(),
      },
    }),
  ).rejects.toThrow();
  await change({ issuance });
  await expect(change({ issuance: { ...issuance, certificate: 'replacement' } })).rejects.toThrow();
});

it('admits exactly one simultaneous ticket claim and never reopens it after closure', async () => {
  await insert();
  await issue();
  const claimedAt = (await databaseTime(fixture.connection.db)).toISOString();
  const claims = [0, 1].map(() => ({
    kind: 'claimed',
    gatewayInstanceId: randomUUID(),
    connectionId: randomUUID(),
    claimedAt,
  }));
  const results = await Promise.allSettled(claims.map((connection) => change({ connection })));
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  const claimed = (await read()).connection;
  expect(claimed.kind).toBe('claimed');
  await change({
    connection: {
      kind: 'closed',
      closedAt: (await databaseTime(fixture.connection.db)).toISOString(),
      reason: 'client_closed',
      previous: claimed,
    },
  });
  await expect(change({ connection: { kind: 'unclaimed' } })).rejects.toThrow();
  await expect(change({ connection: claimed })).rejects.toThrow();
  const closed = (await read()).connection;
  expect(closed).toMatchObject({ kind: 'closed', previous: claimed });
  await expect(
    change({ connection: { ...closed, previous: { kind: 'unclaimed' } } }),
  ).rejects.toThrow();
});

it('closes a pending session without granting signing or claim authority', async () => {
  await insert();
  await change({
    connection: {
      kind: 'closed',
      closedAt: (await databaseTime(fixture.connection.db)).toISOString(),
      reason: 'authorization_changed',
      previous: session.connection,
    },
  });
  await expect(attempt()).rejects.toThrow();
  await change({ issuance: { kind: 'unavailable', reason: 'authorization_changed' } });
  expect((await read()).issuance).toEqual({ kind: 'unavailable', reason: 'authorization_changed' });
});

it('rejects a fresh claim after the original ticket deadline', async () => {
  await insert();
  await attempt();
  const ticketDeadline = new Date(
    (await databaseTime(fixture.connection.db)).getTime() + 150,
  ).toISOString();
  await change({ issuance: { ...issuedAccessSession(session).issuance, ticketDeadline } });
  await waitUntilDatabaseTime(fixture.connection, ticketDeadline);
  await expect(
    change({
      connection: {
        kind: 'claimed',
        gatewayInstanceId: randomUUID(),
        connectionId: randomUUID(),
        claimedAt: (await databaseTime(fixture.connection.db)).toISOString(),
      },
    }),
  ).rejects.toThrow();
  expect((await read()).connection).toEqual({ kind: 'unclaimed' });
});

it('rejects malformed immutable admission fields through SQL before reserving an identity', async () => {
  const pin = session.identityPin;
  const gateway = session.gateway;
  const malformed: Partial<typeof accessSessions.$inferInsert>[] = [
    { identityPin: {} },
    { identityPin: [] },
    { identityPin: null },
    { identityPin: { ...pin, extra: 'field' } },
    ...Object.keys(pin).flatMap((key) => [
      { identityPin: { ...pin, [key]: null } },
      { identityPin: { ...pin, [key]: [] } },
      { identityPin: Object.fromEntries(Object.entries(pin).filter(([name]) => name !== key)) },
    ]),
    { identityPin: { ...pin, provider: 'other' } },
    { identityPin: { ...pin, serverId: '' } },
    { identityPin: { ...pin, primaryIpId: 'x'.repeat(129) } },
    { identityPin: { ...pin, sshHostCa: 'ssh-ed25519 invalid' } },
    { identityPin: { ...pin, guestHostPublicKey: `${pin.guestHostPublicKey} comment` } },
    { publicKey: `${session.publicKey} comment` },
    { publicKey: 'ssh-ed25519 ' + 'a'.repeat(68) },
    { requestKey: 'short' },
    { requestKey: 'valid-request-key\n' },
    { ticketHash: 'a'.repeat(64) + '\n' },
    { gateway: { ...gateway, id: 'local\n' } },
    { gateway: {} },
    { gateway: [] },
    { gateway: null },
    { gateway: { ...gateway, extra: true } },
    ...Object.keys(gateway).flatMap((key) => [
      { gateway: { ...gateway, [key]: null } },
      { gateway: Object.fromEntries(Object.entries(gateway).filter(([name]) => name !== key)) },
    ]),
    ...[
      '',
      'ws://remote.example',
      'wss://secret@gateway.example',
      'wss://gateway.example/path',
      'wss://gateway.example?ticket=secret',
      'wss://bad..example',
      'wss://1.2.3',
      'wss://gateway.example:65536',
      'wss://[invalid]',
      'wss://gateway.example/',
    ].map((origin) => ({ gateway: { ...gateway, origin } })),
    ...[
      [],
      [null],
      ['0.0.0.0/0'],
      ['::/0'],
      ['127.0.0.1/32', '127.0.0.1/32'],
      ['127.1/32'],
      ['127.0.0.1/33'],
      ['::1/129'],
      ['localhost/32'],
    ].map((egressCidrs) => ({ gateway: { ...gateway, egressCidrs } })),
  ];
  for (const overrides of malformed) await expect(insert(session, overrides)).rejects.toThrow();
  await insert();
  expect(await read()).toEqual(session);
});

it('rolls back the signing transition and receipt in the same transaction', async () => {
  await insert();
  await expect(
    fixture.connection.db.transaction(async (tx) => {
      await tx
        .update(accessSessions)
        .set({
          issuance: {
            kind: 'attempted',
            attemptedAt: (await databaseTime(tx)).toISOString(),
          },
        })
        .where(eq(accessSessions.id, session.id));
      const receipt = await tx.select().from(accessSigningAttempts);
      expect(receipt).toHaveLength(1);
      throw new Error('Intentional caller rollback');
    }),
  ).rejects.toThrow('Intentional caller rollback');
  expect((await read()).issuance).toEqual({ kind: 'pending' });
  expect(await fixture.connection.db.select().from(accessSigningAttempts)).toHaveLength(0);
  await attempt();
  expect(await fixture.connection.db.select().from(accessSigningAttempts)).toHaveLength(1);
});

it('admits exactly one competing signing attempt and one distinct terminal result', async () => {
  await insert();
  const attempts = [10_000, 11_000].map((offset) => ({
    kind: 'attempted',
    attemptedAt: new Date(Date.parse(session.admittedAt) + offset).toISOString(),
  }));
  const attempted = await Promise.allSettled(attempts.map((issuance) => change({ issuance })));
  expect(attempted.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(attempted.filter((result) => result.status === 'rejected')).toHaveLength(1);
  const receipt = await fixture.connection.db.select().from(accessSigningAttempts);
  expect(receipt).toHaveLength(1);
  const state = (await read()).issuance;
  if (state.kind !== 'attempted') throw new Error('Expected the winning attempt.');
  expect(receipt[0]?.attemptedAt.toISOString()).toBe(state.attemptedAt);
  const outcomes = ['signing_unknown', 'signing_failed'].map((reason) => ({
    kind: 'unavailable',
    reason,
  }));
  const finished = await Promise.allSettled(outcomes.map((issuance) => change({ issuance })));
  expect(finished.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(finished.filter((result) => result.status === 'rejected')).toHaveLength(1);
  expect(outcomes).toContainEqual((await read()).issuance);
  expect(await fixture.connection.db.select().from(accessSigningAttempts)).toEqual(receipt);
});

it('retains gateway connection uniqueness after closure and scopes it to a gateway', async () => {
  await insert();
  await issue();
  const claim = {
    kind: 'claimed',
    gatewayInstanceId: randomUUID(),
    connectionId: randomUUID(),
    claimedAt: (await databaseTime(fixture.connection.db)).toISOString(),
  };
  await change({ connection: claim });
  await change({
    connection: {
      kind: 'closed',
      reason: 'client_closed',
      previous: claim,
      closedAt: (await databaseTime(fixture.connection.db)).toISOString(),
    },
  });
  session = {
    ...session,
    id: newId.accessSession(),
    requestKey: randomUUID(),
    ticketHash: 'd'.repeat(64),
  };
  await insert();
  await issue();
  await expect(change({ connection: claim })).rejects.toThrow();
  await expect(
    change({ connection: { ...claim, connectionId: claim.connectionId.toUpperCase() } }),
  ).rejects.toThrow();
  expect((await read()).connection.kind).toBe('unclaimed');
  session = {
    ...session,
    id: newId.accessSession(),
    requestKey: randomUUID(),
    ticketHash: 'e'.repeat(64),
    gateway: { ...session.gateway, id: 'other-gateway' },
  };
  await insert();
  await issue();
  await change({ connection: claim });
  expect((await read()).connection).toEqual(claim);
});

it('reads native P-256 CA pins and bounded IPv6 gateway sources after SQL admission', async () => {
  const record = {
    ...session,
    identityPin: { ...session.identityPin, sshHostCa: accessP256PublicKey() },
    gateway: {
      ...session.gateway,
      origin: 'wss://[2001:db8::1]:443',
      egressCidrs: ['2001:db8::1/128', '::1/128'],
    },
  };
  await insert(record);
  expect(await read()).toEqual(record);
});

it('keeps gateway lexical acceptance identical in contracts and PostgreSQL', async () => {
  const base = session.gateway;
  expect(accessGatewaySchema.safeParse({ ...base, id: 'local\n' }).success).toBe(false);
  const candidates: unknown[] = [
    ...[
      'wss://gateway.example',
      'WSS://GATEWAY.EXAMPLE',
      'wss://gateway.example.',
      'wss://gateway.example/',
      'wss://gateway.example\n',
      'wss://gateway.example:0',
      'wss://gateway.example:65535',
      'wss://gateway.example:65536',
      'wss://127.1',
      'wss://127.0.0.1',
      'ws://localhost',
      'ws://[::1]',
      'ws://[0:0:0:0:0:0:0:1]',
      'wss://[2001:db8::1]',
      'wss://[::ffff:127.0.0.1]',
      'wss://gateway-.example',
      'wss://a_b.example',
    ].map((origin) => ({ ...base, origin })),
    ...[
      ['::1/128'],
      ['::1/0128'],
      ['::1/0'],
      ['127.0.0.1/01'],
      ['127.0.0.1/32'],
      ['01.0.0.1/32'],
      ['::ffff:127.0.0.1/128'],
      [null],
      [],
      ['127.0.0.1/32\n'],
    ].map((egressCidrs) => ({ ...base, egressCidrs })),
    { ...base, id: 'local\n' },
    { ...base, id: 'LOCAL' },
  ];
  for (const candidate of candidates) {
    const expected = accessGatewaySchema.safeParse(candidate).success;
    const result = await fixture.connection.pool.query<{ valid: boolean }>(
      'SELECT valid_access_gateway($1::jsonb) AS valid',
      [JSON.stringify(candidate)],
    );
    expect(result.rows[0]?.valid, JSON.stringify(candidate)).toBe(expected);
  }
});

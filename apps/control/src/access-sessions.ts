import { createHash, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import {
  CloudError,
  accessIdentityPinSchema,
  accessSessionResponseSchema,
  bootstrapSpecSchema,
  guestIdentitySchema,
  newId,
  type AccessServiceConfig,
  type AccessSessionRecord,
  type AccessSessionRequest,
  type AccessSessionId,
  type Principal,
  type MachineId,
  type MachineProvider,
  type gatewayClaimSchema,
  type gatewayConnectionSchema,
  type gatewayCloseSchema,
} from '@agent-cloud/contracts';
import {
  accessSessions,
  allocations,
  guestBootstraps,
  guestIdentities,
  machines,
  operations,
  providerResources,
  accessSessionRecord,
  machineRecord,
  databaseTime,
  withMachineLock,
  withAccessSessionLock,
  type Connection,
  type Executor,
  type Transaction,
} from '@agent-cloud/db';
import type { CustomerSshSigner } from '@agent-cloud/pki';
import { authorize, hashToken, loadAuthority } from './auth.js';
import { lockAccount } from './lifecycle.js';
import { observeGuest } from './guest-observation.js';

const sessionScope = (session: AccessSessionRecord) => ({
  accountId: session.accountId,
  grantId: session.grantId,
  machineId: session.machineId,
});
const unavailable = (
  reason: Extract<AccessSessionRecord['issuance'], { kind: 'unavailable' }>['reason'],
) => ({ kind: 'unavailable', reason }) satisfies AccessSessionRecord['issuance'];

/** API, worker and gateway RPC share these decisions; the gateway holds no database or CA keys. */
export function createAccessService(input: {
  connection: Connection;
  provider: MachineProvider;
  config: AccessServiceConfig;
  signer: () => Promise<CustomerSshSigner>;
  checkNetwork: () => Promise<void>;
}) {
  const { connection, config } = input;
  async function readSession(db: Executor, id: AccessSessionId) {
    const [row] = await db.select().from(accessSessions).where(eq(accessSessions.id, id));
    if (!row) throw new CloudError('not_found', 'Access session not found.');
    return accessSessionRecord(row);
  }
  async function current(
    tx: Transaction,
    scope: Pick<AccessSessionRecord, 'accountId' | 'grantId' | 'machineId'>,
  ) {
    await lockAccount(tx, scope);
    const authority = await loadAuthority(tx, scope.grantId);
    if (authority.principal.accountId !== scope.accountId)
      throw new CloudError('permission_denied', 'Access account changed.');
    const [row] = await tx
      .select()
      .from(machines)
      .where(and(eq(machines.id, scope.machineId), eq(machines.accountId, scope.accountId)));
    if (!row) throw new CloudError('not_found', 'Machine not found.');
    const machine = machineRecord(row);
    authorize(authority.principal, 'machine:exec', machine.projectId);
    if (
      machine.state.kind !== 'allocated' ||
      machine.state.power !== 'running' ||
      machine.state.guest.kind !== 'ssh'
    )
      throw new CloudError('resource_busy', 'SSH requires a running verified guest.');
    const [active] = await tx
      .select({ id: operations.id })
      .from(operations)
      .where(
        and(
          eq(operations.machineId, machine.id),
          sql`${operations.progress}->>'kind' NOT IN ('succeeded','failed','cancelled')`,
        ),
      )
      .limit(1);
    if (active) throw new CloudError('resource_busy', 'Machine has an active lifecycle operation.');
    const [allocation] = await tx
      .select()
      .from(allocations)
      .where(
        and(
          eq(allocations.id, machine.state.allocationId),
          eq(allocations.accountId, scope.accountId),
          isNull(allocations.retiredAt),
        ),
      );
    const [bootstrap] = await tx
      .select()
      .from(guestBootstraps)
      .where(eq(guestBootstraps.allocationId, machine.state.allocationId));
    const [identityRow] = await tx
      .select()
      .from(guestIdentities)
      .where(eq(guestIdentities.allocationId, machine.state.allocationId));
    if (!allocation || !bootstrap || !identityRow)
      throw new CloudError('resource_busy', 'Guest identity is unavailable.');
    const spec = bootstrapSpecSchema.parse(bootstrap.spec);
    const identity = guestIdentitySchema.parse(identityRow.identity);
    if (
      spec.image.customerSsh !== 1 ||
      identity.kind !== 'issued' ||
      spec.accountId !== scope.accountId ||
      spec.machineId !== machine.id ||
      spec.allocationId !== allocation.id ||
      machine.state.guest.manifestDigest !== spec.image.manifestDigest
    )
      throw new CloudError(
        'permission_denied',
        'This verified image does not support customer SSH.',
      );
    const resources = await tx
      .select()
      .from(providerResources)
      .where(
        and(
          eq(providerResources.allocationId, allocation.id),
          eq(providerResources.accountId, scope.accountId),
          isNull(providerResources.absentAt),
        ),
      );
    const servers = resources.filter((r) => r.kind === 'server');
    const ips = resources.filter((r) => r.kind === 'primary_ip');
    const server = servers[0];
    const ip = ips[0];
    if (
      servers.length !== 1 ||
      ips.length !== 1 ||
      !server ||
      !ip ||
      server.providerId !== allocation.serverId ||
      server.provider !== input.provider.kind ||
      ip.provider !== input.provider.kind
    )
      throw new CloudError('resource_busy', 'Access requires one recorded owned VM and IP.');
    const pin = accessIdentityPinSchema.parse({
      provider: input.provider.kind,
      serverId: server.providerId,
      primaryIpId: ip.providerId,
      hostAlias: `${allocation.id.replace('alloc_', 'alloc-')}.guest.agent-cloud.internal`,
      sshHostCa: spec.image.sshHostCa,
      guestHostPublicKey: identity.sshHostPublicKey,
      imageManifestDigest: spec.image.manifestDigest,
    });
    return { authority, machine, allocation, spec, pin };
  }
  function unchanged(session: AccessSessionRecord, context: Awaited<ReturnType<typeof current>>) {
    if (
      session.machineVersion !== context.machine.version ||
      session.allocationId !== context.allocation.id ||
      !isDeepStrictEqual(session.identityPin, context.pin) ||
      !isDeepStrictEqual(session.gateway, config.gateway)
    )
      throw new CloudError('permission_denied', 'Access target or gateway changed.');
  }
  async function locked<T>(
    session: Pick<AccessSessionRecord, 'machineId'>,
    work: (tx: Transaction) => Promise<T>,
  ) {
    const result = await withMachineLock({
      pool: connection.pool,
      machineId: session.machineId,
      work: (db) => db.transaction(work),
    });
    if (result.kind === 'busy') throw new CloudError('resource_busy', 'Machine is busy.', true);
    return result.value;
  }
  async function setIssuance(
    db: Executor,
    session: AccessSessionRecord,
    issuance: AccessSessionRecord['issuance'],
  ) {
    await db.update(accessSessions).set({ issuance }).where(eq(accessSessions.id, session.id));
    return { ...session, issuance };
  }
  async function enqueue(db: Executor, sessionId: string) {
    await db.execute(sql`SELECT graphile_worker.add_job('issue_access_session',
      ${JSON.stringify({ sessionId })}::json, max_attempts := 25, job_key := ${sessionId})`);
  }
  function publicSession(session: AccessSessionRecord) {
    return accessSessionResponseSchema.parse({ session });
  }
  async function admit(
    principal: Principal,
    machineId: MachineId,
    request: AccessSessionRequest,
    key: string,
  ) {
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({ machineId, publicKey: request.publicKey, ticketHash: request.ticketHash }),
      )
      .digest('hex');
    return locked({ machineId }, async (tx) => {
      await lockAccount(tx, principal);
      const authority = await loadAuthority(tx, principal.grantId);
      const [previous] = await tx
        .select()
        .from(accessSessions)
        .where(
          and(
            eq(accessSessions.accountId, principal.accountId),
            eq(accessSessions.grantId, principal.grantId),
            eq(accessSessions.requestKey, key),
          ),
        );
      if (previous) {
        const session = accessSessionRecord(previous);
        authorize(authority.principal, 'machine:exec', session.projectId);
        if (session.fingerprint !== fingerprint)
          throw new CloudError(
            'idempotency_conflict',
            'Request key already belongs to different access.',
          );
        return publicSession(session);
      }
      const context = await current(tx, { ...principal, machineId });
      const now = context.authority.checkedAt;
      const hardDeadline = new Date(
        Math.min(now.getTime() + 3_600_000, context.authority.expiresAt.getTime()),
      );
      if (hardDeadline.getTime() - now.getTime() < 10_000)
        throw new CloudError(
          'permission_denied',
          'SSH requires at least ten seconds of remaining authority.',
        );
      const counts = await tx.execute<{
        recent: number;
        grant_recent: number;
        reserved: number;
        grant_reserved: number;
      }>(sql`
        SELECT count(*) FILTER (WHERE admitted_at > ${new Date(now.getTime() - 300_000)})::int AS recent,
          count(*) FILTER (WHERE grant_id=${principal.grantId} AND admitted_at > ${new Date(now.getTime() - 300_000)})::int AS grant_recent,
          count(*) FILTER (WHERE connection->>'kind'<>'closed' AND
            CASE WHEN connection->>'kind'='claimed' THEN hard_deadline
              WHEN issuance->>'kind'='issued' THEN (issuance->>'ticketDeadline')::timestamptz
              ELSE issue_deadline END > ${now})::int AS reserved,
          count(*) FILTER (WHERE grant_id=${principal.grantId} AND connection->>'kind'<>'closed' AND
            CASE WHEN connection->>'kind'='claimed' THEN hard_deadline
              WHEN issuance->>'kind'='issued' THEN (issuance->>'ticketDeadline')::timestamptz
              ELSE issue_deadline END > ${now})::int AS grant_reserved
        FROM access_sessions WHERE account_id=${principal.accountId}
          AND (admitted_at > ${new Date(now.getTime() - 300_000)} OR hard_deadline > ${now})
      `);
      const reservations = counts.rows[0];
      if (
        !reservations ||
        reservations.recent >= 20 ||
        reservations.grant_recent >= 10 ||
        reservations.reserved >= 20 ||
        reservations.grant_reserved >= 4
      )
        throw new CloudError(
          'quota_exceeded',
          'SSH session rate or concurrent reservation limit reached.',
        );
      const session: AccessSessionRecord = {
        id: newId.accessSession(),
        accountId: principal.accountId,
        projectId: context.machine.projectId,
        grantId: principal.grantId,
        machineId,
        allocationId: context.spec.allocationId,
        machineVersion: context.machine.version,
        requestKey: key,
        fingerprint,
        ...request,
        identityPin: context.pin,
        gateway: config.gateway,
        admittedAt: now.toISOString(),
        issueDeadline: new Date(now.getTime() + 90_000).toISOString(),
        hardDeadline: hardDeadline.toISOString(),
        issuance: { kind: 'pending' },
        connection: { kind: 'unclaimed' },
      };
      const [collision] = await tx
        .select({ id: accessSessions.id })
        .from(accessSessions)
        .where(eq(accessSessions.ticketHash, request.ticketHash));
      if (collision)
        throw new CloudError(
          'idempotency_conflict',
          'Transport ticket already belongs to another session.',
        );
      await tx.insert(accessSessions).values({
        ...session,
        admittedAt: now,
        issueDeadline: new Date(session.issueDeadline),
        hardDeadline,
      });
      await enqueue(tx, session.id);
      return publicSession(session);
    });
  }
  async function inspect(principal: Principal, id: AccessSessionId) {
    const session = await readSession(connection.db, id);
    if (principal.accountId !== session.accountId)
      throw new CloudError('not_found', 'Access session not found.');
    authorize(
      principal,
      principal.grantId === session.grantId ? 'machine:exec' : 'machine:read',
      session.projectId,
    );
    const ancestry = await connection.db.execute<{ allowed: boolean }>(sql`
      WITH RECURSIVE chain AS (
        SELECT id,parent_id,1 AS depth FROM grants WHERE id=${session.grantId} AND account_id=${principal.accountId}
        UNION ALL SELECT g.id,g.parent_id,c.depth+1 FROM grants g JOIN chain c ON g.id=c.parent_id
          WHERE g.account_id=${principal.accountId} AND c.depth<32
      ) SELECT EXISTS(SELECT 1 FROM chain WHERE id=${principal.grantId}) AS allowed
    `);
    if (!ancestry.rows[0]?.allowed) throw new CloudError('not_found', 'Access session not found.');
    return publicSession(session);
  }
  async function issue(id: AccessSessionId) {
    const pass = await withAccessSessionLock({
      pool: connection.pool,
      sessionId: id,
      work: async (db) => {
        let session = await readSession(db, id);
        if (!['pending', 'attempted'].includes(session.issuance.kind)) return;
        const prepare = async () =>
          locked(session, async (tx) => {
            session = await readSession(tx, id);
            if (session.issuance.kind === 'attempted') {
              await setIssuance(tx, session, unavailable('signing_unknown'));
              return null;
            }
            if (session.issuance.kind !== 'pending') return null;
            const now = await databaseTime(tx);
            if (
              now.getTime() >=
              Math.min(Date.parse(session.issueDeadline), Date.parse(session.hardDeadline))
            ) {
              await setIssuance(tx, session, unavailable('deadline_exceeded'));
              return null;
            }
            try {
              const context = await current(tx, sessionScope(session));
              unchanged(session, context);
              if (session.connection.kind !== 'unclaimed')
                throw new CloudError('permission_denied', 'Access closed.');
              return context;
            } catch (error) {
              if (!(error instanceof CloudError)) throw error;
              await setIssuance(
                tx,
                session,
                unavailable(
                  error.failure.code === 'unauthenticated'
                    ? 'authorization_changed'
                    : 'target_changed',
                ),
              );
              return null;
            }
          });
        const context = await prepare();
        if (!context) return;
        let address: string;
        try {
          await input.checkNetwork();
          address = (await observeGuest(db, input.provider, context)).address;
        } catch (error) {
          if (error instanceof CloudError && error.failure.retryable) return;
          await locked(session, async (tx) => {
            await setIssuance(tx, await readSession(tx, id), unavailable('provider_rejected'));
          });
          return;
        }
        const attempt = await locked(session, async (tx) => {
          session = await readSession(tx, id);
          try {
            const currentContext = await current(tx, sessionScope(session));
            unchanged(session, currentContext);
            if (session.connection.kind !== 'unclaimed' || session.issuance.kind !== 'pending')
              return null;
            const now = currentContext.authority.checkedAt;
            if (
              now.getTime() >=
              Math.min(Date.parse(session.issueDeadline), Date.parse(session.hardDeadline))
            ) {
              await setIssuance(tx, session, unavailable('deadline_exceeded'));
              return null;
            }
            session = await setIssuance(tx, session, {
              kind: 'attempted',
              attemptedAt: now.toISOString(),
            });
            return { session, authority: currentContext.authority };
          } catch (error) {
            if (!(error instanceof CloudError)) throw error;
            await setIssuance(tx, session, unavailable('authorization_changed'));
            return null;
          }
        });
        if (!attempt) return;
        const remaining =
          Math.min(Date.parse(session.issueDeadline), Date.parse(session.hardDeadline)) -
          attempt.authority.checkedAt.getTime();
        const signer = await input.signer();
        const result = await signer.sign({
          ...attempt,
          signal: AbortSignal.timeout(Math.max(1, Math.min(20_000, remaining))),
        });
        await locked(session, async (tx) => {
          session = await readSession(tx, id);
          if (session.issuance.kind !== 'attempted') return;
          try {
            const latest = await current(tx, sessionScope(session));
            unchanged(session, latest);
            const now = latest.authority.checkedAt;
            const deadline = Math.min(
              Date.parse(session.issueDeadline),
              Date.parse(session.hardDeadline),
              latest.authority.expiresAt.getTime(),
            );
            if (now.getTime() >= deadline || session.connection.kind !== 'unclaimed') {
              await setIssuance(tx, session, unavailable('deadline_exceeded'));
              return;
            }
            if (result.kind !== 'issued') {
              await setIssuance(
                tx,
                session,
                unavailable(
                  result.kind === 'unknown'
                    ? 'signing_unknown'
                    : result.kind === 'rejected'
                      ? 'provider_rejected'
                      : 'signing_failed',
                ),
              );
              return;
            }
            if (Date.parse(result.expiresAt) <= now.getTime()) {
              await setIssuance(tx, session, unavailable('deadline_exceeded'));
              return;
            }
            await setIssuance(tx, session, {
              kind: 'issued',
              certificate: result.certificate,
              issuedAt: now.toISOString(),
              ticketDeadline: new Date(Math.min(now.getTime() + 60_000, deadline)).toISOString(),
              certificateExpiresAt: result.expiresAt,
              target: { ...session.identityPin, address, port: 22 },
            });
          } catch (error) {
            if (!(error instanceof CloudError)) throw error;
            await setIssuance(tx, session, unavailable('authorization_changed'));
          }
        });
      },
    });
    return pass.kind;
  }
  function authenticateGateway(authorization: string | undefined) {
    const token = authorization?.match(/^Bearer (aclg_[A-Za-z0-9_-]{43})$/)?.[1];
    if (
      !token ||
      !timingSafeEqual(Buffer.from(hashToken(token), 'hex'), Buffer.from(config.tokenHash, 'hex'))
    )
      throw new CloudError('unauthenticated', 'Invalid gateway credential.');
  }
  async function validConnection(
    tx: Transaction,
    session: AccessSessionRecord,
    claim: z.infer<typeof gatewayConnectionSchema>,
  ) {
    const context = await current(tx, sessionScope(session));
    unchanged(session, context);
    const connection = session.connection;
    if (
      session.issuance.kind !== 'issued' ||
      connection.kind !== 'claimed' ||
      connection.gatewayInstanceId !== claim.gatewayInstanceId ||
      connection.connectionId !== claim.connectionId
    )
      throw new CloudError('permission_denied', 'Access connection is not current.');
    const remainingMs =
      Math.min(Date.parse(session.hardDeadline), context.authority.expiresAt.getTime()) -
      context.authority.checkedAt.getTime();
    if (remainingMs <= 0) throw new CloudError('unauthenticated', 'Access expired.');
    return {
      sessionId: session.id,
      connectionId: claim.connectionId,
      remainingMs,
      target: session.issuance.target,
    };
  }
  async function claim(request: z.infer<typeof gatewayClaimSchema>) {
    const [row] = await connection.db
      .select()
      .from(accessSessions)
      .where(eq(accessSessions.ticketHash, hashToken(request.ticket)));
    if (!row) throw new CloudError('unauthenticated', 'Transport ticket is invalid.');
    const original = accessSessionRecord(row);
    const observedContext = await locked(original, async (tx) => {
      const context = await current(tx, sessionScope(original));
      unchanged(original, context);
      return context;
    });
    await input.checkNetwork();
    const observed = await observeGuest(connection.db, input.provider, observedContext);
    if (
      original.issuance.kind !== 'issued' ||
      observed.address !== original.issuance.target.address
    )
      throw new CloudError('permission_denied', 'Access target address changed.');
    return locked(original, async (tx) => {
      const session = await readSession(tx, original.id);
      const context = await current(tx, sessionScope(session));
      unchanged(session, context);
      const now = context.authority.checkedAt;
      if (
        session.connection.kind !== 'unclaimed' ||
        session.issuance.kind !== 'issued' ||
        now.getTime() >=
          Math.min(
            Date.parse(session.issuance.ticketDeadline),
            Date.parse(session.issuance.certificateExpiresAt),
            Date.parse(session.hardDeadline),
          )
      )
        throw new CloudError('unauthenticated', 'Transport ticket is expired or consumed.');
      const claimed = {
        ...session,
        connection: {
          kind: 'claimed',
          gatewayInstanceId: request.gatewayInstanceId,
          connectionId: request.connectionId,
          claimedAt: now.toISOString(),
        },
      } satisfies AccessSessionRecord;
      await tx
        .update(accessSessions)
        .set({ connection: claimed.connection })
        .where(eq(accessSessions.id, session.id));
      return validConnection(tx, claimed, { ...request, sessionId: session.id });
    });
  }
  async function check(claims: Array<z.infer<typeof gatewayConnectionSchema>>) {
    const leases = [];
    for (const claim of claims) {
      try {
        const session = await readSession(connection.db, claim.sessionId);
        const lease = await locked(session, async (tx) =>
          validConnection(tx, await readSession(tx, claim.sessionId), claim),
        );
        leases.push(lease);
      } catch (error) {
        if (!(error instanceof CloudError)) throw error;
        // Omission denies this exact connection. RPC failure cannot renew any lease.
      }
    }
    return { leases };
  }
  async function close(request: z.infer<typeof gatewayCloseSchema>) {
    const session = await readSession(connection.db, request.sessionId);
    if (session.gateway.id !== config.gateway.id)
      throw new CloudError('not_found', 'Access session not found.');
    return locked(session, async (tx) => {
      await lockAccount(tx, session);
      const latest = await readSession(tx, session.id);
      const prior =
        latest.connection.kind === 'closed' ? latest.connection.previous : latest.connection;
      if (
        prior.kind !== 'claimed' ||
        prior.connectionId !== request.connectionId ||
        prior.gatewayInstanceId !== request.gatewayInstanceId
      )
        throw new CloudError('not_found', 'Access connection not found.');
      if (latest.connection.kind !== 'closed')
        await tx
          .update(accessSessions)
          .set({
            connection: {
              kind: 'closed',
              previous: prior,
              reason: request.reason,
              closedAt: (await databaseTime(tx)).toISOString(),
            },
          })
          .where(eq(accessSessions.id, session.id));
      return { closed: true };
    });
  }
  return { admit, inspect, issue, enqueue, authenticateGateway, claim, check, close };
}
export type AccessService = ReturnType<typeof createAccessService>;

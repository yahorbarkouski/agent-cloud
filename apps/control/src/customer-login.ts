import { eq, sql } from 'drizzle-orm';
import {
  CloudError,
  accountIdSchema,
  grantIdSchema,
  githubUserIdSchema,
  grantPolicySchema,
  newId,
  loginConfigSchema,
  loginResponseSchema,
  type LoginRequest,
  type GrantPolicy,
} from '@agent-cloud/contracts';
import {
  accounts,
  projects,
  grants,
  customerIdentities,
  customerLogins,
  auditEvents,
  databaseTime,
  type Database,
} from '@agent-cloud/db';
import { generateToken, hashToken, loadAuthority, loadPrincipal } from './auth.js';
import { lockAccount } from './lifecycle.js';
import type { GithubIdentityVerifier } from './github-identity.js';
import { closeGrantAccess } from './access-closure.js';

/** Explicit preview admission. Called by an operator script, never an unauthenticated route. */
export async function admitCustomer(
  db: Database,
  input: { githubUserId: string; name: string; policy: GrantPolicy; expiresAt: Date },
) {
  const githubUserId = githubUserIdSchema.parse(input.githubUserId);
  const policy = grantPolicySchema.parse(input.policy);
  if (policy.projects.kind !== 'all')
    throw new CloudError(
      'invalid_input',
      'A new customer account needs all-project authority; delegated credentials can narrow it.',
    );
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`github-identity:${githubUserId}`}, 0))`,
    );
    const [existing] = await tx
      .select()
      .from(customerIdentities)
      .where(eq(customerIdentities.githubUserId, githubUserId));
    if (existing)
      throw new CloudError(
        'idempotency_conflict',
        'GitHub identity already has a customer account; inspect it instead of creating another.',
      );
    const now = await databaseTime(tx);
    if (input.expiresAt <= now || input.expiresAt.getTime() > now.getTime() + 366 * 86_400_000)
      throw new CloudError(
        'invalid_input',
        'Customer admission expiry must be within the next year.',
      );
    const accountId = newId.account();
    const projectId = newId.project();
    const anchorGrantId = newId.grant();
    await tx.insert(accounts).values({
      id: accountId,
      name: input.name,
      maxMachines: policy.maxMachines,
      currency: policy.currency,
      maxHourlyMicros: policy.maxHourlyMicros,
    });
    await tx.insert(projects).values({ id: projectId, accountId, name: 'default' });
    await tx.insert(grants).values({
      id: anchorGrantId,
      accountId,
      name: 'customer-admission',
      tokenHash: hashToken(generateToken()),
      policy,
      expiresAt: input.expiresAt,
    });
    await tx.insert(customerIdentities).values({ githubUserId, accountId, anchorGrantId });
    await tx.insert(auditEvents).values({
      accountId,
      subjectId: anchorGrantId,
      event: 'customer.admitted',
      details: { githubUserId, expiresAt: input.expiresAt.toISOString() },
    });
    return {
      githubUserId,
      accountId,
      projectId,
      anchorGrantId,
      expiresAt: input.expiresAt.toISOString(),
    };
  });
}

export function createCustomerLogin(input: {
  db: Database;
  clientId: string;
  verify: GithubIdentityVerifier;
}) {
  let windowStart = 0;
  let requests = 0;
  async function login(token: string, request: LoginRequest) {
    const current = performance.now();
    if (current - windowStart >= 60_000) {
      windowStart = current;
      requests = 0;
    }
    if (++requests > 30)
      throw new CloudError(
        'quota_exceeded',
        'Sign-in request limit reached. Try again in a minute.',
        true,
      );
    const githubUserId = githubUserIdSchema.parse(await input.verify(token));
    const [identity] = await input.db
      .select()
      .from(customerIdentities)
      .where(eq(customerIdentities.githubUserId, githubUserId));
    if (!identity)
      throw new CloudError(
        'permission_denied',
        'This GitHub identity has not been admitted to this cloud. Ask its operator for access.',
      );
    const accountId = accountIdSchema.parse(identity.accountId);
    const anchorId = grantIdSchema.parse(identity.anchorGrantId);
    return input.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`customer-login:${request.id}`}, 0))`,
      );
      await lockAccount(tx, { accountId });
      const authority = await loadAuthority(tx, anchorId);
      const [existing] = await tx
        .select()
        .from(customerLogins)
        .where(eq(customerLogins.id, request.id));
      if (existing) {
        if (
          existing.accountId !== accountId ||
          existing.githubUserId !== githubUserId ||
          existing.tokenHash !== request.tokenHash
        )
          throw new CloudError(
            'idempotency_conflict',
            'Login ID belongs to a different credential.',
          );
        const grant = await loadAuthority(tx, grantIdSchema.parse(existing.grantId));
        return loginResponseSchema.parse({
          principal: grant.principal,
          expiresAt: grant.expiresAt.toISOString(),
        });
      }
      const count = await tx.execute<{ total: number }>(
        sql`SELECT count(*)::int AS total FROM customer_logins WHERE account_id=${accountId} AND created_at > ${new Date(authority.checkedAt.getTime() - 86_400_000)}`,
      );
      if (!count.rows[0] || count.rows[0].total >= 20)
        throw new CloudError(
          'quota_exceeded',
          'Customer sign-in limit reached for today. Reuse or revoke existing credentials.',
        );
      const id = newId.grant();
      const expiresAt = new Date(
        Math.min(authority.expiresAt.getTime(), authority.checkedAt.getTime() + 30 * 86_400_000),
      );
      if (expiresAt.getTime() - authority.checkedAt.getTime() < 60_000)
        throw new CloudError(
          'permission_denied',
          'Customer admission is expiring; ask the operator to renew access.',
        );
      const inserted = await tx
        .insert(grants)
        .values({
          id,
          accountId,
          parentId: anchorId,
          name: 'customer-cli-login',
          tokenHash: request.tokenHash,
          policy: authority.principal.policy,
          expiresAt,
        })
        .onConflictDoNothing()
        .returning({ id: grants.id });
      if (!inserted.length)
        throw new CloudError(
          'idempotency_conflict',
          'Login credential already belongs to another request.',
        );
      await tx.insert(customerLogins).values({
        id: request.id,
        accountId,
        githubUserId,
        grantId: id,
        tokenHash: request.tokenHash,
      });
      await tx.insert(auditEvents).values({
        accountId,
        subjectId: id,
        event: 'customer.signed_in',
        details: { loginId: request.id },
      });
      return loginResponseSchema.parse({
        principal: await loadPrincipal(tx, id),
        expiresAt: expiresAt.toISOString(),
      });
    });
  }
  return {
    config: loginConfigSchema.parse({
      provider: 'github',
      clientId: input.clientId,
      invitationRequired: true,
    }),
    login,
  };
}
export type CustomerLogin = ReturnType<typeof createCustomerLogin>;

/** Operator-only account revocation covers current login descendants and future sign-ins. */
export async function disableCustomer(db: Database, githubUserId: string) {
  const [identity] = await db
    .select()
    .from(customerIdentities)
    .where(eq(customerIdentities.githubUserId, githubUserIdSchema.parse(githubUserId)));
  if (!identity) throw new CloudError('not_found', 'Customer identity is not admitted.');
  const accountId = accountIdSchema.parse(identity.accountId);
  return db.transaction(async (tx) => {
    await lockAccount(tx, { accountId });
    const [current] = await tx
      .select()
      .from(customerIdentities)
      .where(eq(customerIdentities.githubUserId, githubUserId));
    if (!current) throw new CloudError('not_found', 'Customer identity is not admitted.');
    const grantId = grantIdSchema.parse(current.anchorGrantId);
    await tx
      .update(grants)
      .set({ revokedAt: sql`COALESCE(${grants.revokedAt}, clock_timestamp())` })
      .where(eq(grants.id, grantId));
    await closeGrantAccess(tx, accountId, grantId);
    await tx.insert(auditEvents).values({
      accountId,
      subjectId: grantId,
      event: 'customer.disabled',
      details: { githubUserId },
    });
    return { githubUserId, accountId, revoked: true };
  });
}

/** Replace admission authority; never widen an existing ancestor beneath issued credentials. */
export async function renewCustomer(
  db: Database,
  input: {
    githubUserId: string;
    expectedAnchorGrantId: string;
    policy: GrantPolicy;
    expiresAt: Date;
  },
) {
  const githubUserId = githubUserIdSchema.parse(input.githubUserId);
  const expected = grantIdSchema.parse(input.expectedAnchorGrantId);
  const policy = grantPolicySchema.parse(input.policy);
  if (policy.projects.kind !== 'all')
    throw new CloudError('invalid_input', 'Customer admission requires all-project authority.');
  const [identity] = await db
    .select()
    .from(customerIdentities)
    .where(eq(customerIdentities.githubUserId, githubUserId));
  if (!identity) throw new CloudError('not_found', 'Customer identity is not admitted.');
  const accountId = accountIdSchema.parse(identity.accountId);
  return db.transaction(async (tx) => {
    const account = await lockAccount(tx, { accountId });
    if (account.currency !== policy.currency)
      throw new CloudError(
        'invalid_input',
        'Admission renewal cannot change the account currency.',
      );
    const [current] = await tx
      .select()
      .from(customerIdentities)
      .where(eq(customerIdentities.githubUserId, githubUserId));
    if (current?.anchorGrantId !== expected)
      throw new CloudError(
        'version_conflict',
        'Customer admission changed. Inspect its current anchor before renewal.',
      );
    const now = await databaseTime(tx);
    if (input.expiresAt <= now || input.expiresAt.getTime() > now.getTime() + 366 * 86_400_000)
      throw new CloudError(
        'invalid_input',
        'Customer admission expiry must be within the next year.',
      );
    await tx
      .update(grants)
      .set({ revokedAt: sql`COALESCE(${grants.revokedAt}, clock_timestamp())` })
      .where(eq(grants.id, expected));
    await closeGrantAccess(tx, accountId, expected);
    const anchorGrantId = newId.grant();
    await tx.insert(grants).values({
      id: anchorGrantId,
      accountId,
      name: 'customer-admission',
      tokenHash: hashToken(generateToken()),
      policy,
      expiresAt: input.expiresAt,
    });
    await tx
      .update(customerIdentities)
      .set({ anchorGrantId })
      .where(eq(customerIdentities.githubUserId, githubUserId));
    await tx
      .update(accounts)
      .set({
        maxMachines: policy.maxMachines,
        currency: policy.currency,
        maxHourlyMicros: policy.maxHourlyMicros,
      })
      .where(eq(accounts.id, accountId));
    await tx.insert(auditEvents).values({
      accountId,
      subjectId: anchorGrantId,
      event: 'customer.renewed',
      details: {
        githubUserId,
        previousAnchorGrantId: expected,
        expiresAt: input.expiresAt.toISOString(),
      },
    });
    return { githubUserId, accountId, anchorGrantId, expiresAt: input.expiresAt.toISOString() };
  });
}

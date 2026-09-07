import { createHash, randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  CloudError,
  grantPolicySchema,
  grantRecordSchema,
  principalSchema,
  accountIdSchema,
  grantIdSchema,
  newId,
  type Capability,
  type GrantId,
  type GrantPolicy,
  type Principal,
  type ProjectId,
} from '@agent-cloud/contracts';
import { grants, auditEvents, databaseTime, type Executor } from '@agent-cloud/db';
import { closeGrantAccess } from './access-closure.js';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const generateToken = () => `acld_${randomBytes(32).toString('base64url')}`;

const authorityObservationSchema = z.object({
  checkedAt: z.number(),
  chain: z
    .array(
      z.object({
        id: grantIdSchema,
        accountId: accountIdSchema,
        parentId: grantIdSchema.nullable(),
        policy: grantPolicySchema,
        expiresAt: z.number(),
        revoked: z.boolean(),
      }),
    )
    .min(1)
    .max(32),
});

export async function loadAuthority(db: Executor, grantId: GrantId) {
  // One statement provides one ancestry snapshot. Materialize the walk before checking expiry.
  const result = await db.execute(sql`
    WITH RECURSIVE chain AS (
      SELECT id, account_id, parent_id, policy, expires_at, revoked_at, 1 AS depth
      FROM grants WHERE id = ${grantId}
      UNION ALL
      SELECT parent.id, parent.account_id, parent.parent_id, parent.policy,
        parent.expires_at, parent.revoked_at, child.depth + 1
      FROM grants parent JOIN chain child ON parent.id = child.parent_id
      WHERE child.depth < 32
    ), observation AS MATERIALIZED (
      SELECT jsonb_agg(jsonb_build_object(
        'id', id, 'accountId', account_id, 'parentId', parent_id, 'policy', policy,
        'expiresAt', floor(extract(epoch FROM expires_at) * 1000)::float8,
        'revoked', revoked_at IS NOT NULL
      ) ORDER BY depth) AS chain FROM chain
    )
    SELECT chain, floor(extract(epoch FROM clock_timestamp()) * 1000)::float8 AS "checkedAt"
    FROM observation
  `);
  const parsed = authorityObservationSchema.safeParse(result.rows[0]);
  if (!parsed.success) throw new CloudError('unauthenticated', 'Credential is invalid or expired.');
  const { chain, checkedAt } = parsed.data;
  const leaf = chain[0];
  if (!leaf) throw new CloudError('unauthenticated', 'Credential is invalid or expired.');
  let expiresAt = leaf.expiresAt;
  let expectedId: GrantId | null = grantId;
  const seen = new Set<string>();
  for (const current of chain) {
    if (
      seen.has(current.id) ||
      current.id !== expectedId ||
      current.accountId !== leaf.accountId ||
      current.revoked ||
      current.expiresAt <= checkedAt
    ) {
      throw new CloudError('unauthenticated', 'Credential is invalid or expired.');
    }
    seen.add(current.id);
    if (current.expiresAt < expiresAt) expiresAt = current.expiresAt;
    expectedId = current.parentId;
  }
  if (expectedId) throw new CloudError('unauthenticated', 'Credential is invalid or expired.');
  return {
    principal: principalSchema.parse({
      accountId: leaf.accountId,
      grantId: leaf.id,
      policy: leaf.policy,
    }),
    checkedAt: new Date(checkedAt),
    expiresAt: new Date(expiresAt),
    delegationDepth: chain.length,
  };
}

export async function loadPrincipal(db: Executor, grantId: GrantId): Promise<Principal> {
  return (await loadAuthority(db, grantId)).principal;
}

export async function authenticate(
  db: Executor,
  authorization: string | undefined,
): Promise<Principal> {
  if (!authorization || !/^Bearer acld_[A-Za-z0-9_-]{43}$/.test(authorization)) {
    throw new CloudError('unauthenticated', 'A valid Bearer credential is required.');
  }
  const [row] = await db
    .select()
    .from(grants)
    .where(eq(grants.tokenHash, hashToken(authorization.slice(7))));
  if (!row) throw new CloudError('unauthenticated', 'Credential is invalid or expired.');
  return loadPrincipal(db, principalSchema.shape.grantId.parse(row.id));
}

export function authorize(
  principal: Principal,
  capability: Capability,
  projectId?: ProjectId,
): void {
  if (!principal.policy.capabilities.includes(capability)) {
    throw new CloudError('permission_denied', `Credential lacks ${capability}.`);
  }
  if (
    projectId &&
    principal.policy.projects.kind === 'selected' &&
    !principal.policy.projects.ids.includes(projectId)
  ) {
    throw new CloudError('not_found', 'Resource not found.');
  }
}

export function assertPolicySubset(child: GrantPolicy, parent: GrantPolicy): void {
  const projectsAllowed =
    parent.projects.kind === 'all' ||
    (child.projects.kind === 'selected' &&
      child.projects.ids.every(
        (id) => parent.projects.kind === 'selected' && parent.projects.ids.includes(id),
      ));
  if (
    !projectsAllowed ||
    child.currency !== parent.currency ||
    child.capabilities.some((cap) => !parent.capabilities.includes(cap)) ||
    child.sizes.some((size) => !parent.sizes.includes(size)) ||
    child.regions.some((region) => !parent.regions.includes(region)) ||
    child.maxMachines > parent.maxMachines ||
    child.maxHourlyMicros > parent.maxHourlyMicros
  ) {
    throw new CloudError(
      'permission_denied',
      'A delegated credential cannot exceed its parent policy.',
    );
  }
}

export async function issueGrant(
  db: Executor,
  input: {
    principal: Principal;
    name: string;
    policy: GrantPolicy;
    expiresAt: Date;
  },
) {
  const { principal, checkedAt, expiresAt, delegationDepth } = await loadAuthority(
    db,
    input.principal.grantId,
  );
  authorize(principal, 'grant:manage');
  if (delegationDepth >= 32)
    throw new CloudError('permission_denied', 'The maximum delegation depth is 32.');
  assertPolicySubset(input.policy, principal.policy);
  if (input.expiresAt > expiresAt || input.expiresAt <= checkedAt) {
    throw new CloudError(
      'invalid_input',
      'Expiry must be in the future and no later than any parent credential.',
    );
  }
  const id = newId.grant();
  const token = generateToken();
  await db.insert(grants).values({
    id,
    accountId: principal.accountId,
    parentId: principal.grantId,
    name: input.name,
    policy: grantPolicySchema.parse(input.policy),
    tokenHash: hashToken(token),
    expiresAt: input.expiresAt,
  });
  return { id, token, expiresAt: input.expiresAt.toISOString() };
}

export async function revokeGrant(db: Executor, input: { principal: Principal; grantId: GrantId }) {
  // Any credential may revoke itself; revoking another still requires delegation authority.
  if (input.grantId !== input.principal.grantId) authorize(input.principal, 'grant:manage');
  let currentId: string | null = input.grantId;
  let descendant = false;
  for (let depth = 0; currentId && depth < 32; depth++) {
    if (currentId === input.principal.grantId) {
      descendant = true;
      break;
    }
    const rows: (typeof grants.$inferSelect)[] = await db
      .select()
      .from(grants)
      .where(and(eq(grants.id, currentId), eq(grants.accountId, input.principal.accountId)));
    currentId = rows[0]?.parentId ?? null;
  }
  if (!descendant)
    throw new CloudError('not_found', 'Credential not found in your delegation tree.');
  await db
    .update(grants)
    .set({ revokedAt: await databaseTime(db) })
    .where(and(eq(grants.id, input.grantId), eq(grants.accountId, input.principal.accountId)));
  await db.insert(auditEvents).values({
    accountId: input.principal.accountId,
    subjectId: input.grantId,
    event: 'grant.revoked',
    details: { actorGrantId: input.principal.grantId },
  });
  await closeGrantAccess(db, input.principal.accountId, input.grantId);
}

/** List descendants, never ancestor/sibling credentials or token hashes. */
export async function listGrants(db: Executor, input: { principal: Principal; after?: GrantId }) {
  authorize(input.principal, 'grant:manage');
  const result = await db.execute(sql`
    WITH RECURSIVE descendants AS (
      SELECT id, parent_id, name, policy, expires_at, revoked_at, created_at, 1 AS depth
      FROM grants
      WHERE parent_id = ${input.principal.grantId}
        AND account_id = ${input.principal.accountId}
      UNION ALL
      SELECT child.id, child.parent_id, child.name, child.policy,
        child.expires_at, child.revoked_at, child.created_at, parent.depth + 1
      FROM grants child JOIN descendants parent ON child.parent_id = parent.id
      WHERE child.account_id = ${input.principal.accountId} AND parent.depth < 31
    )
    SELECT id, parent_id AS "parentId", name, policy,
      to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt",
      to_char(revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "revokedAt",
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
    FROM descendants
    WHERE id <> ${input.principal.grantId}
      ${input.after ? sql`AND id > ${input.after}` : sql``}
    ORDER BY id LIMIT 101
  `);
  const rows = result.rows.slice(0, 100).map((row) => grantRecordSchema.parse(row));
  return { grants: rows, nextCursor: result.rows.length > 100 ? (rows.at(-1)?.id ?? null) : null };
}

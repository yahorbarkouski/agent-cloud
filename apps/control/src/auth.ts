import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  CloudError,
  grantPolicySchema,
  principalSchema,
  newId,
  type Capability,
  type GrantId,
  type GrantPolicy,
  type Principal,
  type ProjectId,
} from '@agent-cloud/contracts';
import { grants, auditEvents, type Executor } from '@agent-cloud/db';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const generateToken = () => `acld_${randomBytes(32).toString('base64url')}`;

export async function loadPrincipal(db: Executor, grantId: GrantId): Promise<Principal> {
  const [leaf] = await db.select().from(grants).where(eq(grants.id, grantId));
  if (!leaf) throw new CloudError('unauthenticated', 'Credential is invalid or expired.');
  let current = leaf;
  const seen = new Set<string>();
  for (;;) {
    if (
      seen.has(current.id) ||
      seen.size >= 32 ||
      current.accountId !== leaf.accountId ||
      current.revokedAt ||
      current.expiresAt.getTime() <= Date.now()
    ) {
      throw new CloudError('unauthenticated', 'Credential is invalid or expired.');
    }
    seen.add(current.id);
    if (!current.parentId) break;
    const [parent] = await db.select().from(grants).where(eq(grants.id, current.parentId));
    if (!parent) throw new CloudError('unauthenticated', 'Credential is invalid or expired.');
    current = parent;
  }
  return principalSchema.parse({
    accountId: leaf.accountId,
    grantId: leaf.id,
    policy: leaf.policy,
  });
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
  const principal = await loadPrincipal(db, input.principal.grantId);
  authorize(principal, 'grant:manage');
  assertPolicySubset(input.policy, principal.policy);
  const [parent] = await db.select().from(grants).where(eq(grants.id, principal.grantId));
  if (!parent || input.expiresAt > parent.expiresAt || input.expiresAt.getTime() <= Date.now()) {
    throw new CloudError(
      'invalid_input',
      'Expiry must be in the future and no later than the parent credential.',
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
  authorize(input.principal, 'grant:manage');
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
    .set({ revokedAt: new Date() })
    .where(and(eq(grants.id, input.grantId), eq(grants.accountId, input.principal.accountId)));
  await db.insert(auditEvents).values({
    accountId: input.principal.accountId,
    subjectId: input.grantId,
    event: 'grant.revoked',
    details: { actorGrantId: input.principal.grantId },
  });
}

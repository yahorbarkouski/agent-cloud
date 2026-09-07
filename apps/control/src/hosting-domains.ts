import { randomBytes, randomUUID } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { and, eq, gt, sql } from 'drizzle-orm';
import {
  CloudError,
  domainChallengeSchema,
  hostnameSchema,
  type HostingControlConfig,
  type Principal,
} from '@agent-cloud/contracts';
import { auditEvents, databaseTime, domainChallenges, type Database } from '@agent-cloud/db';
import { authorize, loadAuthority } from './auth.js';
import { lockAccount } from './lifecycle.js';

export async function resolveDomain(hostname: string) {
  const resolver = new Resolver({ timeout: 2000, tries: 2 });
  const [txt, ipv4, ipv6] = await Promise.allSettled([
    resolver.resolveTxt(`_agent-cloud-challenge.${hostname}`),
    resolver.resolve4(hostname),
    resolver.resolve6(hostname),
  ]);
  for (const result of [txt, ipv4, ipv6])
    if (result.status === 'rejected') {
      const error: unknown = result.reason;
      if (
        !(
          error instanceof Error &&
          'code' in error &&
          ['ENODATA', 'ENOTFOUND'].includes(String(error.code))
        )
      )
        throw new CloudError('provider_unavailable', 'Domain DNS lookup is unavailable.', true);
    }
  return {
    values: txt.status === 'fulfilled' ? txt.value.map((parts) => parts.join('')) : [],
    addresses: [
      ...(ipv4.status === 'fulfilled' ? ipv4.value : []),
      ...(ipv6.status === 'fulfilled' ? ipv6.value : []),
    ],
  };
}
export function createHostingDomains(input: {
  db: Database;
  config: HostingControlConfig;
  resolve?: typeof resolveDomain;
}) {
  const record = (row: typeof domainChallenges.$inferSelect) =>
    domainChallengeSchema.parse({
      id: row.id,
      hostname: row.hostname,
      recordName: `_agent-cloud-challenge.${row.hostname}`,
      recordValue: row.value,
      expiresAt: row.expiresAt.toISOString(),
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
    });
  async function create(principal: Principal, value: string) {
    const hostname = hostnameSchema.parse(value);
    if (
      hostname === input.config.applicationDomain ||
      hostname.endsWith(`.${input.config.applicationDomain}`)
    )
      throw new CloudError(
        'permission_denied',
        'The application domain is reserved for generated routes.',
      );
    return input.db.transaction(async (tx) => {
      await lockAccount(tx, principal);
      const authority = await loadAuthority(tx, principal.grantId);
      authorize(authority.principal, 'route:publish');
      const recent = await tx
        .select({ id: domainChallenges.id })
        .from(domainChallenges)
        .where(
          and(
            eq(domainChallenges.accountId, principal.accountId),
            gt(domainChallenges.createdAt, new Date(authority.checkedAt.getTime() - 3_600_000)),
          ),
        )
        .limit(20);
      if (recent.length >= 20)
        throw new CloudError(
          'quota_exceeded',
          'Domain verification is limited to twenty challenges per account per hour.',
        );
      const [created] = await tx
        .insert(domainChallenges)
        .values({
          id: randomUUID(),
          accountId: principal.accountId,
          hostname,
          value: `acld_${randomBytes(32).toString('base64url')}`,
          expiresAt: new Date(authority.checkedAt.getTime() + 1_800_000),
        })
        .returning();
      if (!created) throw new Error('Domain challenge was not recorded.');
      await tx.insert(auditEvents).values({
        accountId: principal.accountId,
        subjectId: created.id,
        event: 'domain.challenge_created',
        details: { grantId: principal.grantId, hostname },
      });
      return record(created);
    });
  }
  async function verify(principal: Principal, id: string) {
    authorize(principal, 'route:publish');
    const [challenge] = await input.db
      .select()
      .from(domainChallenges)
      .where(and(eq(domainChallenges.id, id), eq(domainChallenges.accountId, principal.accountId)));
    if (!challenge) throw new CloudError('not_found', 'Domain challenge not found.');
    const now = await databaseTime(input.db);
    if (challenge.expiresAt <= now)
      throw new CloudError(
        'permission_denied',
        'Domain challenge expired; create a fresh challenge.',
      );
    const answer = await (input.resolve ?? resolveDomain)(challenge.hostname);
    if (
      !answer.values.includes(challenge.value) ||
      !answer.addresses.length ||
      !answer.addresses.every((address) => input.config.gatewayAddresses.includes(address))
    )
      throw new CloudError(
        'permission_denied',
        'Publish the exact TXT challenge and point every domain address to this cloud gateway before verification.',
      );
    return input.db.transaction(async (tx) => {
      await lockAccount(tx, principal);
      const authority = await loadAuthority(tx, principal.grantId);
      authorize(authority.principal, 'route:publish');
      const [verified] = await tx
        .update(domainChallenges)
        .set({ verifiedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(domainChallenges.id, id),
            eq(domainChallenges.accountId, principal.accountId),
            gt(domainChallenges.expiresAt, authority.checkedAt),
          ),
        )
        .returning();
      if (!verified)
        throw new CloudError(
          'permission_denied',
          'Domain challenge expired before verification completed.',
        );
      await tx.insert(auditEvents).values({
        accountId: principal.accountId,
        subjectId: verified.id,
        event: 'domain.verified',
        details: { grantId: principal.grantId, hostname: verified.hostname },
      });
      return record(verified);
    });
  }
  return { create, verify };
}

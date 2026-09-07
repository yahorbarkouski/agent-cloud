import { randomUUID, X509Certificate } from 'node:crypto';
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  CloudError,
  bootstrapSpecSchema,
  guestRenewalInputSchema,
  guestSubject,
  issuedGuestIdentitySchema,
  type GuestRenewalInput,
  type IssuedGuestIdentity,
  type MachineProvider,
} from '@agent-cloud/contracts';
import {
  allocations,
  auditEvents,
  databaseTime,
  guestBootstraps,
  guestCertificateRenewals,
  guestIdentities,
  withMachineLock,
  type Connection,
  type Executor,
} from '@agent-cloud/db';
import { verifyGuestRenewal, type Signer } from '@agent-cloud/pki';
import type { createGuestProbe } from '@agent-cloud/remote';
import { observeGuest } from './guest-observation.js';

async function context(db: Executor, request: GuestRenewalInput) {
  const [row] = await db
    .select({
      allocation: allocations,
      bootstrap: guestBootstraps,
      original: guestIdentities.identity,
    })
    .from(allocations)
    .innerJoin(
      guestBootstraps,
      and(
        eq(guestBootstraps.allocationId, allocations.id),
        eq(guestBootstraps.accountId, allocations.accountId),
      ),
    )
    .innerJoin(
      guestIdentities,
      and(
        eq(guestIdentities.allocationId, allocations.id),
        eq(guestIdentities.accountId, allocations.accountId),
      ),
    )
    .where(
      and(
        eq(allocations.id, request.allocationId),
        isNull(allocations.retiredAt),
        isNotNull(guestBootstraps.consumedAt),
      ),
    );
  if (!row) throw new CloudError('unauthenticated', 'Guest renewal identity is unavailable.');
  const original = issuedGuestIdentitySchema.parse(row.original);
  const spec = bootstrapSpecSchema.parse(row.bootstrap.spec);
  if (
    spec.allocationId !== row.allocation.id ||
    spec.accountId !== row.allocation.accountId ||
    spec.machineId !== row.allocation.machineId ||
    spec.operationId !== row.bootstrap.operationId ||
    spec.image.version !== original.imageVersion
  )
    throw new CloudError('internal_error', 'Guest renewal ownership is inconsistent.');
  const now = await databaseTime(db);
  verifyGuestRenewal({ request, now, key: new X509Certificate(original.tlsCertificate).publicKey });
  return { allocation: row.allocation, spec, original, now };
}

export function createGuestRenewalService(ports: {
  connection: Connection;
  provider: MachineProvider;
  signer: Pick<Signer, 'trust' | 'issueProbeCredential' | 'signHost' | 'signTls'>;
  probe: Pick<ReturnType<typeof createGuestProbe>, 'readIdentity'>;
}) {
  return {
    async renew(value: GuestRenewalInput): Promise<IssuedGuestIdentity> {
      const request = guestRenewalInputSchema.parse(value);
      const initial = await context(ports.connection.db, request);
      const locked = await withMachineLock({
        pool: ports.connection.pool,
        machineId: initial.spec.machineId,
        work: async (db) => {
          const current = await context(db, request);
          const [latest] = await db
            .select()
            .from(guestCertificateRenewals)
            .where(
              and(
                eq(guestCertificateRenewals.allocationId, request.allocationId),
                isNotNull(guestCertificateRenewals.identity),
              ),
            )
            .orderBy(desc(guestCertificateRenewals.createdAt))
            .limit(1);
          const identity = latest
            ? issuedGuestIdentitySchema.parse(latest.identity)
            : current.original;
          if (current.now.getTime() < Date.parse(identity.issuedAt) + 1_800_000) return identity;
          const trust = ports.signer.trust;
          if (
            trust.sshHostCa !== current.spec.image.sshHostCa ||
            trust.sshUserCa !== current.spec.image.sshUserCa ||
            trust.tlsRoot.trim() !== current.spec.image.tlsRoot.trim()
          )
            throw new CloudError(
              'provider_unavailable',
              'Renewal needs the original pinned CA trust.',
            );
          const { address } = await observeGuest(db, ports.provider, current);
          const id = randomUUID();
          await db.transaction(async (tx) => {
            await tx
              .select()
              .from(allocations)
              .where(eq(allocations.id, request.allocationId))
              .for('update');
            await context(tx, request);
            const [budget] = await tx
              .select({
                count: sql<number>`count(*)::integer`,
                cooldown: sql<boolean>`coalesce(max(${guestCertificateRenewals.createdAt}) > now()-interval '30 seconds', false)`,
              })
              .from(guestCertificateRenewals)
              .where(
                and(
                  eq(guestCertificateRenewals.allocationId, request.allocationId),
                  sql`${guestCertificateRenewals.createdAt} > now()-interval '1 hour'`,
                ),
              );
            if ((budget?.count ?? 0) >= 4)
              throw new CloudError(
                'quota_exceeded',
                'Guest renewal signing allowance is exhausted for this hour.',
              );
            if (budget?.cooldown)
              throw new CloudError(
                'resource_busy',
                'Guest renewal retry must wait thirty seconds.',
                true,
              );
            await tx.insert(guestCertificateRenewals).values({
              id,
              allocationId: request.allocationId,
              accountId: current.spec.accountId,
            });
          });
          const subject = guestSubject(current.spec);
          const proof = await ports.probe.readIdentity({
            subject,
            address,
            trust: { kind: 'pinned_key', publicKey: current.original.sshHostPublicKey },
            credential: await ports.signer.issueProbeCredential(subject),
          });
          if (
            proof.version !== 1 ||
            proof.allocationId !== request.allocationId ||
            proof.sshHostPublicKey !== current.original.sshHostPublicKey ||
            proof.tlsCsr !== current.original.tlsCsr ||
            proof.imageVersion !== current.original.imageVersion ||
            proof.manifestDigest !== current.spec.image.manifestDigest
          )
            throw new CloudError(
              'permission_denied',
              'Guest renewal proof disagrees with its registered identity.',
            );
          await context(db, request);
          const sshHostCertificate = await ports.signer.signHost({
            subject,
            publicKey: current.original.sshHostPublicKey,
          });
          const tlsCertificate = await ports.signer.signTls({
            subject,
            csr: current.original.tlsCsr,
          });
          return db.transaction(async (tx) => {
            await tx
              .select()
              .from(allocations)
              .where(eq(allocations.id, request.allocationId))
              .for('update');
            const final = await context(tx, request);
            const renewed = issuedGuestIdentitySchema.parse({
              ...current.original,
              sshHostCertificate,
              tlsCertificate,
              issuedAt: final.now.toISOString(),
            });
            await tx
              .update(guestCertificateRenewals)
              .set({ identity: renewed })
              .where(eq(guestCertificateRenewals.id, id));
            await tx.insert(auditEvents).values({
              accountId: current.spec.accountId,
              subjectId: request.allocationId,
              event: 'guest.renewed',
              details: { renewalId: id },
            });
            return renewed;
          });
        },
      });
      if (locked.kind === 'busy')
        throw new CloudError('resource_busy', 'Guest lifecycle work is in progress.', true);
      return locked.value;
    },
  };
}
export type GuestRenewalService = ReturnType<typeof createGuestRenewalService>;

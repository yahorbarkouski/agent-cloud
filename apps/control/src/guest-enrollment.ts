import { and, eq, isNull, desc, sql } from 'drizzle-orm';
import {
  CloudError,
  bootstrapSpecSchema,
  guestEnrollmentInputSchema,
  guestIdentitySchema,
  issuedGuestIdentitySchema,
  providerCommandSchema,
  isServerCreateCommand,
  effectResolutionSchema,
  type GuestEnrollmentInput,
  type IssuedGuestIdentity,
  type MachineProvider,
  type AllocationId,
} from '@agent-cloud/contracts';
import {
  allocations,
  guestBootstraps,
  guestIdentities,
  guestSigningAttempts,
  operations,
  attempts,
  auditEvents,
  enqueueOperation,
  operationRecord,
  withMachineLock,
  type Connection,
  type Database,
  type Transaction,
} from '@agent-cloud/db';
import type { Signer, ProbeCredential } from '@agent-cloud/pki';
import type { createGuestProbe } from '@agent-cloud/remote';
import type { BootstrapSeal } from './bootstrap-seal.js';
import { observeGuest } from './guest-observation.js';

type EnrollmentPorts = {
  connection: Connection;
  seal: BootstrapSeal;
  signer: Pick<
    Signer,
    'trust' | 'validateTlsRequest' | 'issueProbeCredential' | 'signHost' | 'signTls'
  >;
  probe: Pick<ReturnType<typeof createGuestProbe>, 'readIdentity'>;
  provider: MachineProvider;
};

async function loadBootstrap(db: Database, seal: BootstrapSeal, input: GuestEnrollmentInput) {
  const [row] = await db
    .select({ bootstrap: guestBootstraps, allocation: allocations })
    .from(guestBootstraps)
    .innerJoin(
      allocations,
      and(
        eq(allocations.id, guestBootstraps.allocationId),
        eq(allocations.accountId, guestBootstraps.accountId),
      ),
    )
    .where(
      and(
        eq(guestBootstraps.allocationId, input.bootstrap.allocationId),
        isNull(allocations.retiredAt),
      ),
    );
  if (
    !row ||
    !seal.matches(input.token, row.bootstrap.tokenHash) ||
    row.bootstrap.expiresAt.getTime() <= Date.now()
  )
    throw new CloudError('unauthenticated', 'Guest bootstrap credentials are invalid or expired.');
  const spec = bootstrapSpecSchema.parse(row.bootstrap.spec);
  if (
    spec.accountId !== row.allocation.accountId ||
    spec.machineId !== row.allocation.machineId ||
    spec.operationId !== row.bootstrap.operationId ||
    spec.allocationId !== row.allocation.id ||
    spec.expiresAt !== row.bootstrap.expiresAt.toISOString()
  )
    throw new CloudError('internal_error', 'Guest bootstrap ownership is inconsistent.');
  if (input.imageVersion !== spec.image.version)
    throw new CloudError('permission_denied', 'Guest image does not match its bootstrap.');
  return { ...row, spec };
}

async function readIdentity(db: Database, input: GuestEnrollmentInput) {
  const [row] = await db
    .select()
    .from(guestIdentities)
    .where(eq(guestIdentities.allocationId, input.bootstrap.allocationId));
  if (!row) return null;
  const identity = guestIdentitySchema.parse(row.identity);
  if (
    identity.sshHostPublicKey !== input.sshHostPublicKey ||
    identity.tlsCsr !== input.tlsCsr ||
    identity.imageVersion !== input.imageVersion
  )
    throw new CloudError(
      'permission_denied',
      'Guest keys were already claimed by another enrollment.',
    );
  return identity;
}

/** The identity and its next lifecycle phase commit together; replay repairs an older handoff. */
async function handoffRuntime(tx: Transaction, context: Awaited<ReturnType<typeof loadBootstrap>>) {
  const changed = await tx
    .update(operations)
    .set({
      progress: { kind: 'waiting_guest', serverId: context.allocation.serverId, stage: 'runtime' },
    })
    .where(
      and(
        eq(operations.id, context.spec.operationId),
        eq(operations.accountId, context.spec.accountId),
        eq(operations.machineId, context.spec.machineId),
        sql`${operations.progress} = ${JSON.stringify({ kind: 'waiting_guest', serverId: context.allocation.serverId, stage: 'enrollment' })}::jsonb`,
      ),
    )
    .returning({ id: operations.id });
  if (!changed.length) return;
  await tx.insert(auditEvents).values({
    accountId: context.spec.accountId,
    subjectId: context.spec.operationId,
    event: 'guest.enrolled',
    details: {
      allocationId: context.spec.allocationId,
      imageVersion: context.spec.image.version,
    },
  });
  await enqueueOperation(tx, context.spec.operationId);
}

/** Persist before every signing effect. A crash consumes its slot even if no response was saved. */
async function reserveSigning(
  db: Database,
  input: Awaited<ReturnType<typeof loadBootstrap>>,
  purpose: 'probe' | 'identity',
) {
  await db.transaction(async (tx) => {
    await tx
      .select()
      .from(guestBootstraps)
      .where(eq(guestBootstraps.allocationId, input.spec.allocationId))
      .for('update');
    const [previous] = await tx
      .select()
      .from(guestSigningAttempts)
      .where(
        and(
          eq(guestSigningAttempts.allocationId, input.spec.allocationId),
          eq(guestSigningAttempts.purpose, purpose),
        ),
      )
      .orderBy(desc(guestSigningAttempts.sequence))
      .limit(1);
    const limit = purpose === 'probe' ? 12 : 4;
    if ((previous?.sequence ?? 0) >= limit)
      throw new CloudError(
        'quota_exceeded',
        'Guest signing attempt limit reached; operator recovery is required.',
      );
    if (previous && Date.now() - previous.createdAt.getTime() < 30_000)
      throw new CloudError(
        'resource_busy',
        'Guest signing retry must wait at least 30 seconds.',
        true,
      );
    await tx.insert(guestSigningAttempts).values({
      accountId: input.spec.accountId,
      allocationId: input.spec.allocationId,
      purpose,
      sequence: (previous?.sequence ?? 0) + 1,
    });
  });
}

export function createEnrollmentService(ports: EnrollmentPorts) {
  const credentials = new Map<AllocationId, ProbeCredential>();
  async function credential(db: Database, context: Awaited<ReturnType<typeof loadBootstrap>>) {
    for (const [id, current] of credentials)
      if (Date.parse(current.expiresAt) <= Date.now() + 15_000) credentials.delete(id);
    const current = credentials.get(context.spec.allocationId);
    if (current) return current;
    if (credentials.size >= 1024)
      throw new CloudError(
        'provider_unavailable',
        'Enrollment credential cache is at capacity.',
        true,
      );
    await reserveSigning(db, context, 'probe');
    const issued = await ports.signer.issueProbeCredential(context.spec.allocationId);
    credentials.set(context.spec.allocationId, issued);
    return issued;
  }
  async function enroll(value: GuestEnrollmentInput): Promise<IssuedGuestIdentity> {
    const input = guestEnrollmentInputSchema.parse(value);
    const initial = await loadBootstrap(ports.connection.db, ports.seal, input);
    const result = await withMachineLock({
      pool: ports.connection.pool,
      machineId: initial.spec.machineId,
      work: async (db) => {
        const context = await loadBootstrap(db, ports.seal, input);
        const identity = await readIdentity(db, input);
        if (identity?.kind === 'issued') {
          await db.transaction((tx) => handoffRuntime(tx, context));
          return identity;
        }
        if (context.bootstrap.consumedAt)
          throw new CloudError(
            'internal_error',
            'Consumed guest bootstrap has no issued identity.',
          );
        const [operation] = await db
          .select()
          .from(operations)
          .where(eq(operations.id, context.spec.operationId));
        if (!operation)
          throw new CloudError('internal_error', 'Guest create operation is missing.');
        const currentOperation = operationRecord(operation);
        if (
          currentOperation.kind !== 'machine.create' ||
          currentOperation.accountId !== context.spec.accountId ||
          currentOperation.machineId !== context.spec.machineId ||
          currentOperation.progress.kind === 'failed'
        )
          throw new CloudError(
            'permission_denied',
            'Guest create operation is no longer enrollable.',
          );
        if (
          currentOperation.progress.kind !== 'waiting_guest' ||
          currentOperation.progress.stage !== 'enrollment' ||
          currentOperation.progress.serverId !== context.allocation.serverId
        )
          throw new CloudError(
            'provider_unavailable',
            'Guest create has not reached confirmed enrollment.',
            true,
          );
        const history = await db
          .select()
          .from(attempts)
          .where(eq(attempts.operationId, currentOperation.id));
        const createAttempts = history.filter((attempt) =>
          isServerCreateCommand(providerCommandSchema.parse(attempt.command)),
        );
        const createAttempt = createAttempts[0];
        const resolution = createAttempt && effectResolutionSchema.parse(createAttempt.resolution);
        if (
          createAttempts.length !== 1 ||
          !resolution ||
          resolution.kind !== 'confirmed' ||
          resolution.observation.kind !== 'server' ||
          resolution.observation.server.id !== context.allocation.serverId
        )
          throw new CloudError(
            'provider_unavailable',
            'Guest VM submission is not authoritatively resolved.',
            true,
          );
        if (
          ports.signer.trust.sshHostCa !== context.spec.image.sshHostCa ||
          ports.signer.trust.sshUserCa !== context.spec.image.sshUserCa ||
          ports.signer.trust.tlsRoot.trim() !== context.spec.image.tlsRoot.trim()
        )
          throw new CloudError(
            'provider_unavailable',
            'The pinned image trust does not match the configured signer.',
          );
        const { address } = await observeGuest(db, ports.provider, context);
        await ports.signer.validateTlsRequest({
          allocationId: context.spec.allocationId,
          csr: input.tlsCsr,
        });
        const proof = await ports.probe.readIdentity({
          allocationId: context.spec.allocationId,
          address,
          trust: { kind: 'pinned_key', publicKey: input.sshHostPublicKey },
          credential: await credential(db, context),
        });
        if (
          proof.allocationId !== context.spec.allocationId ||
          proof.sshHostPublicKey !== input.sshHostPublicKey ||
          proof.tlsCsr !== input.tlsCsr ||
          proof.imageVersion !== input.imageVersion ||
          proof.manifestDigest !== context.spec.image.manifestDigest
        )
          throw new CloudError(
            'permission_denied',
            'Guest SSH proof does not match the enrollment proposal and image.',
          );
        // Re-read after external proof so expiry cannot be bypassed by a slow SSH connection.
        await loadBootstrap(db, ports.seal, input);
        if (!identity)
          await db.insert(guestIdentities).values({
            accountId: context.spec.accountId,
            allocationId: context.spec.allocationId,
            identity: {
              kind: 'claimed',
              sshHostPublicKey: input.sshHostPublicKey,
              tlsCsr: input.tlsCsr,
              imageVersion: input.imageVersion,
            },
          });
        await reserveSigning(db, context, 'identity');
        const sshHostCertificate = await ports.signer.signHost({
          allocationId: context.spec.allocationId,
          publicKey: input.sshHostPublicKey,
        });
        const tlsCertificate = await ports.signer.signTls({
          allocationId: context.spec.allocationId,
          csr: input.tlsCsr,
        });
        const issued = issuedGuestIdentitySchema.parse({
          kind: 'issued',
          sshHostPublicKey: input.sshHostPublicKey,
          tlsCsr: input.tlsCsr,
          imageVersion: input.imageVersion,
          sshHostCertificate,
          tlsCertificate,
          issuedAt: new Date().toISOString(),
        });
        await db.transaction(async (tx) => {
          await tx
            .select()
            .from(guestBootstraps)
            .where(eq(guestBootstraps.allocationId, context.spec.allocationId))
            .for('update');
          if (context.bootstrap.expiresAt.getTime() <= Date.now())
            throw new CloudError('unauthenticated', 'Guest bootstrap expired during issuance.');
          await tx
            .update(guestIdentities)
            .set({ identity: issued })
            .where(eq(guestIdentities.allocationId, context.spec.allocationId));
          await tx
            .update(guestBootstraps)
            .set({ consumedAt: new Date(), sealedToken: null })
            .where(eq(guestBootstraps.allocationId, context.spec.allocationId));
          await handoffRuntime(tx, context);
        });
        credentials.delete(context.spec.allocationId);
        return issued;
      },
    });
    if (result.kind === 'busy')
      throw new CloudError('resource_busy', 'Guest enrollment is already being processed.', true);
    return result.value;
  }
  return { enroll };
}
export type EnrollmentService = ReturnType<typeof createEnrollmentService>;

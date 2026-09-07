import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  CloudError,
  bootstrapSpecSchema,
  guestIdentitySchema,
  guestRuntimeSchema,
  type Operation,
  type Machine,
  type ProviderServer,
  type GuestVerification,
} from '@agent-cloud/contracts';
import {
  guestBootstraps,
  guestIdentities,
  operations,
  runtimeSigningAttempts,
  type Database,
} from '@agent-cloud/db';
import type { Signer, ProbeCredential } from '@agent-cloud/pki';
import type { createGuestProbe } from '@agent-cloud/remote';
import type { MachineProvider, OperationId } from '@agent-cloud/contracts';
import type { Allocation } from './resource-journal.js';
import { observeGuest } from './guest-observation.js';

export type RuntimeDecision =
  | {
      kind: 'ready';
      server: ProviderServer;
      verification: Extract<GuestVerification, { kind: 'ssh' }>;
    }
  | { kind: 'waiting' }
  | {
      kind: 'blocked';
      reason: 'guest_identity_mismatch' | 'guest_deadline_exceeded' | 'guest_signing_exhausted';
    };
export type RuntimeInput = {
  db: Database;
  operation: Operation;
  machine: Machine;
  allocation: Allocation;
};
export type GuestReadiness = { check: (input: RuntimeInput) => Promise<RuntimeDecision> };

async function reserve(input: RuntimeInput) {
  return input.db.transaction(async (tx) => {
    await tx.select().from(operations).where(eq(operations.id, input.operation.id)).for('update');
    const [last] = await tx
      .select({
        sequence: runtimeSigningAttempts.sequence,
        coolingDown: sql<boolean>`${runtimeSigningAttempts.createdAt} + interval '30 seconds' > now()`,
      })
      .from(runtimeSigningAttempts)
      .where(eq(runtimeSigningAttempts.operationId, input.operation.id))
      .orderBy(desc(runtimeSigningAttempts.sequence))
      .limit(1);
    if ((last?.sequence ?? 0) >= 12) return 'exhausted';
    if (last?.coolingDown) return 'cooldown';
    await tx.insert(runtimeSigningAttempts).values({
      accountId: input.allocation.accountId,
      allocationId: input.allocation.id,
      operationId: input.operation.id,
      sequence: (last?.sequence ?? 0) + 1,
    });
    return 'reserved';
  });
}

/** Called under the controller's machine lock. Reads and signing never hold a DB transaction open. */
export function createGuestReadiness(ports: {
  provider: MachineProvider;
  signer: Pick<Signer, 'issueRuntimeCredential'>;
  probe: Pick<ReturnType<typeof createGuestProbe>, 'readRuntime'>;
}): GuestReadiness {
  const credentials = new Map<OperationId, ProbeCredential<'runtime'>>();
  return {
    check: async (input) => {
      const { db, operation, allocation, machine } = input;
      const [clock] = await db
        .select({ expired: sql<boolean>`${operations.createdAt} + interval '30 minutes' <= now()` })
        .from(operations)
        .where(
          and(
            eq(operations.id, operation.id),
            eq(operations.accountId, allocation.accountId),
            eq(operations.machineId, allocation.machineId),
          ),
        );
      if (!clock)
        throw new CloudError('internal_error', 'Runtime operation ownership is inconsistent.');
      if (clock.expired) {
        credentials.delete(operation.id);
        return { kind: 'blocked', reason: 'guest_deadline_exceeded' };
      }
      const [bootstrap] = await db
        .select()
        .from(guestBootstraps)
        .where(eq(guestBootstraps.allocationId, allocation.id));
      const [row] = await db
        .select()
        .from(guestIdentities)
        .where(eq(guestIdentities.allocationId, allocation.id));
      if (!bootstrap || !row) return { kind: 'waiting' };
      const identity = guestIdentitySchema.parse(row.identity);
      if (identity.kind !== 'issued') return { kind: 'waiting' };
      const spec = bootstrapSpecSchema.parse(bootstrap.spec);
      if (
        spec.accountId !== allocation.accountId ||
        spec.allocationId !== allocation.id ||
        spec.machineId !== allocation.machineId ||
        spec.operationId !== bootstrap.operationId
      )
        return { kind: 'blocked', reason: 'guest_identity_mismatch' };
      try {
        const observed = await observeGuest(db, ports.provider, { allocation, spec });
        for (const [id, credential] of credentials)
          if (Date.parse(credential.expiresAt) <= Date.now() + 35_000) credentials.delete(id);
        let credential = credentials.get(operation.id);
        if (!credential) {
          if (credentials.size >= 1024) return { kind: 'waiting' };
          const reserved = await reserve(input);
          if (reserved === 'exhausted')
            return { kind: 'blocked', reason: 'guest_signing_exhausted' };
          if (reserved === 'cooldown') return { kind: 'waiting' };
          credential = await ports.signer.issueRuntimeCredential(spec.allocationId);
          credentials.set(operation.id, credential);
        }
        const runtime = guestRuntimeSchema.parse(
          await ports.probe.readRuntime({
            allocationId: spec.allocationId,
            address: observed.address,
            credential,
            trust: { kind: 'host_ca', publicKey: spec.image.sshHostCa },
          }),
        );
        const { proof, manifest, checks } = runtime;
        const digest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
        if (
          proof.allocationId !== spec.allocationId ||
          proof.sshHostPublicKey !== identity.sshHostPublicKey ||
          proof.tlsCsr !== identity.tlsCsr ||
          proof.imageVersion !== identity.imageVersion ||
          proof.imageVersion !== spec.image.version ||
          proof.manifestDigest !== spec.image.manifestDigest ||
          digest !== spec.image.manifestDigest ||
          manifest.version !== spec.image.version ||
          runtime.architecture !== spec.image.architecture ||
          manifest.architecture !== runtime.architecture
        )
          return { kind: 'blocked', reason: 'guest_identity_mismatch' };
        for (const name of ['node', 'docker', 'compose', 'caddy', 'step'] satisfies Array<
          keyof typeof checks
        >) {
          const check = checks[name];
          if (check.kind !== 'ok' || check.version !== manifest.components[name])
            return { kind: 'waiting' };
        }
        if (
          checks.disk.kind !== 'ok' ||
          checks.disk.availableBytes < 1024 * 1024 * 1024 ||
          checks.disk.availableBytes > checks.disk.totalBytes ||
          checks.proxy.kind !== 'ok' ||
          checks.proxy.allocationId !== spec.allocationId ||
          checks.proxy.imageVersion !== spec.image.version
        )
          return { kind: 'waiting' };
        if (
          (operation.kind === 'machine.reboot' || operation.kind === 'machine.power_on') &&
          machine.state.kind === 'allocated' &&
          machine.state.guest.kind === 'ssh' &&
          machine.state.guest.bootId === runtime.bootId
        )
          return { kind: 'waiting' };
        return {
          kind: 'ready',
          server: observed.server,
          verification: {
            kind: 'ssh',
            verifiedAt: new Date().toISOString(),
            imageVersion: spec.image.version,
            manifestDigest: digest,
            bootId: runtime.bootId,
          },
        };
      } catch (error) {
        if (error instanceof CloudError && error.failure.retryable) return { kind: 'waiting' };
        throw error;
      }
    },
  };
}

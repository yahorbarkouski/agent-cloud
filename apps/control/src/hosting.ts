import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  CloudError,
  routeSchema,
  hostingSnapshotSchema,
  hostnameSchema,
  machineIdSchema,
  allocationIdSchema,
  type HostingControlConfig,
  type Principal,
  type RoutePublish,
  type RouteRemove,
} from '@agent-cloud/contracts';
import {
  auditEvents,
  hostingRoutes,
  hostingCommands,
  domainChallenges,
  machines,
  machineRecord,
  databaseTime,
  type Database,
} from '@agent-cloud/db';
import { authorize, loadAuthority } from './auth.js';
import { lockAccount } from './lifecycle.js';
import { assertRestoreAccessible } from './backups.js';
import { createHostingDomains, type resolveDomain } from './hosting-domains.js';

export const hostingTargetSchema = z.strictObject({
  address: z.union([z.ipv4(), z.ipv6()]),
  serverName: hostnameSchema,
});
type Route = z.infer<typeof routeSchema>;
type Target = z.infer<typeof hostingTargetSchema>;
const appliedTargetSchema = hostingTargetSchema.extend({
  machineId: machineIdSchema,
  allocationId: allocationIdSchema,
  version: z.int().positive(),
});
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const routeRecord = (row: typeof hostingRoutes.$inferSelect) => {
  const record = routeSchema.parse(row.record);
  if (
    record.hostname !== row.hostname ||
    record.accountId !== row.accountId ||
    record.projectId !== row.projectId ||
    record.machineId !== row.machineId
  )
    throw new Error('Hosting route ownership disagrees with its record.');
  return record;
};
async function enqueue(db: Database, hostname: string) {
  await db.execute(
    sql`SELECT graphile_worker.add_job('apply_hosting_route', ${JSON.stringify({ hostname })}::json, job_key := ${`hosting:${hostname}`}, max_attempts := 10)`,
  );
}

/** Desired routes are admitted here; guest changes and public gateway acknowledgement are separate effects. */
export function createHosting(input: {
  db: Database;
  config: HostingControlConfig;
  reservedHostnames?: readonly string[];
  resolve?: typeof resolveDomain;
  applyGuest?: (route: Route) => Promise<Target | null>;
}) {
  const domains = createHostingDomains(input);
  async function list(principal: Principal) {
    const rows = await input.db
      .select()
      .from(hostingRoutes)
      .where(eq(hostingRoutes.accountId, principal.accountId))
      .limit(100);
    return rows.map(routeRecord).filter((route) => {
      try {
        authorize(principal, 'machine:read', route.projectId);
        return true;
      } catch (error) {
        if (error instanceof CloudError && error.failure.code === 'permission_denied') return false;
        throw error;
      }
    });
  }
  async function inspect(principal: Principal, hostname: string) {
    const [row] = await input.db
      .select()
      .from(hostingRoutes)
      .where(
        and(eq(hostingRoutes.hostname, hostname), eq(hostingRoutes.accountId, principal.accountId)),
      );
    if (!row) throw new CloudError('not_found', 'Route not found.');
    const route = routeRecord(row);
    authorize(principal, 'machine:read', route.projectId);
    return route;
  }
  async function mutate(
    principal: Principal,
    command:
      | { kind: 'publish'; request: RoutePublish }
      | { kind: 'remove'; hostname: string; request: RouteRemove },
  ) {
    if (
      command.kind === 'publish' &&
      command.request.destination.kind === 'existing' &&
      command.request.expectedVersion === null
    )
      throw new CloudError(
        'invalid_input',
        'Moving an existing route requires its explicit current version.',
      );
    const requestHash = digest(command);
    return input.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hosting-command:${command.request.commandId}`}, 0))`,
      );
      await lockAccount(tx, principal);
      const authority = await loadAuthority(tx, principal.grantId);
      const [receipt] = await tx
        .select()
        .from(hostingCommands)
        .where(eq(hostingCommands.id, command.request.commandId));
      if (receipt) {
        if (receipt.accountId !== principal.accountId || receipt.digest !== requestHash)
          throw new CloudError(
            'idempotency_conflict',
            'Route command ID belongs to a different request.',
          );
        const [row] = await tx
          .select()
          .from(hostingRoutes)
          .where(eq(hostingRoutes.hostname, receipt.hostname));
        if (!row) throw new Error('Recorded route is missing.');
        const route = routeRecord(row);
        authorize(authority.principal, 'route:publish', route.projectId);
        if (route.version !== receipt.version)
          throw new CloudError(
            'version_conflict',
            `Route command admitted version ${receipt.version}, which has been superseded by version ${route.version}. Inspect the hostname for current state.`,
          );
        return route;
      }
      let hostname: string;
      let destination:
        | {
            machineId: Route['machineId'];
            projectId: Route['projectId'];
            allocationId: Route['allocationId'];
            port: number;
          }
        | undefined;
      if (command.kind === 'publish') {
        const [row] = await tx
          .select()
          .from(machines)
          .where(
            and(
              eq(machines.id, command.request.machineId),
              eq(machines.accountId, principal.accountId),
            ),
          );
        if (!row) throw new CloudError('not_found', 'Machine not found.');
        const machine = machineRecord(row);
        authorize(authority.principal, 'route:publish', machine.projectId);
        await assertRestoreAccessible(tx, machine.id);
        if (machine.state.kind !== 'allocated' || machine.state.guest.kind !== 'ssh')
          throw new CloudError(
            'resource_busy',
            'Routes require an allocated machine with verified guest identity.',
          );
        destination = {
          machineId: machine.id,
          projectId: machine.projectId,
          allocationId: machine.state.allocationId,
          port: command.request.port,
        };
        const desired = command.request.destination;
        hostname =
          desired.kind === 'generated'
            ? hostnameSchema.parse(
                `${desired.name}-${machine.id.slice(3).replaceAll('-', '')}.${input.config.applicationDomain}`,
              )
            : desired.hostname;
        if (input.reservedHostnames?.includes(hostname))
          throw new CloudError(
            'permission_denied',
            'This hostname belongs to the cloud control service.',
          );
        if (desired.kind === 'custom') {
          if (
            hostname === input.config.applicationDomain ||
            hostname.endsWith(`.${input.config.applicationDomain}`)
          )
            throw new CloudError(
              'permission_denied',
              'Application hostnames must be generated by the cloud.',
            );
          const [challenge] = await tx
            .select()
            .from(domainChallenges)
            .where(
              and(
                eq(domainChallenges.id, desired.challengeId),
                eq(domainChallenges.accountId, principal.accountId),
                eq(domainChallenges.hostname, hostname),
              ),
            );
          if (!challenge?.verifiedAt || challenge.expiresAt <= authority.checkedAt)
            throw new CloudError(
              'permission_denied',
              'Custom routes need a fresh verified domain challenge for this account.',
            );
        }
      } else hostname = command.hostname;
      // Account locks serialize owners; the unique hostname is also locked across foreign claims.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hosting-name:${hostname}`}, 0))`,
      );
      const [existing] = await tx
        .select()
        .from(hostingRoutes)
        .where(eq(hostingRoutes.hostname, hostname));
      if (existing && existing.accountId !== principal.accountId)
        throw new CloudError(
          'permission_denied',
          'This hostname remains reserved to another account. Its operator must resolve ownership before reassignment.',
        );
      const previous = existing ? routeRecord(existing) : undefined;
      if (
        !previous &&
        command.kind === 'publish' &&
        command.request.destination.kind === 'existing'
      )
        throw new CloudError('not_found', 'Only a retained account-owned route can be moved.');
      if (previous) authorize(authority.principal, 'route:publish', previous.projectId);
      if ((previous?.version ?? null) !== command.request.expectedVersion)
        throw new CloudError('version_conflict', 'Route changed; inspect its current version.');
      const now = authority.checkedAt.toISOString();
      if (!previous && !destination) throw new CloudError('not_found', 'Route not found.');
      const chosen = destination ?? previous;
      if (!chosen) throw new Error('Missing route destination.');
      if (!previous) {
        const owned = await tx
          .select({ hostname: hostingRoutes.hostname })
          .from(hostingRoutes)
          .where(eq(hostingRoutes.accountId, principal.accountId))
          .limit(100);
        if (owned.length >= 100)
          throw new CloudError(
            'quota_exceeded',
            'An account can reserve at most one hundred route names.',
          );
      }
      const recent = await tx
        .select({ id: hostingCommands.id })
        .from(hostingCommands)
        .where(
          and(
            eq(hostingCommands.accountId, principal.accountId),
            sql`${hostingCommands.createdAt} > clock_timestamp() - interval '1 hour'`,
          ),
        )
        .limit(100);
      if (recent.length >= 100)
        throw new CloudError(
          'quota_exceeded',
          'Route changes are limited to one hundred per account per hour.',
        );
      const route = routeSchema.parse({
        hostname,
        accountId: principal.accountId,
        machineId: chosen.machineId,
        projectId: chosen.projectId,
        allocationId: chosen.allocationId,
        port: chosen.port,
        version: (previous?.version ?? 0) + 1,
        state: command.kind === 'remove' ? 'removed' : 'pending',
        appliedVersion: previous?.appliedVersion ?? null,
        gatewayAppliedVersion: previous?.gatewayAppliedVersion ?? null,
        application: { kind: 'pending', attempts: 0 },
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      });
      await tx
        .insert(hostingRoutes)
        .values({
          hostname,
          accountId: principal.accountId,
          machineId: route.machineId,
          projectId: route.projectId,
          record: route,
        })
        .onConflictDoUpdate({
          target: hostingRoutes.hostname,
          set: { machineId: route.machineId, projectId: route.projectId, record: route },
        });
      await tx.insert(hostingCommands).values({
        id: command.request.commandId,
        accountId: principal.accountId,
        hostname,
        digest: requestHash,
        version: route.version,
      });
      await tx.insert(auditEvents).values({
        accountId: principal.accountId,
        subjectId: hostname,
        event: command.kind === 'publish' ? 'route.published' : 'route.removed',
        details: {
          grantId: principal.grantId,
          commandId: command.request.commandId,
          machineId: route.machineId,
          version: route.version,
          port: route.port,
        },
      });
      await enqueue(tx, hostname);
      return route;
    });
  }
  async function advance(hostname: string) {
    if (!input.applyGuest) throw new Error('Hosting guest transport is not configured.');
    const route = await input.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(hostingRoutes)
        .where(eq(hostingRoutes.hostname, hostname))
        .for('update');
      if (!row) return;
      const current = routeRecord(row);
      if (current.application.kind !== 'pending') return;
      if (current.application.attempts === 5) {
        await tx
          .update(hostingRoutes)
          .set({ record: { ...current, application: { kind: 'blocked', attempts: 5 } } })
          .where(eq(hostingRoutes.hostname, hostname));
        return;
      }
      const claimed = routeSchema.parse({
        ...current,
        application: { kind: 'pending', attempts: current.application.attempts + 1 },
      });
      // Persist the bounded attempt before issuing any remote credential or command.
      await tx
        .update(hostingRoutes)
        .set({ record: claimed })
        .where(eq(hostingRoutes.hostname, hostname));
      return claimed;
    });
    if (!route) return;
    let target: Target | null;
    try {
      const applied = await input.applyGuest(route);
      target = applied === null ? null : hostingTargetSchema.parse(applied);
      if (target === null && route.state !== 'removed')
        throw new Error('An active route requires a guest target.');
    } catch (error) {
      await input.db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(hostingRoutes)
          .where(eq(hostingRoutes.hostname, hostname))
          .for('update');
        if (!row) return;
        const current = routeRecord(row);
        if (
          current.version === route.version &&
          current.application.kind === 'pending' &&
          current.application.attempts === 5
        )
          await tx
            .update(hostingRoutes)
            .set({ record: { ...current, application: { kind: 'blocked', attempts: 5 } } })
            .where(eq(hostingRoutes.hostname, hostname));
      });
      throw error;
    }
    await input.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(hostingRoutes)
        .where(eq(hostingRoutes.hostname, hostname))
        .for('update');
      if (!current) return;
      const latest = routeRecord(current);
      if (latest.version !== route.version) return;
      await tx
        .update(hostingRoutes)
        .set({
          target:
            target === null
              ? null
              : {
                  ...target,
                  machineId: route.machineId,
                  allocationId: route.allocationId,
                  version: route.version,
                },
          record: {
            ...latest,
            state: route.state === 'removed' ? 'removed' : 'active',
            application: { kind: 'applied' },
            appliedVersion: route.version,
          },
        })
        .where(eq(hostingRoutes.hostname, hostname));
    });
  }
  async function gatewayState() {
    const rows = await input.db
      .select({ route: hostingRoutes, machine: machines })
      .from(hostingRoutes)
      .leftJoin(machines, sql`${machines.id} = ${hostingRoutes.target}->>'machineId'`)
      .orderBy(hostingRoutes.hostname);
    const versions = new Map<string, number>();
    const fingerprint: unknown[] = [];
    const live: Array<{ hostname: string; address: string; serverName: string; version: number }> =
      [];
    for (const { route: row, machine: machineRow } of rows) {
      const route = routeRecord(row);
      if (route.state === 'removed') {
        versions.set(route.hostname, route.version);
        fingerprint.push({ hostname: route.hostname, version: route.version, removed: true });
        continue;
      }
      if (!row.target || !machineRow) continue;
      const target = appliedTargetSchema.parse(row.target);
      const machine = machineRecord(machineRow);
      if (machine.state.kind !== 'allocated' || machine.state.allocationId !== target.allocationId)
        continue;
      // A queued or failed update retains its earlier working target until a new apply succeeds.
      const entry = {
        hostname: route.hostname,
        address: target.address,
        serverName: target.serverName,
        version: target.version,
      };
      live.push(entry);
      versions.set(route.hostname, target.version);
      fingerprint.push({ ...entry, version: target.version });
    }
    return {
      snapshot: hostingSnapshotSchema.parse({ revision: digest(fingerprint), routes: live }),
      versions,
    };
  }
  async function snapshot() {
    return (await gatewayState()).snapshot;
  }
  async function acknowledge(revision: string) {
    const current = await gatewayState();
    if (current.snapshot.revision !== revision)
      throw new CloudError(
        'version_conflict',
        'Gateway configuration was superseded. Fetch the current snapshot.',
      );
    for (const [hostname, version] of current.versions)
      await input.db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(hostingRoutes)
          .where(eq(hostingRoutes.hostname, hostname))
          .for('update');
        if (!row) return;
        const latest = routeRecord(row);
        if ((latest.gatewayAppliedVersion ?? 0) >= version) return;
        await tx
          .update(hostingRoutes)
          .set({ record: { ...latest, gatewayAppliedVersion: version } })
          .where(eq(hostingRoutes.hostname, hostname));
      });
    return { revision, appliedAt: (await databaseTime(input.db)).toISOString() };
  }
  return {
    domains,
    list,
    inspect,
    publish: (principal: Principal, request: RoutePublish) =>
      mutate(principal, { kind: 'publish', request }),
    remove: (principal: Principal, hostname: string, request: RouteRemove) =>
      mutate(principal, { kind: 'remove', hostname, request }),
    advance,
    snapshot,
    acknowledge,
  };
}
export type HostingService = ReturnType<typeof createHosting>;

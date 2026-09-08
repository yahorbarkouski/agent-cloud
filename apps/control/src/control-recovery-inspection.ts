import { createHash } from 'node:crypto';
import { asc } from 'drizzle-orm';
import {
  attemptOutcomeSchema,
  catalogItemSchema,
  effectResolutionSchema,
  imageBuildStateSchema,
  imageBuildIdSchema,
  imageEffectLabels,
  imageEffectOutcomeSchema,
  imageEffectResolutionSchema,
  imageResourceKindSchema,
  imageResourceRoleSchema,
  imageResourceStateSchema,
  isOperationTerminal,
  allocationIdSchema,
  machineIdSchema,
  routeSchema,
  type ImageProvider,
} from '@agent-cloud/contracts';
import {
  allocations,
  attempts,
  backupPurges,
  backupRestores,
  backupSchedules,
  backups,
  hostingRoutes,
  imageBuildEffects,
  imageBuildResources,
  imageBuilds,
  imagePublications,
  machineRecord,
  machines,
  operationRecord,
  operations,
  providerResources,
  type Database,
} from '@agent-cloud/db';
import {
  backupRecord,
  backupWorkSchema,
  restoreRecord,
  restoreWorkSchema,
} from './backup-records.js';
import { hostingTargetSchema } from './hosting.js';
import type { RecoveryProvider } from './operator-recovery.js';
import { matchesLabels, ownedLabels } from './resource-journal.js';

const MAX_ROWS = 1_000;
const managedLabels = { managed_by: 'agent-cloud' } satisfies Readonly<Record<string, string>>;

export type ControlRecoveryBlocker = { domain: string; id: string; reason: string };
export type RecoveryVerification = Readonly<{ ok: boolean; evidenceDigest: string }>;
export type ImageRecoveryVerifier = (
  input: Readonly<{
    buildId: string;
    admission: (typeof imageBuilds.$inferSelect)['admission'];
    state: ReturnType<typeof imageBuildStateSchema.parse>;
    publication: typeof imagePublications.$inferSelect | undefined;
    resources: readonly (typeof imageBuildResources.$inferSelect)[];
  }>,
) => Promise<RecoveryVerification>;
export type BackupRecoveryVerifier = (
  input: Readonly<{
    backupId: string;
    accountId: string;
    record: ReturnType<typeof backupRecord>;
    work: ReturnType<typeof backupWorkSchema.parse>;
  }>,
) => Promise<RecoveryVerification>;

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}
const digest = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');

function push(blockers: ControlRecoveryBlocker[], domain: string, id: string, reason: string) {
  blockers.push({ domain, id, reason });
}

async function bounded<T>(rows: Promise<T[]>, blockers: ControlRecoveryBlocker[], domain: string) {
  const value = await rows;
  if (value.length > MAX_ROWS)
    push(blockers, domain, '*', `Inspection exceeds the ${MAX_ROWS}-row recovery bound.`);
  return value.slice(0, MAX_ROWS);
}

/** Read-only, fail-closed inspection. Callers must hold the control recovery execution lease. */
export async function inspectControlRecovery(input: {
  db: Database;
  provider: RecoveryProvider;
  imageInventory?: Pick<ImageProvider, 'get' | 'find'>;
  verifyImage?: ImageRecoveryVerifier;
  verifyBackup?: BackupRecoveryVerifier;
}) {
  const blockers: ControlRecoveryBlocker[] = [];
  const machineRows = await bounded(
    input.db
      .select()
      .from(machines)
      .orderBy(asc(machines.id))
      .limit(MAX_ROWS + 1),
    blockers,
    'machines',
  );
  const allocationRows = await bounded(
    input.db
      .select()
      .from(allocations)
      .orderBy(asc(allocations.id))
      .limit(MAX_ROWS + 1),
    blockers,
    'allocations',
  );
  const operationRows = await bounded(
    input.db
      .select()
      .from(operations)
      .orderBy(asc(operations.id))
      .limit(MAX_ROWS + 1),
    blockers,
    'operations',
  );
  const attemptRows = await bounded(
    input.db
      .select()
      .from(attempts)
      .orderBy(asc(attempts.id))
      .limit(MAX_ROWS + 1),
    blockers,
    'operations',
  );
  const resourceRows = await bounded(
    input.db
      .select()
      .from(providerResources)
      .orderBy(asc(providerResources.kind), asc(providerResources.providerId))
      .limit(MAX_ROWS + 1),
    blockers,
    'inventory',
  );
  const machineById = new Map(machineRows.map((row) => [row.id, machineRecord(row)]));
  const allocationById = new Map(allocationRows.map((row) => [row.id, row]));

  for (const row of operationRows) {
    const operation = operationRecord(row);
    if (!isOperationTerminal(operation))
      push(blockers, 'operations', operation.id, `Operation remains ${operation.progress.kind}.`);
  }
  for (const row of attemptRows) {
    attemptOutcomeSchema.parse(row.outcome);
    if (effectResolutionSchema.parse(row.resolution).kind === 'pending')
      push(blockers, 'operations', row.id, 'Provider attempt resolution remains pending.');
  }

  for (const machine of machineById.values()) {
    if (machine.state.kind === 'allocated') {
      const allocationId = machine.state.allocationId;
      if (
        !allocationRows.some(
          (allocation) =>
            allocation.id === allocationId &&
            allocation.machineId === machine.id &&
            !allocation.retiredAt,
        )
      )
        push(
          blockers,
          'machines',
          machine.id,
          'Allocated machine has no matching live allocation.',
        );
    }
  }

  const observations: unknown[] = [];
  for (const resource of resourceRows) {
    if (resource.provider !== input.provider.kind) {
      push(
        blockers,
        'inventory',
        `${resource.kind}:${resource.providerId}`,
        'Resource provider differs from the configured recovery provider.',
      );
      continue;
    }
    const observed =
      resource.kind === 'server'
        ? await input.provider.getServer({ serverId: resource.providerId })
        : await input.provider.getPrimaryIp({ primaryIpId: resource.providerId });
    observations.push({ kind: resource.kind, ledgerId: resource.providerId, value: observed });
    if (resource.absentAt && observed)
      push(
        blockers,
        'inventory',
        `${resource.kind}:${resource.providerId}`,
        'Tombstoned provider resource still exists.',
      );
    if (!resource.absentAt && !observed)
      push(
        blockers,
        'inventory',
        `${resource.kind}:${resource.providerId}`,
        'Live provider resource is absent.',
      );
    if (observed && !matchesLabels(observed.labels, ownedLabels(resource)))
      push(
        blockers,
        'inventory',
        `${resource.kind}:${resource.providerId}`,
        'Exact provider resource ownership labels changed.',
      );
  }
  for (const allocation of allocationRows) {
    const machine = machineById.get(allocation.machineId);
    const owned = resourceRows.filter((row) => row.allocationId === allocation.id);
    if (allocation.retiredAt) {
      for (const resource of owned)
        if (!resource.absentAt)
          push(
            blockers,
            'allocations',
            allocation.id,
            `Retired allocation retains live ${resource.kind} ${resource.providerId}.`,
          );
      continue;
    }
    if (
      !machine ||
      machine.accountId !== allocation.accountId ||
      machine.state.kind !== 'allocated' ||
      machine.state.allocationId !== allocation.id ||
      machine.state.serverId !== allocation.serverId ||
      allocation.provider !== input.provider.kind
    ) {
      push(
        blockers,
        'allocations',
        allocation.id,
        'Live allocation and allocated machine identity do not agree.',
      );
      continue;
    }
    const serverResource = owned.find(
      (row) =>
        row.provider === allocation.provider &&
        row.kind === 'server' &&
        row.providerId === allocation.serverId &&
        !row.absentAt,
    );
    const server = allocation.serverId
      ? await input.provider.getServer({ serverId: allocation.serverId })
      : null;
    observations.push({ allocationId: allocation.id, kind: 'server', value: server });
    const offer = allocation.offer ? catalogItemSchema.safeParse(allocation.offer) : undefined;
    if (
      !serverResource ||
      !server ||
      server.id !== allocation.serverId ||
      !matchesLabels(server.labels, ownedLabels(serverResource)) ||
      !offer?.success ||
      server.serverType !== offer.data.serverType ||
      server.region !== offer.data.region
    ) {
      push(
        blockers,
        'allocations',
        allocation.id,
        'Exact live server identity, labels, type, or region do not match.',
      );
      continue;
    }
    const ipResources = owned.filter(
      (row) => row.provider === allocation.provider && row.kind === 'primary_ip' && !row.absentAt,
    );
    if (ipResources.length > 1)
      push(
        blockers,
        'allocations',
        allocation.id,
        'Live allocation has multiple owned primary IPs.',
      );
    const ipResource = ipResources[0];
    if (ipResource) {
      const ip = await input.provider.getPrimaryIp({ primaryIpId: ipResource.providerId });
      observations.push({ allocationId: allocation.id, kind: 'primary_ip', value: ip });
      if (
        !ip ||
        ip.id !== ipResource.providerId ||
        !matchesLabels(ip.labels, ownedLabels(ipResource)) ||
        ip.region !== offer.data.region ||
        ip.assignment.kind !== 'server' ||
        ip.assignment.serverId !== server.id ||
        server.primaryIpId !== ip.id
      )
        push(
          blockers,
          'allocations',
          allocation.id,
          'Exact owned primary IP assignment does not match the server.',
        );
    } else if (allocation.networkProfile === 'managed_ipv4' || server.primaryIpId)
      push(
        blockers,
        'allocations',
        allocation.id,
        'Managed server is missing its owned primary IP ledger.',
      );
  }

  const [foundServers, foundIps] = await Promise.all([
    input.provider.findServers({ labels: managedLabels }),
    input.provider.findPrimaryIps({ labels: managedLabels }),
  ]);
  if (foundServers.length > MAX_ROWS || foundIps.length > MAX_ROWS)
    push(
      blockers,
      'inventory',
      '*',
      `Provider inventory exceeds the ${MAX_ROWS}-resource recovery bound.`,
    );
  for (const item of [...foundServers.slice(0, MAX_ROWS), ...foundIps.slice(0, MAX_ROWS)]) {
    const kind = 'assignment' in item ? 'primary_ip' : 'server';
    observations.push({ kind, value: item });
    const known = resourceRows.find(
      (row) =>
        row.provider === input.provider.kind &&
        row.kind === kind &&
        row.providerId === item.id &&
        !row.absentAt,
    );
    if (!known || !matchesLabels(item.labels, ownedLabels(known)))
      push(
        blockers,
        'inventory',
        `${kind}:${item.id}`,
        'Managed provider resource is unknown or conflicts with the retained ledger.',
      );
  }

  const hostingRows = await bounded(
    input.db
      .select()
      .from(hostingRoutes)
      .orderBy(asc(hostingRoutes.hostname))
      .limit(MAX_ROWS + 1),
    blockers,
    'hosting',
  );
  for (const row of hostingRows) {
    const route = routeSchema.safeParse(row.record);
    if (!route.success) {
      push(blockers, 'hosting', row.hostname, 'Hosting route record is invalid.');
      continue;
    }
    const value = route.data;
    if (
      value.application.kind !== 'applied' ||
      value.appliedVersion !== value.version ||
      value.gatewayAppliedVersion !== value.version
    ) {
      push(blockers, 'hosting', row.hostname, 'Hosting route is not fully converged.');
      continue;
    }
    if (value.state === 'active') {
      const target = hostingTargetSchema
        .extend({
          machineId: machineIdSchema,
          allocationId: allocationIdSchema,
          version: routeSchema.shape.version,
        })
        .safeParse(row.target);
      const allocation = allocationById.get(value.allocationId);
      const machine = machineById.get(value.machineId);
      if (
        !target.success ||
        target.data.machineId !== value.machineId ||
        target.data.allocationId !== value.allocationId ||
        target.data.version !== value.version ||
        !allocation ||
        allocation.retiredAt ||
        machine?.state.kind !== 'allocated'
      )
        push(
          blockers,
          'hosting',
          row.hostname,
          'Active route target is not bound to a validated live allocation.',
        );
    } else if (value.state !== 'removed' || row.target !== null)
      push(
        blockers,
        'hosting',
        row.hostname,
        'Only converged active or fully removed routes may resume.',
      );
  }

  const backupRows = await bounded(
    input.db
      .select()
      .from(backups)
      .orderBy(asc(backups.id))
      .limit(MAX_ROWS + 1),
    blockers,
    'backups',
  );
  const restoreRows = await bounded(
    input.db
      .select()
      .from(backupRestores)
      .orderBy(asc(backupRestores.id))
      .limit(MAX_ROWS + 1),
    blockers,
    'backups',
  );
  const purgeRows = await bounded(
    input.db
      .select()
      .from(backupPurges)
      .orderBy(asc(backupPurges.id))
      .limit(MAX_ROWS + 1),
    blockers,
    'backups',
  );
  const scheduleRows = await bounded(
    input.db
      .select()
      .from(backupSchedules)
      .orderBy(asc(backupSchedules.id))
      .limit(MAX_ROWS + 1),
    blockers,
    'backups',
  );
  const backupEvidence: unknown[] = [];
  for (const row of backupRows) {
    const record = backupRecord(row);
    const work = backupWorkSchema.parse(row.work);
    const stable =
      (record.state.kind === 'captured' &&
        work.kind === 'stored' &&
        work.guestCleanup === 'done') ||
      record.state.kind === 'purged';
    if (!stable)
      push(blockers, 'backups', row.id, `Backup remains ${record.state.kind}/${work.kind}.`);
    else if (record.state.kind === 'captured') {
      if (!input.verifyBackup)
        push(blockers, 'backups', row.id, 'Captured backup lacks read-only object verification.');
      else {
        const verified = await input.verifyBackup({
          backupId: row.id,
          accountId: row.accountId,
          record,
          work,
        });
        backupEvidence.push({ id: row.id, ...verified });
        if (!verified.ok || !/^[0-9a-f]{64}$/.test(verified.evidenceDigest))
          push(blockers, 'backups', row.id, 'Captured backup object verification failed.');
      }
    }
  }
  for (const row of restoreRows) {
    const record = restoreRecord(row);
    const work = restoreWorkSchema.parse(row.work);
    if (record.state.kind !== 'restored' || work.kind !== 'done')
      push(blockers, 'backups', row.id, `Restore remains ${record.state.kind}/${work.kind}.`);
  }
  for (const row of purgeRows) {
    const record =
      row.record && typeof row.record === 'object' && 'state' in row.record
        ? row.record.state
        : undefined;
    if (!record || typeof record !== 'object' || !('kind' in record) || record.kind !== 'purged')
      push(blockers, 'backups', row.id, 'Backup purge is not terminal.');
  }
  for (const row of scheduleRows)
    if (!row.disabledAt)
      push(blockers, 'backups', row.id, 'Restored backup schedule remains enabled.');

  const buildRows = await bounded(
    input.db
      .select()
      .from(imageBuilds)
      .orderBy(asc(imageBuilds.id))
      .limit(MAX_ROWS + 1),
    blockers,
    'images',
  );
  const effectRows = await bounded(
    input.db
      .select()
      .from(imageBuildEffects)
      .orderBy(asc(imageBuildEffects.id))
      .limit(MAX_ROWS + 1),
    blockers,
    'images',
  );
  const buildResourceRows = await bounded(
    input.db
      .select()
      .from(imageBuildResources)
      .orderBy(asc(imageBuildResources.buildId), asc(imageBuildResources.providerId))
      .limit(MAX_ROWS + 1),
    blockers,
    'images',
  );
  const publicationRows = await bounded(
    input.db
      .select()
      .from(imagePublications)
      .orderBy(asc(imagePublications.buildId))
      .limit(MAX_ROWS + 1),
    blockers,
    'images',
  );
  const imageEvidence: unknown[] = [];
  for (const effect of effectRows) {
    imageEffectOutcomeSchema.parse(effect.outcome);
    if (imageEffectResolutionSchema.parse(effect.resolution).kind === 'pending')
      push(blockers, 'images', effect.id, 'Image provider effect resolution remains pending.');
  }
  for (const row of buildRows) {
    const state = imageBuildStateSchema.parse(row.state);
    if (state.kind !== 'retained' && state.kind !== 'cleaned') {
      push(blockers, 'images', row.id, `Image build remains ${state.kind}.`);
      continue;
    }
    const resources = buildResourceRows.filter((resource) => resource.buildId === row.id);
    const publication = publicationRows.find((value) => value.buildId === row.id);
    if (state.kind === 'cleaned') {
      if (
        resources.some(
          (resource) =>
            resource.state &&
            typeof resource.state === 'object' &&
            (!('kind' in resource.state) || resource.state.kind !== 'absent'),
        )
      )
        push(
          blockers,
          'images',
          row.id,
          'Cleaned image build retains a resource not proven absent.',
        );
      continue;
    }
    if (!publication?.release)
      push(blockers, 'images', row.id, 'Retained image build lacks a published release.');
    if (!input.verifyImage)
      push(blockers, 'images', row.id, 'Retained image lacks read-only snapshot verification.');
    else {
      const verified = await input.verifyImage({
        buildId: row.id,
        admission: row.admission,
        state,
        publication,
        resources,
      });
      imageEvidence.push({ id: row.id, ...verified });
      if (!verified.ok || !/^[0-9a-f]{64}$/.test(verified.evidenceDigest))
        push(blockers, 'images', row.id, 'Retained image snapshot verification failed.');
    }
  }

  if (!input.imageInventory && buildResourceRows.length)
    push(blockers, 'images', '*', 'Image provider inventory is unavailable.');
  if (input.imageInventory) {
    for (const row of buildResourceRows) {
      const kind = imageResourceKindSchema.parse(row.kind);
      const state = imageResourceStateSchema.parse(row.state);
      const observed = await input.imageInventory.get({ kind, id: row.providerId });
      observations.push({ kind: `image:${kind}`, ledgerId: row.providerId, value: observed });
      if (state.kind === 'absent' && observed)
        push(
          blockers,
          'images',
          `${kind}:${row.providerId}`,
          'Tombstoned image resource still exists.',
        );
      if (state.kind !== 'absent' && !observed)
        push(blockers, 'images', `${kind}:${row.providerId}`, 'Live image resource is absent.');
      if (
        observed &&
        !matchesLabels(
          observed.labels,
          imageEffectLabels({
            buildId: imageBuildIdSchema.parse(row.buildId),
            role: imageResourceRoleSchema.parse(row.role),
            effectId: row.effectId,
          }),
        )
      )
        push(
          blockers,
          'images',
          `${kind}:${row.providerId}`,
          'Exact image resource ownership labels changed.',
        );
    }
    for (const kind of imageResourceKindSchema.options) {
      const found = await input.imageInventory.find({
        kind,
        labels: { managed_by: 'agent-cloud', scope: 'image-build' },
      });
      if (found.length > MAX_ROWS)
        push(
          blockers,
          'images',
          kind,
          `Image inventory exceeds the ${MAX_ROWS}-resource recovery bound.`,
        );
      for (const observed of found.slice(0, MAX_ROWS)) {
        observations.push({ kind: `image:${kind}`, value: observed });
        const known = buildResourceRows.find(
          (row) =>
            row.provider === 'hetzner' && row.kind === kind && row.providerId === observed.id,
        );
        const state = known ? imageResourceStateSchema.parse(known.state) : undefined;
        if (
          !known ||
          state?.kind === 'absent' ||
          !matchesLabels(
            observed.labels,
            imageEffectLabels({
              buildId: imageBuildIdSchema.parse(known.buildId),
              role: imageResourceRoleSchema.parse(known.role),
              effectId: known.effectId,
            }),
          )
        )
          push(
            blockers,
            'images',
            `${kind}:${observed.id}`,
            'Managed image resource is unknown or tombstoned.',
          );
      }
    }
  }

  blockers.sort((left, right) =>
    `${left.domain}\0${left.id}\0${left.reason}`.localeCompare(
      `${right.domain}\0${right.id}\0${right.reason}`,
    ),
  );
  observations.sort((left, right) =>
    JSON.stringify(canonical(left)).localeCompare(JSON.stringify(canonical(right))),
  );
  const inventoryDigest = digest({ observations, backupEvidence, imageEvidence });
  const ledger = {
    machineRows,
    allocationRows,
    operationRows,
    attemptRows,
    resourceRows,
    hostingRows,
    backupRows,
    restoreRows,
    purgeRows,
    scheduleRows,
    buildRows,
    effectRows,
    buildResourceRows,
    publicationRows,
  };
  return {
    blockers,
    inventoryDigest,
    stateDigest: digest({ ledger, observations, backupEvidence, imageEvidence }),
  };
}

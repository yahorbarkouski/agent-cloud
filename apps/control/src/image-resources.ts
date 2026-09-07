import { and, eq } from 'drizzle-orm';
import {
  CloudError,
  imageEffectLabels,
  imageRoleKind,
  isImageCreate,
  imageResourceStateSchema,
  type ImageProviderResource,
  type ImageResourceRef,
} from '@agent-cloud/contracts';
import { imageBuildResources, type Database } from '@agent-cloud/db';
import { matchesLabels } from './resource-journal.js';
import type { ImageBuild } from './image-builds.js';

export function imageResourceWhere(build: ImageBuild, ref: ImageResourceRef) {
  return and(
    eq(imageBuildResources.buildId, build.admission.id),
    eq(imageBuildResources.provider, build.admission.provider),
    eq(imageBuildResources.kind, ref.kind),
    eq(imageBuildResources.providerId, ref.id),
  );
}

/** A receipt retains the ID immediately; observation separately proves labels and configuration. */
export async function claimImageResource(
  db: Database,
  build: ImageBuild,
  effect: ImageBuild['effects'][number],
  ref: ImageResourceRef,
) {
  const command = effect.command;
  if (!isImageCreate(command) || imageRoleKind(command.labels.role) !== ref.kind)
    throw new CloudError(
      'provider_outcome_unknown',
      'Provider receipt has an unexpected resource kind.',
    );
  await db
    .insert(imageBuildResources)
    .values({
      provider: build.admission.provider,
      kind: ref.kind,
      providerId: ref.id,
      buildId: build.admission.id,
      effectId: effect.id,
      role: command.labels.role,
    })
    .onConflictDoNothing();
  const [row] = await db
    .select()
    .from(imageBuildResources)
    .where(
      and(
        eq(imageBuildResources.provider, build.admission.provider),
        eq(imageBuildResources.kind, ref.kind),
        eq(imageBuildResources.providerId, ref.id),
      ),
    );
  if (
    !row ||
    row.buildId !== build.admission.id ||
    row.effectId !== effect.id ||
    imageResourceStateSchema.parse(row.state).kind === 'absent'
  )
    throw new CloudError(
      'provider_outcome_unknown',
      'Provider resource belongs elsewhere or was already absent.',
    );
}

export async function observeImageResource(
  db: Database,
  build: ImageBuild,
  ref: ImageResourceRef,
  resource: ImageProviderResource | null,
) {
  const [row] = await db.select().from(imageBuildResources).where(imageResourceWhere(build, ref));
  if (!row)
    throw new CloudError('provider_outcome_unknown', 'Image resource has no ownership record.');
  const previous = imageResourceStateSchema.parse(row.state);
  if (!resource) {
    if (previous.kind !== 'absent')
      await db
        .update(imageBuildResources)
        .set({ state: { kind: 'absent', at: new Date().toISOString() } })
        .where(imageResourceWhere(build, ref));
    return;
  }
  const effect = build.effects.find((item) => item.id === row.effectId);
  if (
    !effect ||
    !isImageCreate(effect.command) ||
    resource.id !== ref.id ||
    resource.kind !== ref.kind ||
    !matchesLabels(
      resource.labels,
      imageEffectLabels({
        buildId: build.admission.id,
        role: effect.command.labels.role,
        effectId: effect.id,
      }),
    )
  )
    throw new CloudError(
      'provider_outcome_unknown',
      'Provider observation disagrees with image ownership.',
    );
  await db
    .update(imageBuildResources)
    .set({ state: { kind: 'observed', resource, at: new Date().toISOString() } })
    .where(imageResourceWhere(build, ref));
}

export function imageCreateMatches(
  build: ImageBuild,
  effect: ImageBuild['effects'][number],
  resource: ImageProviderResource,
) {
  const command = effect.command;
  if (
    !isImageCreate(command) ||
    resource.kind !== imageRoleKind(command.labels.role) ||
    !matchesLabels(
      resource.labels,
      imageEffectLabels({
        buildId: build.admission.id,
        role: command.labels.role,
        effectId: effect.id,
      }),
    )
  )
    return false;
  switch (command.kind) {
    case 'create_ssh_key':
      return resource.kind === 'ssh_key' && resource.publicKey === command.publicKey;
    case 'create_firewall':
      return (
        resource.kind === 'firewall' &&
        resource.attachments.length === 0 &&
        resource.rules.length === 1 &&
        resource.rules.every(
          (rule) =>
            rule.direction === 'in' &&
            rule.protocol === 'tcp' &&
            rule.port === '22' &&
            rule.destinationIps.length === 0 &&
            rule.sourceIps.length === 1 &&
            rule.sourceIps[0] === `${command.managementAddress}/32`,
        )
      );
    case 'create_primary_ip':
      return (
        resource.kind === 'primary_ip' &&
        resource.region === command.region &&
        !resource.autoDelete &&
        resource.serverId === null
      );
    case 'create_server':
      return (
        resource.kind === 'server' &&
        resource.name === command.name &&
        resource.serverType === command.serverType &&
        resource.region === command.region &&
        resource.architecture === build.admission.offer.architecture &&
        resource.diskGb === build.admission.offer.diskGb &&
        resource.imageId === command.imageId &&
        resource.primaryIpId === command.primaryIpId &&
        resource.ipv4 !== null &&
        build.resources.some(
          (ip) =>
            ip.ref.kind === 'primary_ip' &&
            ip.ref.id === command.primaryIpId &&
            ip.state.kind === 'observed' &&
            ip.state.resource.kind === 'primary_ip' &&
            ip.state.resource.ipv4 === resource.ipv4,
        ) &&
        resource.firewalls.length === 1 &&
        resource.firewalls.every(
          (firewall) => firewall.id === command.firewallId && firewall.status === 'applied',
        ) &&
        resource.power === 'running' &&
        !resource.deleteProtected
      );
    case 'create_snapshot':
      return (
        resource.kind === 'snapshot' &&
        resource.status === 'available' &&
        resource.sourceServerId === command.serverId &&
        resource.architecture === build.admission.offer.architecture &&
        resource.diskGb === build.admission.offer.diskGb &&
        resource.imageSizeGb !== null &&
        resource.imageSizeGb <= build.admission.budget.maxSnapshotGb &&
        !resource.deleteProtected &&
        Date.parse(resource.createdAt) >= Date.parse(effect.createdAt) - 5000
      );
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

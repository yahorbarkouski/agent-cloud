import {
  CloudError,
  imageBuildLabels,
  imageEffectLabels,
  imageRoleKind,
  isImageCreate,
  type ImageProvider,
  type ImageProviderCommand,
  type ImageResourceRole,
  type ImageBuildAdmission,
} from '@agent-cloud/contracts';
import { matchesLabels } from './resource-journal.js';
import type { ImageBuild } from './image-builds.js';

export function checkImageBuilderIntent(
  admission: ImageBuildAdmission,
  command: Extract<ImageProviderCommand, { kind: 'create_server' }>,
) {
  if (command.labels.role !== 'builder')
    throw new CloudError(
      'guest_unreachable',
      'Platform image-verifier enrollment is not configured.',
    );
  if (
    !matchesLabels(command.labels, imageBuildLabels(admission.id, 'builder')) ||
    command.serverType !== admission.offer.serverType ||
    command.region !== admission.offer.region ||
    command.imageId !== admission.baseImageId ||
    command.bootData.id !== admission.access.secretId ||
    command.bootData.digest !== admission.source.manifestDigest
  )
    throw new CloudError('invalid_input', 'Image builder differs from its admission.');
}

export function imageEffectKey(command: ImageProviderCommand) {
  if (isImageCreate(command)) return `create:${command.labels.role}`;
  if (command.kind === 'power_off') return `power_off:${command.serverId}`;
  return `delete:${command.resource.kind}:${command.resource.id}`;
}

export async function checkImageCommand(
  build: ImageBuild,
  command: ImageProviderCommand,
  provider: ImageProvider,
) {
  const { admission } = build;
  if (isImageCreate(command) && command.kind !== 'create_snapshot') {
    const base = await provider.getBaseImage(admission.baseImageId);
    if (
      !base ||
      base.id !== admission.baseImageId ||
      base.type !== 'system' ||
      base.status !== 'available' ||
      base.architecture !== admission.offer.architecture ||
      base.osFlavor !== 'ubuntu' ||
      base.osVersion !== '24.04' ||
      base.diskGb > admission.offer.diskGb ||
      base.deprecated ||
      base.deleted
    )
      throw new CloudError(
        'provider_unavailable',
        'The pinned Ubuntu 24.04 base image is unavailable or incompatible.',
      );
  }
  const owned = async (role: ImageResourceRole, id: string) => {
    const row = build.resources.find(
      (resource) =>
        resource.role === role &&
        resource.ref.id === id &&
        resource.ref.kind === imageRoleKind(role),
    );
    if (
      !row ||
      row.state.kind === 'absent' ||
      !build.effects.some(
        (effect) => effect.id === row.effectId && effect.resolution.kind === 'confirmed',
      )
    )
      throw new CloudError(
        'provider_outcome_unknown',
        'Image command needs a confirmed owned dependency.',
      );
    const current = await provider.get(row.ref);
    if (
      !current ||
      current.id !== row.ref.id ||
      current.kind !== row.ref.kind ||
      !matchesLabels(
        current.labels,
        imageEffectLabels({ buildId: admission.id, role, effectId: row.effectId }),
      )
    )
      throw new CloudError('provider_outcome_unknown', 'Image dependency ownership changed.');
    return current;
  };
  if (isImageCreate(command)) {
    if (
      !matchesLabels(command.labels, imageBuildLabels(admission.id, command.labels.role)) ||
      imageRoleKind(command.labels.role) !== command.kind.slice(7)
    )
      throw new CloudError('invalid_input', 'Image command labels and resource role disagree.');
  }
  switch (command.kind) {
    case 'create_ssh_key':
      if (command.publicKey !== admission.access.publicKey)
        throw new CloudError('invalid_input', 'Image access key differs from admission.');
      return;
    case 'create_firewall':
      if (command.managementAddress !== admission.access.managementAddress)
        throw new CloudError('invalid_input', 'Image firewall differs from admission.');
      return;
    case 'create_primary_ip':
      if (command.region !== admission.offer.region)
        throw new CloudError('invalid_input', 'Image address location differs from admission.');
      return;
    case 'create_server': {
      checkImageBuilderIntent(admission, command);
      const ip = await owned('builder_ip', command.primaryIpId);
      const key = await owned('access_key', command.sshKeyId);
      const firewall = await owned('access_firewall', command.firewallId);
      if (
        ip.kind !== 'primary_ip' ||
        ip.autoDelete ||
        ip.serverId !== null ||
        ip.region !== command.region ||
        key.kind !== 'ssh_key' ||
        key.publicKey !== admission.access.publicKey ||
        firewall.kind !== 'firewall' ||
        firewall.attachments.length !== 0 ||
        firewall.rules.length !== 1 ||
        !firewall.rules.every(
          (rule) =>
            rule.direction === 'in' &&
            rule.protocol === 'tcp' &&
            rule.port === '22' &&
            rule.destinationIps.length === 0 &&
            rule.sourceIps.length === 1 &&
            rule.sourceIps[0] === `${admission.access.managementAddress}/32`,
        )
      )
        throw new CloudError('provider_outcome_unknown', 'Image builder dependencies changed.');
      return;
    }
    case 'power_off':
      if (
        command.sanitation.builderId !== admission.id ||
        command.sanitation.manifestDigest !== admission.source.manifestDigest
      )
        throw new CloudError(
          'invalid_input',
          'Sanitation receipt differs from the admitted builder.',
        );
      await owned('builder', command.serverId);
      return;
    case 'create_snapshot': {
      const source = await owned('builder', command.serverId);
      const stopped = build.effects.find(
        (effect) =>
          effect.command.kind === 'power_off' &&
          effect.command.serverId === command.serverId &&
          effect.resolution.kind === 'confirmed',
      );
      if (
        !stopped ||
        source.kind !== 'server' ||
        source.power !== 'off' ||
        source.architecture !== admission.offer.architecture ||
        source.diskGb !== admission.offer.diskGb
      )
        throw new CloudError(
          'provider_outcome_unknown',
          'Snapshot needs a sanitized and confirmed stopped builder.',
        );
      return;
    }
    case 'delete': {
      const row = build.resources.find(
        (resource) =>
          resource.ref.kind === command.resource.kind && resource.ref.id === command.resource.id,
      );
      if (!row || row.state.kind === 'absent')
        throw new CloudError('provider_outcome_unknown', 'Deletion needs an owned image resource.');
      const current = await provider.get(row.ref);
      if (!current) return;
      if (
        current.kind !== row.ref.kind ||
        current.id !== row.ref.id ||
        !matchesLabels(
          current.labels,
          imageEffectLabels({ buildId: admission.id, role: row.role, effectId: row.effectId }),
        )
      )
        throw new CloudError(
          'provider_outcome_unknown',
          'Image deletion target ownership changed.',
        );
      if (
        current.kind !== 'server' &&
        build.effects.some(
          (effect) =>
            effect.command.kind === 'create_server' && effect.resolution.kind === 'pending',
        )
      )
        throw new CloudError(
          'provider_outcome_unknown',
          'Reconcile uncertain servers before deleting image dependencies.',
        );
      if (
        row.role === 'builder' &&
        build.effects.some(
          (effect) =>
            effect.command.kind === 'create_snapshot' && effect.resolution.kind === 'pending',
        )
      )
        throw new CloudError(
          'provider_outcome_unknown',
          'Reconcile uncertain snapshots before deleting their builder.',
        );
      if (
        (current.kind === 'primary_ip' && current.serverId !== null) ||
        (current.kind === 'firewall' && current.attachments.length !== 0) ||
        ((current.kind === 'server' || current.kind === 'snapshot') && current.deleteProtected)
      )
        throw new CloudError(
          'provider_outcome_unknown',
          'Image resource is attached or deletion-protected.',
        );
      if (
        current.kind === 'ssh_key' &&
        build.resources.some(
          (resource) => resource.ref.kind === 'server' && resource.state.kind !== 'absent',
        )
      )
        throw new CloudError(
          'provider_outcome_unknown',
          'Remove image servers before deleting access keys.',
        );
      return;
    }
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

import {
  imageBuildLabels,
  type ImageProviderCommand,
  type ImageResourceRole,
} from '@agent-cloud/contracts';
import type { ImageBuild } from './image-builds.js';

type Plan =
  | { kind: 'effect'; command: ImageProviderCommand }
  | { kind: 'builder' }
  | { kind: 'cleanup'; reason: 'requested' | 'expired' | 'failed' }
  | { kind: 'cleaned' }
  | { kind: 'verification_required'; snapshotId: string };

/** Plans from one consistent SQL snapshot. Executors revalidate under their own build lock. */
export function planImageRelease(build: ImageBuild, now = Date.now()): Plan {
  const { admission } = build;
  if (build.state.kind === 'cleaned') return { kind: 'cleaned' };
  if (build.state.kind === 'cleaning') return { kind: 'cleanup', reason: build.state.reason };
  if (Date.parse(admission.deadlineAt) <= now) return { kind: 'cleanup', reason: 'expired' };
  const pending = build.effects.find((effect) => effect.resolution.kind === 'pending');
  if (pending) return { kind: 'effect', command: pending.command };
  const identity = (role: ImageResourceRole) => ({
    name: `image-${role.replaceAll('_', '-')}-${admission.id}`,
    labels: imageBuildLabels(admission.id, role),
  });
  const effect = (role: ImageResourceRole) =>
    build.effects.find((item) => item.key === `create:${role}`);
  const resource = (role: ImageResourceRole) => {
    const resources = build.resources.filter((item) => item.role === role);
    const first = resources[0];
    return resources.length === 1 && first?.state.kind === 'observed' ? first : null;
  };
  const failed = (): Plan => ({ kind: 'cleanup', reason: 'failed' });
  if (!effect('access_key'))
    return {
      kind: 'effect',
      command: {
        kind: 'create_ssh_key',
        ...identity('access_key'),
        publicKey: admission.access.publicKey,
      },
    };
  const key = resource('access_key');
  if (effect('access_key')?.resolution.kind !== 'confirmed' || !key) return failed();
  if (!effect('access_firewall'))
    return {
      kind: 'effect',
      command: {
        kind: 'create_firewall',
        ...identity('access_firewall'),
        managementAddress: admission.access.managementAddress,
      },
    };
  const firewall = resource('access_firewall');
  if (effect('access_firewall')?.resolution.kind !== 'confirmed' || !firewall) return failed();
  if (!effect('builder_ip'))
    return {
      kind: 'effect',
      command: {
        kind: 'create_primary_ip',
        ...identity('builder_ip'),
        region: admission.offer.region,
      },
    };
  const ip = resource('builder_ip');
  if (effect('builder_ip')?.resolution.kind !== 'confirmed' || !ip) return failed();
  if (!effect('builder'))
    return {
      kind: 'effect',
      command: {
        kind: 'create_server',
        ...identity('builder'),
        serverType: admission.offer.serverType,
        region: admission.offer.region,
        imageId: admission.baseImageId,
        primaryIpId: ip.ref.id,
        sshKeyId: key.ref.id,
        firewallId: firewall.ref.id,
        bootData: {
          kind: 'image_build_secret',
          id: admission.access.secretId,
          digest: admission.source.manifestDigest,
        },
      },
    };
  const builder = resource('builder');
  if (effect('builder')?.resolution.kind !== 'confirmed' || !builder) return failed();
  if (build.builderWork.kind === 'waiting' || build.builderWork.progress.kind !== 'sanitized')
    return { kind: 'builder' };
  if (
    build.builderWork.serverId !== builder.ref.id ||
    build.builderWork.effectId !== builder.effectId
  )
    return failed();
  const stopped = build.effects.find(
    (item) =>
      item.command.kind === 'power_off' &&
      item.command.serverId === builder.ref.id &&
      item.resolution.kind === 'confirmed',
  );
  if (!stopped)
    return {
      kind: 'effect',
      command: {
        kind: 'power_off',
        serverId: builder.ref.id,
        sanitation: build.builderWork.progress.sanitation,
      },
    };
  if (!effect('snapshot'))
    return {
      kind: 'effect',
      command: { kind: 'create_snapshot', ...identity('snapshot'), serverId: builder.ref.id },
    };
  const snapshot = resource('snapshot');
  if (effect('snapshot')?.resolution.kind !== 'confirmed' || !snapshot) return failed();
  return { kind: 'verification_required', snapshotId: snapshot.ref.id };
}

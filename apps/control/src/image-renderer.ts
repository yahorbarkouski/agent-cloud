import { isDeepStrictEqual } from 'node:util';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  CloudError,
  imageBuildIdSchema,
  imageProviderCommandSchema,
  imageBuilderBootSchema,
} from '@agent-cloud/contracts';
import { databaseTime, imageBuildEffects, type Database } from '@agent-cloud/db';
import type { ImageBootRenderer } from '@agent-cloud/hetzner';
import { inspectImageBuild } from './image-builds.js';
import { checkImageServerIntent } from './image-effect-policy.js';
import type { ImageAccessStore } from './image-access.js';
import type { BootstrapSeal } from './bootstrap-seal.js';
import { recoverImageVerifierBootstrap } from './image-verifier.js';

/** Called by the transport only for the original, committed create effect. */
export function createImageRenderer(
  db: Database,
  store: ImageAccessStore,
  verifierSeal?: BootstrapSeal,
): ImageBootRenderer {
  return async (input) => {
    const id = z.uuid().parse(input.effectId);
    const command = imageProviderCommandSchema.parse(input.command);
    if (command.kind !== 'create_server')
      throw new CloudError('permission_denied', 'Expected an image server create.');
    const [row] = await db.select().from(imageBuildEffects).where(eq(imageBuildEffects.id, id));
    if (!row)
      throw new CloudError('permission_denied', 'Image boot data requires its recorded effect.');
    const build = await inspectImageBuild(db, imageBuildIdSchema.parse(row.buildId));
    const now = (await databaseTime(db)).getTime();
    const effect = build.effects.find((effect) => effect.id === id);
    if (
      !effect ||
      effect.outcome.kind !== 'prepared' ||
      effect.resolution.kind !== 'pending' ||
      !isDeepStrictEqual(effect.command, command) ||
      build.state.kind !== 'running' ||
      Date.parse(build.admission.deadlineAt) <= now
    )
      throw new CloudError(
        'permission_denied',
        'Image boot data requires its exact active prepared effect.',
      );
    checkImageServerIntent(build, command, now);
    for (const dependency of [
      {
        role: command.labels.role === 'verifier' ? 'verifier_ip' : 'builder_ip',
        id: command.primaryIpId,
      },
      { role: 'access_key', id: command.sshKeyId },
      { role: 'access_firewall', id: command.firewallId },
    ]) {
      if (
        !build.resources.some(
          (resource) =>
            resource.role === dependency.role &&
            resource.ref.id === dependency.id &&
            resource.state.kind === 'observed' &&
            build.effects.some(
              (creator) =>
                creator.id === resource.effectId && creator.resolution.kind === 'confirmed',
            ),
        )
      )
        throw new CloudError(
          'permission_denied',
          'Image boot data requires confirmed owned dependencies.',
        );
    }
    if (command.bootData.kind === 'image_verifier_secret') {
      if (!verifierSeal)
        throw new CloudError(
          'provider_unavailable',
          'Image verifier boot rendering is not configured.',
        );
      const bootstrap = await recoverImageVerifierBootstrap(db, {
        buildId: build.admission.id,
        seal: verifierSeal,
      });
      return (
        '#cloud-config\n' +
        JSON.stringify({
          users: [],
          disable_root: true,
          ssh_pwauth: false,
          allow_public_ssh_keys: false,
          ssh_deletekeys: true,
          ssh_keys: {},
          ssh_publish_hostkeys: { enabled: false },
          write_files: [
            {
              path: '/var/lib/agent-cloud/bootstrap.json',
              owner: 'root:root',
              permissions: '0600',
              content: JSON.stringify(bootstrap) + '\n',
            },
          ],
          runcmd: [['systemctl', 'start', '--no-block', 'agent-cloud-enroll.service']],
        }) +
        '\n'
      );
    }
    const material = await store.recover(build.admission);
    // JSON is YAML. Fixed paths/argv keep all key material out of shell interpolation.
    const configuration = {
      users: [
        {
          name: 'agent-cloud-build',
          homedir: '/home/agent-cloud-build',
          shell: '/bin/sh',
          lock_passwd: true,
          ssh_authorized_keys: [material.access.publicKey],
        },
      ],
      disable_root: true,
      ssh_pwauth: false,
      allow_public_ssh_keys: false,
      ssh_deletekeys: true,
      ssh_quiet_keygen: true,
      ssh_publish_hostkeys: { enabled: false },
      ssh_keys: {
        ed25519_private: material.hostPrivateKey,
        ed25519_public: material.access.hostPublicKey,
      },
      write_files: [
        {
          path: '/etc/sudoers.d/agent-cloud-builder',
          owner: 'root:root',
          permissions: '0440',
          content: 'agent-cloud-build ALL=(ALL) NOPASSWD: ALL\n',
        },
        {
          path: '/etc/ssh/sshd_config.d/10-agent-cloud-builder.conf',
          owner: 'root:root',
          permissions: '0644',
          content:
            'PermitRootLogin no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nAllowUsers agent-cloud-build\n',
        },
        {
          path: '/run/agent-cloud-builder.json',
          owner: 'root:root',
          permissions: '0644',
          content:
            JSON.stringify(
              imageBuilderBootSchema.parse({
                version: 1,
                buildId: build.admission.id,
                effectId: id,
                manifestDigest: build.admission.source.manifestDigest,
              }),
            ) + '\n',
        },
      ],
      runcmd: [
        ['/usr/sbin/visudo', '-cf', '/etc/sudoers.d/agent-cloud-builder'],
        ['/usr/sbin/sshd', '-t'],
        ['/usr/bin/systemctl', 'restart', 'ssh.service'],
      ],
    };
    const latest = await inspectImageBuild(db, build.admission.id);
    const current = latest.effects.find((effect) => effect.id === id);
    if (
      latest.state.kind !== 'running' ||
      Date.parse(latest.admission.deadlineAt) <= (await databaseTime(db)).getTime() ||
      current?.outcome.kind !== 'prepared' ||
      current.resolution.kind !== 'pending'
    )
      throw new CloudError(
        'permission_denied',
        'Image build stopped permitting boot data during key recovery.',
      );
    return '#cloud-config\n' + JSON.stringify(configuration) + '\n';
  };
}

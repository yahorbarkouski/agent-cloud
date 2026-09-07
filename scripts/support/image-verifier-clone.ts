import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { getRequestListener } from '@hono/node-server';
import { z } from 'zod';
import {
  imageVerifierProofSchema,
  simulatedCatalog,
  type ImageProvider,
  type ImageReleaseKey,
} from '../../packages/contracts/dist/index.js';
import { createSigner } from '../../packages/pki/dist/index.js';
import { createGuestProbe } from '../../packages/remote/dist/index.js';
import { createImageRenderer } from '../../apps/control/dist/image-renderer.js';
import { createImageVerifierEnrollment } from '../../apps/control/dist/image-verifier-enrollment.js';
import { createImageVerifierRuntime } from '../../apps/control/dist/image-verifier-runtime.js';
import { inspectImageBuild, requestImageCleanup } from '../../apps/control/dist/image-builds.js';
import { advanceImageBuild } from '../../apps/control/dist/advance-image-build.js';
import { readPublishedImage } from '../../apps/control/dist/image-publication.js';
import { BootstrapSeal } from '../../apps/control/dist/bootstrap-seal.js';
import { createApp } from '../../apps/control/dist/app.js';
import { readPrivateFile } from '../../apps/control/dist/private-file.js';
import type { ImageProviderFixture } from '../../tests/image-build-fixture.js';
import { readImageBuilder } from './image-builder.js';

const ownershipPath = resolve('.local/guest-image-verifier.json');
const ownerSchema = z.strictObject({
  purpose: z.literal('agent-cloud-local-image-verifier'),
  name: z.string().regex(/^agent-cloud-verifier-[0-9a-f]{8}$/),
  buildId: z.uuid(),
});
const progress = (phase: string) =>
  process.stdout.write(JSON.stringify({ phase, cloudResourcesCreated: 0 }) + '\n');
async function run(binary: string, args: string[], timeout = 30_000) {
  try {
    return (
      await promisify(execFile)(binary, args, { timeout, killSignal: 'SIGKILL', maxBuffer: 65536 })
    ).stdout;
  } catch {
    throw new Error(`Verifier clone command failed: ${binary}. Inspect only its recorded VM.`);
  }
}

/** OrbStack starts before test seed installation; assert inert pre-bootstrap state, then verify the seeded reboot. */
export async function verifyImageClone(input: {
  controller: Parameters<typeof advanceImageBuild>[0];
  protocol: ImageProviderFixture;
}) {
  const { controller, protocol } = input;
  const build = await inspectImageBuild(controller.connection.db, controller.buildId);
  const source = await readImageBuilder();
  assert.equal(source.builderId, build.admission.id);
  assert.equal(source.phase, 'sanitized');
  z.object({
    record: z.object({ name: z.literal(source.name), state: z.literal('stopped') }),
  }).parse(JSON.parse(await run('orb', ['info', source.name, '--format', 'json'])));
  const owner = ownerSchema.parse({
    purpose: 'agent-cloud-local-image-verifier',
    name: 'agent-cloud-verifier-' + randomUUID().slice(0, 8),
    buildId: build.admission.id,
  });
  await writeFile(ownershipPath, JSON.stringify(owner) + '\n', { mode: 0o600, flag: 'wx' });
  const scratch = resolve('.local/image-verifier-access', owner.buildId);
  await mkdir(scratch, { mode: 0o700, recursive: true });
  const vm = (args: string[], timeout?: number) =>
    run('orb', ['run', '-m', owner.name, '-u', 'root', '-w', '/tmp', ...args], timeout);
  let server: ReturnType<typeof createServer> | undefined;
  let succeeded = false;
  try {
    progress('booting build-owned image verifier from the recorded stopped source');
    await run('orb', ['clone', source.name, owner.name], 120_000);
    await run('orb', ['start', owner.name], 120_000);
    let address: string | null = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      const info = z
        .object({
          record: z.object({ name: z.literal(owner.name), builtin: z.literal(false) }),
          ip4: z.ipv4().optional(),
        })
        .parse(JSON.parse(await run('orb', ['info', owner.name, '--format', 'json'])));
      if (info.ip4) {
        address = info.ip4;
        break;
      }
      await setTimeout(1000);
    }
    if (!address) throw new Error('Verifier clone did not receive an address.');
    const guestAddress = address;
    await vm([
      '/bin/sh',
      '-ec',
      'test ! -e /var/lib/agent-cloud/guest.json; test ! -e /var/lib/agent-cloud/keys; test ! -e /var/lib/agent-cloud/bootstrap.json; test ! -e /var/lib/agent-cloud/probe-principals; cmp -s /etc/ssh/sshd_config /usr/lib/agent-cloud/sshd_config',
    ]);
    assert.equal(
      (await vm(['ss', '-H', '-lnt', '( sport = :22 or sport = :8081 or sport = :8443 )'])).trim(),
      '',
      'An unseeded verifier must expose no SSH, proxy readiness or guest API listener.',
    );
    progress('unseeded verifier has no identity, principals or SSH/application listeners');
    const step = resolve('.local/tools/step-0.30.6');
    await run('env', [
      'STEPPATH=' + scratch,
      step,
      'ca',
      'certificate',
      'host.orb.internal',
      join(scratch, 'api.crt'),
      join(scratch, 'api.key'),
      '--ca-url',
      'https://localhost:9449',
      '--root',
      resolve('.local/pki/public/root_ca.crt'),
      '--provisioner',
      'agent-cloud-control',
      '--provisioner-password-file',
      resolve('.local/pki/provisioner-password'),
      '--kty',
      'EC',
      '--curve',
      'P-256',
      '--not-after',
      '1h',
    ]);
    await chmod(join(scratch, 'api.key'), 0o600);
    const signer = createSigner({
      binary: step,
      caUrl: 'https://localhost:9449',
      tlsRoot: await readFile('.local/pki/public/root_ca.crt', 'utf8'),
      sshHostCa: (await readFile('.local/pki/public/ssh_host_ca_key.pub', 'utf8')).trim(),
      sshUserCa: (await readFile('.local/pki/public/ssh_user_ca_key.pub', 'utf8')).trim(),
      provisioner: 'agent-cloud-control',
      provisionerPassword: await readPrivateFile(resolve('.local/pki/provisioner-password')),
    });
    const seal = new BootstrapSeal(randomBytes(32).toString('base64'));
    const renderer = createImageRenderer(controller.connection.db, controller.access, seal);
    const provider: ImageProvider = {
      kind: protocol.kind,
      get: protocol.get.bind(protocol),
      find: protocol.find.bind(protocol),
      getAction: protocol.getAction.bind(protocol),
      getBaseImage: protocol.getBaseImage.bind(protocol),
      submit: async (input) => {
        const command = input.command;
        if (command.kind === 'create_server' && command.labels.role === 'verifier') {
          const userData = await renderer({ effectId: input.effectId, command });
          await writeFile(join(scratch, 'user-data'), userData, { mode: 0o600, flag: 'wx' });
          await writeFile(
            join(scratch, 'meta-data'),
            JSON.stringify({
              'instance-id': input.effectId,
              'local-hostname': 'agent-cloud-verifier-fixture',
            }),
            { mode: 0o600, flag: 'wx' },
          );
          await writeFile(
            join(scratch, 'datasource.cfg'),
            'datasource_list: [NoCloud]\nnetwork:\n  config: disabled\ngrowpart:\n  mode: "off"\nresize_rootfs: false\n',
            { mode: 0o600, flag: 'wx' },
          );
          await vm(['install', '-d', '-m', '0700', '/var/lib/cloud/seed/nocloud']);
          for (const file of ['user-data', 'meta-data'])
            await vm([
              'install',
              '-m',
              '0600',
              '/mnt/mac' + join(scratch, file),
              '/var/lib/cloud/seed/nocloud/' + file,
            ]);
          await vm([
            'install',
            '-m',
            '0600',
            '/mnt/mac' + join(scratch, 'datasource.cfg'),
            '/etc/cloud/cloud.cfg.d/91-agent-cloud-smoke.cfg',
          ]);
          await vm([
            'cloud-init',
            'schema',
            '--config-file',
            '/var/lib/cloud/seed/nocloud/user-data',
          ]);
          await run('orb', ['restart', owner.name], 120_000);
        }
        if (command.kind === 'delete' && command.resource.kind === 'server') {
          const resource = await protocol.get(command.resource);
          if (resource?.labels.role === 'verifier') {
            assert.deepEqual(
              ownerSchema.parse(JSON.parse(await readPrivateFile(ownershipPath))),
              owner,
            );
            await run('orb', ['delete', '--force', owner.name], 60_000);
            await rm(ownershipPath);
            return protocol.submit(input);
          }
          return controller.provider.submit(input);
        }
        const result = await protocol.submit(input);
        if (
          (result.kind === 'completed' || result.kind === 'accepted') &&
          (command.kind === 'create_primary_ip' || command.kind === 'create_server')
        ) {
          const resource = await protocol.get(result.resource);
          if (resource?.kind === 'primary_ip' || resource?.kind === 'server')
            protocol.add({ ...resource, ipv4: guestAddress });
        }
        return result;
      },
    };
    const probe = createGuestProbe();
    const enrollment = createImageVerifierEnrollment({
      connection: controller.connection,
      seal,
      signer,
      probe,
      provider,
    });
    const app = createApp({
      db: controller.connection.db,
      provider: 'simulated',
      catalog: simulatedCatalog,
      limits: { currency: 'EUR', maxMachines: 1, maxHourlyMicros: 1000 },
      imageEnrollment: enrollment,
    });
    const listener = getRequestListener((request) =>
      new URL(request.url).pathname === '/image/enroll'
        ? app.fetch(request)
        : new Response(null, { status: 404 }),
    );
    server = createServer(
      {
        key: await readFile(join(scratch, 'api.key')),
        cert: await readFile(join(scratch, 'api.crt')),
      },
      (request, response) => {
        void listener(request, response).catch(() => response.destroy());
      },
    );
    await new Promise<void>((resolve) => server?.listen(0, '::', resolve));
    const endpoint = server.address();
    if (!endpoint || typeof endpoint === 'string')
      throw new Error('Expected local HTTPS listener.');
    const runtime = createImageVerifierRuntime({
      connection: controller.connection,
      provider,
      signer,
      probe,
    });
    const verifierController = {
      ...controller,
      provider,
      verification: {
        seal,
        enrollmentUrl: `https://host.orb.internal:${endpoint.port}/image/enroll`,
        runtime,
      },
    };
    for (let pass = 0; pass < 3; pass++) await advanceImageBuild(verifierController);
    progress('waiting for native verifier HTTPS enrollment with build-owned keys');
    const deadline = Date.now() + 180_000;
    let enrolled = false;
    while (Date.now() < deadline) {
      const status = await vm([
        '/bin/sh',
        '-c',
        'if test -f /var/lib/agent-cloud/enrollment-status.json; then cat /var/lib/agent-cloud/enrollment-status.json; else printf "{}"; fi',
      ]);
      if (z.object({ phase: z.literal('enrolled') }).safeParse(JSON.parse(status)).success) {
        enrolled = true;
        break;
      }
      await setTimeout(2000);
    }
    assert(enrolled, 'Verifier did not enroll before the local deadline.');
    const proof = imageVerifierProofSchema.parse(
      JSON.parse(await vm(['/usr/local/bin/guestctl', 'identity', '--json'])),
    );
    assert.equal(proof.subject.id, build.admission.id);
    assert.equal(proof.manifestDigest, build.admission.source.manifestDigest);
    await vm([
      '/bin/sh',
      '-ec',
      'test ! -e /var/lib/agent-cloud/bootstrap.json; test ! -e /etc/sudoers.d/agent-cloud-builder; test ! -e /etc/ssh/sshd_config.d/10-agent-cloud-builder.conf',
    ]);
    await assert.rejects(
      vm(['/usr/sbin/runuser', '-u', 'agent-probe', '--', 'sudo', '-n', '--', 'id']),
    );
    progress('rejecting unhealthy verifier services before saving fresh boot evidence');
    await vm(['systemctl', 'stop', 'docker.service', 'docker.socket']);
    try {
      assert.partialDeepStrictEqual(await runtime.check(build.admission.id), {
        value: { kind: 'waiting' },
      });
    } finally {
      await vm(['systemctl', 'start', 'docker.service']);
    }
    await vm(['systemctl', 'stop', 'agent-cloud-proxy.service']);
    try {
      assert.partialDeepStrictEqual(await runtime.check(build.admission.id), {
        value: { kind: 'waiting' },
      });
    } finally {
      await vm(['systemctl', 'start', 'agent-cloud-proxy.service']);
    }
    const verified = await runtime.check(build.admission.id);
    assert(verified.kind === 'acquired' && verified.value.kind === 'verified');
    assert.notEqual(
      verified.value.result.runtime.machineId,
      build.builderWork.kind === 'recorded' && build.builderWork.progress.kind === 'sanitized'
        ? build.builderWork.progress.installation.machineId
        : null,
    );
    assert.equal((await advanceImageBuild(verifierController)).kind, 'verified');
    process.stdout.write(
      JSON.stringify({
        result: 'image-verifier-verified',
        buildId: build.admission.id,
        snapshotId: verified.value.result.snapshotId,
        serverId: verified.value.result.serverId,
        machineId: verified.value.result.runtime.machineId,
        bootId: verified.value.result.runtime.bootId,
        cloudResourcesCreated: 0,
      }) + '\n',
    );
    progress('publishing verified snapshot after native temporary VM cleanup');
    const pair = generateKeyPairSync('ed25519');
    const signedFrom = Date.now();
    const key: ImageReleaseKey = {
      kind: 'trusted',
      publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      signedFrom: new Date(signedFrom - 60_000).toISOString(),
      signedUntil: new Date(signedFrom + 86_400_000).toISOString(),
      verifyUntil: new Date(signedFrom + 2 * 86_400_000).toISOString(),
    };
    const publicationController = {
      ...verifierController,
      publication: { privateKey: pair.privateKey, readKeys: () => Promise.resolve([key]) },
    };
    let retained = false;
    for (let pass = 0; pass < 16; pass++) {
      const result = await advanceImageBuild(publicationController);
      if (result.kind === 'retained') {
        assert.equal(result.release.payload.snapshot.id, verified.value.result.snapshotId);
        process.stdout.write(
          JSON.stringify({
            result: 'image-release-published',
            buildId: build.admission.id,
            snapshotId: result.release.payload.snapshot.id,
            keyId: result.release.signature.keyId,
            cloudResourcesCreated: 0,
          }) + '\n',
        );
        retained = true;
        break;
      }
    }
    assert(retained, 'Publication did not finish temporary cleanup.');
    assert.deepEqual(
      [...protocol.resources.values()].map((resource) => resource.kind),
      ['snapshot'],
    );
    const selected = await readPublishedImage({
      ...publicationController,
      readKeys: () => Promise.resolve([key]),
    });
    assert(selected.kind === 'acquired');
    assert.equal(selected.value.image.providerImage, verified.value.result.snapshotId);
    await requestImageCleanup(controller.connection.db, build.admission.id);
    let cleaned = false;
    for (let pass = 0; pass < 16; pass++) {
      if ((await advanceImageBuild(verifierController)).kind === 'cleaned') {
        cleaned = true;
        break;
      }
    }
    assert(cleaned);
    assert.equal(protocol.resources.size, 0);
    succeeded = true;
    progress(
      'native temporary VMs removed before signing; cancelled retained snapshot removed through journal cleanup',
    );
  } finally {
    const current = server;
    if (current)
      await new Promise<void>((resolve, reject) =>
        current.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    if (succeeded) await rm(scratch, { recursive: true, force: true });
  }
}

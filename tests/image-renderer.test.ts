import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  imageBuildAdmissionSchema,
  imageBuildLabels,
  type ImageProviderCommand,
} from '../packages/contracts/dist/index.js';
import { imageBuildEffects } from '../packages/db/dist/index.js';
import { createImageAccessStore } from '../apps/control/dist/image-access.js';
import { createImageRenderer } from '../apps/control/dist/image-renderer.js';
import { admitImageBuild, requestImageCleanup } from '../apps/control/dist/image-builds.js';
import { runImageEffect } from '../apps/control/dist/image-effect-journal.js';
import { ImageProviderFixture, imageBuildFixture, imagePricing } from './image-build-fixture.js';
import { testDatabase, waitUntilDatabaseTime } from './database.js';

let database: Awaited<ReturnType<typeof testDatabase>>;
let directory: string;
beforeAll(async () => {
  database = await testDatabase();
});
afterAll(async () => {
  await database.close();
});
beforeEach(async () => {
  await database.reset();
  directory = await mkdtemp(join(tmpdir(), 'agent-cloud-image-renderer-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function scenario(durationMs = 90 * 60_000) {
  const sourceDirectory = join(directory, 'inputs');
  const fixture = await imageBuildFixture(sourceDirectory);
  fixture.admission.deadlineAt = new Date(
    Date.parse(fixture.admission.admittedAt) + durationMs,
  ).toISOString();
  const store = createImageAccessStore({ directory: join(directory, 'keys') });
  fixture.admission.access = await store.prepare({
    buildId: fixture.admission.id,
    manifestDigest: fixture.admission.source.manifestDigest,
    managementAddress: fixture.admission.access.managementAddress,
  });
  await admitImageBuild({ ...fixture, db: database.connection.db, sourceDirectory });
  const provider = new ImageProviderFixture();
  for (const command of [
    {
      kind: 'create_ssh_key',
      name: 'access',
      labels: imageBuildLabels(fixture.admission.id, 'access_key'),
      publicKey: fixture.admission.access.publicKey,
    },
    {
      kind: 'create_firewall',
      name: 'access',
      labels: imageBuildLabels(fixture.admission.id, 'access_firewall'),
      managementAddress: fixture.admission.access.managementAddress,
    },
    {
      kind: 'create_primary_ip',
      name: 'builder-ip',
      labels: imageBuildLabels(fixture.admission.id, 'builder_ip'),
      region: fixture.admission.offer.region,
    },
  ] satisfies ImageProviderCommand[])
    await runImageEffect({
      connection: database.connection,
      buildId: fixture.admission.id,
      command,
      provider,
      limits: fixture.limits,
      pricing: () => Promise.resolve(imagePricing()),
    });
  const effectId = randomUUID();
  const command = {
    kind: 'create_server',
    name: 'builder',
    labels: imageBuildLabels(fixture.admission.id, 'builder'),
    serverType: fixture.admission.offer.serverType,
    region: fixture.admission.offer.region,
    imageId: fixture.admission.baseImageId,
    primaryIpId: '1003',
    sshKeyId: '1001',
    firewallId: '1002',
    bootData: {
      kind: 'image_build_secret',
      id: fixture.admission.access.secretId,
      digest: fixture.admission.source.manifestDigest,
    },
  } satisfies Extract<ImageProviderCommand, { kind: 'create_server' }>;
  const prepareEffect = (value = command) =>
    database.connection.db.insert(imageBuildEffects).values({
      id: effectId,
      buildId: fixture.admission.id,
      effectKey: 'create:builder',
      command: value,
    });
  return {
    ...fixture,
    sourceDirectory,
    store,
    effectId,
    command,
    prepareEffect,
    render: createImageRenderer(database.connection.db, store),
  };
}

it('renders only the disposable host private key and exact prepared identity after checking actual key pairs', async () => {
  const fixture = await scenario();
  await fixture.prepareEffect();
  const output = await fixture.render(fixture);
  const material = await fixture.store.recover(fixture.admission);
  expect(output.startsWith('#cloud-config\n')).toBe(true);
  expect(output).not.toContain(material.managementPrivateKey.trim());
  const config = z
    .object({
      ssh_keys: z.object({ ed25519_private: z.string(), ed25519_public: z.string() }),
      allow_public_ssh_keys: z.boolean(),
      disable_root: z.boolean(),
      users: z.array(z.object({ name: z.string(), ssh_authorized_keys: z.array(z.string()) })),
      write_files: z.array(z.object({ path: z.string(), content: z.string() })),
    })
    .parse(JSON.parse(output.slice('#cloud-config\n'.length)));
  expect(config.ssh_keys).toEqual({
    ed25519_private: material.hostPrivateKey,
    ed25519_public: fixture.admission.access.hostPublicKey,
  });
  expect(config.allow_public_ssh_keys).toBe(false);
  expect(config.disable_root).toBe(true);
  expect(config.users).toEqual([
    { name: 'agent-cloud-build', ssh_authorized_keys: [fixture.admission.access.publicKey] },
  ]);
  expect(
    JSON.parse(
      config.write_files.find((file) => file.path === '/run/agent-cloud-builder.json')?.content ??
        '{}',
    ),
  ).toEqual({
    version: 1,
    buildId: fixture.admission.id,
    effectId: fixture.effectId,
    manifestDigest: fixture.admission.source.manifestDigest,
  });
});

it.each(['missing', 'different_command', 'unknown', 'resolved', 'cleaning', 'expired'])(
  'refuses boot rendering for a %s effect',
  async (change) => {
    const fixture = await scenario(change === 'expired' ? 5000 : undefined);
    if (change !== 'missing') await fixture.prepareEffect();
    if (change === 'different_command') fixture.command.name = 'another';
    if (change === 'unknown')
      await database.connection.db
        .update(imageBuildEffects)
        .set({ outcome: { kind: 'unknown', reason: 'Submission outcome lost.' } })
        .where(eq(imageBuildEffects.id, fixture.effectId));
    if (change === 'resolved')
      await database.connection.db
        .update(imageBuildEffects)
        .set({ resolution: { kind: 'confirmed', at: new Date().toISOString() } })
        .where(eq(imageBuildEffects.id, fixture.effectId));
    if (change === 'cleaning')
      await requestImageCleanup(database.connection.db, fixture.admission.id);
    if (change === 'expired')
      await waitUntilDatabaseTime(database.connection, fixture.admission.deadlineAt);
    await expect(fixture.render(fixture)).rejects.toThrow('effect');
  },
);

it.each(['base_image', 'secret_reference', 'dependency'])(
  'refuses a matching persisted command with an incorrect %s binding',
  async (change) => {
    const fixture = await scenario();
    if (change === 'base_image') fixture.command.imageId = '999';
    if (change === 'secret_reference') fixture.command.bootData.id = randomUUID();
    if (change === 'dependency') fixture.command.primaryIpId = '1001';
    await fixture.prepareEffect();
    await expect(fixture.render(fixture)).rejects.toThrow();
  },
);

it('rechecks cancellation after secret recovery before returning boot data', async () => {
  const fixture = await scenario();
  await fixture.prepareEffect();
  const render = createImageRenderer(database.connection.db, {
    ...fixture.store,
    recover: async (input) => {
      const material = await fixture.store.recover(input);
      await requestImageCleanup(database.connection.db, fixture.admission.id);
      return material;
    },
  });
  await expect(render(fixture)).rejects.toThrow('during key recovery');
});

it('prepares a usable public operator configuration through the CLI without a database or provider token', async () => {
  const inputDirectory = join(directory, 'inputs');
  const fixture = await imageBuildFixture(inputDirectory);
  const file = join(directory, 'config.json');
  const config = {
    id: fixture.admission.id,
    sourceDirectory: inputDirectory,
    manifestDigest: fixture.admission.source.manifestDigest,
    offer: { size: 'small', region: 'nbg1' },
    provider: {
      currency: 'USD',
      architecture: 'x86',
      serverTypes: { small: 'cpx12', medium: 'cpx22', large: 'cpx32' },
    },
    baseImageId: fixture.admission.baseImageId,
    access: { managementAddress: fixture.admission.access.managementAddress },
    budget: fixture.admission.budget,
    limits: fixture.limits,
    durationMinutes: 90,
    retention: fixture.admission.retention,
  };
  await writeFile(file, JSON.stringify(config));
  const run = () =>
    promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', 'scripts/image-build.ts', 'prepare', file],
      {
        env: {
          ...process.env,
          DATABASE_URL: '',
          HCLOUD_TOKEN_FILE: join(directory, 'missing-token'),
          IMAGE_ACCESS_DIRECTORY: join(directory, 'keys'),
        },
        timeout: 15_000,
        maxBuffer: 16384,
      },
    );
  const first = z
    .object({ access: imageBuildAdmissionSchema.shape.access })
    .parse(JSON.parse((await run()).stdout));
  expect(JSON.parse((await run()).stdout)).toMatchObject(first);
  const material = await createImageAccessStore({ directory: join(directory, 'keys') }).recover({
    id: config.id,
    source: { manifestDigest: config.manifestDigest },
    access: first.access,
  });
  expect(material.access).toEqual(first.access);
});

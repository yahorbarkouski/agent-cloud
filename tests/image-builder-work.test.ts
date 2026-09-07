import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  CloudError,
  imageBuildIdSchema,
  imageBuildLabels,
  type ImageInstallation,
  type ImageProviderCommand,
} from '../packages/contracts/dist/index.js';
import { connect, imageBuilderWork } from '../packages/db/dist/index.js';
import type { createImageBuilder } from '../packages/remote/dist/index.js';
import { createImageAccessStore } from '../apps/control/dist/image-access.js';
import {
  admitImageBuild,
  inspectImageBuild,
  requestImageCleanup,
} from '../apps/control/dist/image-builds.js';
import { runImageEffect } from '../apps/control/dist/image-effect-journal.js';
import { runImageBuilderWork } from '../apps/control/dist/image-builder-work.js';
import { imageBuildFixture, imagePricing, ImageProviderFixture } from './image-build-fixture.js';
import { testDatabase } from './database.js';

type Remote = ReturnType<typeof createImageBuilder>;
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
  directory = await mkdtemp(join(tmpdir(), 'agent-cloud-builder-work-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function scenario() {
  const sourceDirectory = join(directory, 'inputs');
  const fixture = await imageBuildFixture(sourceDirectory);
  const access = createImageAccessStore({ directory: join(directory, 'keys') });
  fixture.admission.access = await access.prepare({
    buildId: fixture.admission.id,
    manifestDigest: fixture.admission.source.manifestDigest,
    managementAddress: fixture.admission.access.managementAddress,
  });
  await admitImageBuild({ ...fixture, db: database.connection.db, sourceDirectory });
  const id = fixture.admission.id;
  const provider = new ImageProviderFixture();
  for (const command of [
    {
      kind: 'create_ssh_key',
      name: 'key',
      labels: imageBuildLabels(id, 'access_key'),
      publicKey: fixture.admission.access.publicKey,
    },
    {
      kind: 'create_firewall',
      name: 'firewall',
      labels: imageBuildLabels(id, 'access_firewall'),
      managementAddress: fixture.admission.access.managementAddress,
    },
    {
      kind: 'create_primary_ip',
      name: 'ip',
      labels: imageBuildLabels(id, 'builder_ip'),
      region: 'nbg1',
    },
    {
      kind: 'create_server',
      name: 'builder',
      labels: imageBuildLabels(id, 'builder'),
      serverType: 'cpx12',
      region: 'nbg1',
      imageId: fixture.admission.baseImageId,
      primaryIpId: '1003',
      sshKeyId: '1001',
      firewallId: '1002',
      bootData: {
        kind: 'image_build_secret',
        id: fixture.admission.access.secretId,
        digest: fixture.admission.source.manifestDigest,
      },
    },
  ] satisfies ImageProviderCommand[]) {
    expect(
      await runImageEffect({
        connection: database.connection,
        buildId: id,
        provider,
        limits: fixture.limits,
        pricing: () => Promise.resolve(imagePricing()),
        command,
      }),
    ).toMatchObject({ value: { kind: 'confirmed' } });
  }
  const ip = await provider.get({ kind: 'primary_ip', id: '1003' });
  if (ip?.kind !== 'primary_ip') throw new Error('Expected an owned IP.');
  provider.add({ ...ip, serverId: '1004' });
  const inspection = () => inspectImageBuild(database.connection.db, id);
  const installed = {
    kind: 'installed',
    receipt: {
      kind: 'builder',
      builderId: id,
      manifestDigest: fixture.admission.source.manifestDigest,
      machineId: 'a'.repeat(32),
    },
  } satisfies ImageInstallation;
  let guest: ImageInstallation = { kind: 'not_started' };
  const remote = {
    inspect: vi.fn<Remote['inspect']>(() => Promise.resolve(guest)),
    upload: vi.fn<Remote['upload']>(async (input) => {
      expect((await inspection()).builderWork).toMatchObject({
        kind: 'recorded',
        progress: { kind: 'installing' },
      });
      return {
        kind: 'uploaded',
        manifestDigest: input.boot.manifestDigest,
        checksumDigest: input.checksumDigest,
      };
    }),
    install: vi.fn<Remote['install']>(() => {
      guest = installed;
      return Promise.resolve(installed);
    }),
    sanitize: vi.fn<Remote['sanitize']>(async () => {
      expect((await inspection()).builderWork).toMatchObject({
        kind: 'recorded',
        progress: { kind: 'sanitizing' },
      });
      return {
        kind: 'sanitized',
        builderId: id,
        manifestDigest: fixture.admission.source.manifestDigest,
      };
    }),
  };
  const input = {
    connection: database.connection,
    buildId: id,
    provider,
    access,
    remote,
    sourceDirectory,
  };
  return {
    ...fixture,
    ...input,
    installed,
    inspection,
    run: () => runImageBuilderWork(input),
    guest: (value: ImageInstallation) => {
      guest = value;
    },
  };
}

it('persists each phase before SSH and the sanitation receipt before snapshot work', async () => {
  const fixture = await scenario();
  expect(await fixture.run()).toMatchObject({
    kind: 'acquired',
    value: { kind: 'progress', progress: { kind: 'installed' } },
  });
  expect(await fixture.run()).toMatchObject({
    value: { kind: 'progress', progress: { kind: 'sanitized' } },
  });
  const calls = fixture.remote.inspect.mock.calls.length;
  expect(await fixture.run()).toMatchObject({ value: { progress: { kind: 'sanitized' } } });
  expect(fixture.remote.inspect).toHaveBeenCalledTimes(calls);
  expect(fixture.remote.upload).toHaveBeenCalledOnce();
  expect(fixture.remote.install).toHaveBeenCalledOnce();
  expect(fixture.remote.sanitize).toHaveBeenCalledOnce();
  const build = await fixture.inspection();
  expect(build.builderWork).toMatchObject({
    kind: 'recorded',
    serverId: '1004',
    progress: { kind: 'sanitized', installation: fixture.installed.receipt },
  });
  const key = await fixture.access.recover(fixture.admission);
  expect(JSON.stringify(build)).not.toContain(key.managementPrivateKey.trim());
});

it('recovers a lost installation response from a new controller connection without uploading or installing twice', async () => {
  const fixture = await scenario();
  fixture.remote.install.mockImplementationOnce(() => {
    fixture.guest(fixture.installed);
    return Promise.reject(new CloudError('guest_unreachable', 'Lost result.', true));
  });
  expect(await fixture.run()).toMatchObject({ value: { kind: 'waiting' } });
  const restarted = connect(database.databaseUrl);
  try {
    expect(
      await runImageBuilderWork({
        ...fixture,
        connection: restarted,
        access: createImageAccessStore({ directory: join(directory, 'keys') }),
      }),
    ).toMatchObject({ value: { progress: { kind: 'installed' } } });
  } finally {
    await restarted.pool.end();
  }
  expect(fixture.remote.upload).toHaveBeenCalledOnce();
  expect(fixture.remote.install).toHaveBeenCalledOnce();
});

it('waits for a started installation instead of invoking it again, then cleans after deadline', async () => {
  const fixture = await scenario();
  fixture.remote.install.mockImplementationOnce(() => {
    fixture.guest({ kind: 'started' });
    return Promise.resolve({ kind: 'started' });
  });
  expect(await fixture.run()).toMatchObject({ value: { kind: 'waiting' } });
  expect(await fixture.run()).toMatchObject({ value: { kind: 'waiting' } });
  expect(fixture.remote.install).toHaveBeenCalledOnce();
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(fixture.admission.deadlineAt) + 1);
  expect(await fixture.run()).toMatchObject({ value: { kind: 'cleanup' } });
  expect((await fixture.inspection()).state).toEqual({ kind: 'cleaning', reason: 'expired' });
});

it('serializes SSH against another controller and retains completion evidence after cancellation', async () => {
  const fixture = await scenario();
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  fixture.remote.install.mockImplementationOnce(async () => {
    entered.resolve(undefined);
    await release.promise;
    return fixture.installed;
  });
  const first = fixture.run();
  await entered.promise;
  try {
    expect(await fixture.run()).toEqual({ kind: 'busy' });
    await requestImageCleanup(database.connection.db, fixture.buildId);
  } finally {
    release.resolve(undefined);
  }
  expect(await first).toMatchObject({ value: { progress: { kind: 'installed' } } });
  expect(await fixture.run()).toMatchObject({ value: { kind: 'cleanup' } });
  expect(fixture.remote.sanitize).not.toHaveBeenCalled();
});

it.each(['key_recovery', 'upload'])(
  'honors cancellation during %s before the next SSH mutation',
  async (phase) => {
    const fixture = await scenario();
    if (phase === 'key_recovery') {
      const recover = fixture.access.recover;
      vi.spyOn(fixture.access, 'recover').mockImplementation(async (input) => {
        const keys = await recover(input);
        await requestImageCleanup(database.connection.db, fixture.buildId);
        return keys;
      });
    } else {
      fixture.remote.upload.mockImplementationOnce(async (input) => {
        await requestImageCleanup(database.connection.db, fixture.buildId);
        return {
          kind: 'uploaded',
          manifestDigest: input.boot.manifestDigest,
          checksumDigest: input.checksumDigest,
        };
      });
    }
    expect(await fixture.run()).toMatchObject({ value: { kind: 'cleanup' } });
    expect(fixture.remote.install).not.toHaveBeenCalled();
    if (phase === 'key_recovery') expect(fixture.remote.inspect).not.toHaveBeenCalled();
  },
);

it.each(['host_labels', 'host_power', 'ip_assignment', 'ip_labels', 'ip_absent'])(
  'refuses %s drift before using the builder credential',
  async (change) => {
    const fixture = await scenario();
    const host = await fixture.provider.get({ kind: 'server', id: '1004' });
    const ip = await fixture.provider.get({ kind: 'primary_ip', id: '1003' });
    if (host?.kind !== 'server' || ip?.kind !== 'primary_ip')
      throw new Error('Expected resources.');
    if (change === 'host_labels')
      fixture.provider.add({ ...host, labels: { ...host.labels, effect_id: randomUUID() } });
    if (change === 'host_power') fixture.provider.add({ ...host, power: 'off' });
    if (change === 'ip_assignment') fixture.provider.add({ ...ip, serverId: '9999' });
    if (change === 'ip_labels')
      fixture.provider.add({ ...ip, labels: { ...ip.labels, effect_id: randomUUID() } });
    if (change === 'ip_absent') fixture.provider.resources.delete('primary_ip:1003');
    await expect(fixture.run()).rejects.toThrow();
    expect(fixture.remote.inspect).not.toHaveBeenCalled();
    expect((await fixture.inspection()).builderWork).toEqual({ kind: 'waiting' });
  },
);

it('discards a builder after an uncertain sanitation response without attempting sanitation again', async () => {
  const fixture = await scenario();
  await fixture.run();
  fixture.remote.sanitize.mockRejectedValueOnce(
    new CloudError('guest_unreachable', 'Lost result.', true),
  );
  expect(await fixture.run()).toMatchObject({ value: { kind: 'cleanup' } });
  expect((await fixture.inspection()).builderWork).toMatchObject({
    progress: { kind: 'sanitizing' },
  });
  expect(await fixture.run()).toMatchObject({ value: { kind: 'cleanup' } });
  expect(fixture.remote.sanitize).toHaveBeenCalledOnce();
});

it('discards an interrupted sanitation intent even when no response was recorded', async () => {
  const fixture = await scenario();
  await fixture.run();
  await database.connection.db
    .update(imageBuilderWork)
    .set({ progress: { kind: 'sanitizing', installation: fixture.installed.receipt } })
    .where(eq(imageBuilderWork.buildId, fixture.buildId));
  expect(await fixture.run()).toMatchObject({ value: { kind: 'cleanup' } });
  expect(fixture.remote.sanitize).not.toHaveBeenCalled();
});

it('SQL rejects foreign receipts, changed ownership, backward transitions and evidence deletion', async () => {
  const fixture = await scenario();
  await fixture.run();
  const update = (progress: unknown) =>
    database.connection.db
      .update(imageBuilderWork)
      .set({ progress })
      .where(eq(imageBuilderWork.buildId, fixture.buildId));
  await expect(update({ kind: 'installing' })).rejects.toThrow();
  await expect(
    update({
      kind: 'sanitizing',
      installation: {
        ...fixture.installed.receipt,
        builderId: imageBuildIdSchema.parse(randomUUID()),
      },
    }),
  ).rejects.toThrow();
  await expect(
    database.connection.db
      .update(imageBuilderWork)
      .set({ serverId: '999' })
      .where(eq(imageBuilderWork.buildId, fixture.buildId)),
  ).rejects.toThrow();
  await expect(
    database.connection.db
      .delete(imageBuilderWork)
      .where(eq(imageBuilderWork.buildId, fixture.buildId)),
  ).rejects.toThrow();
  fixture.remote.sanitize.mockResolvedValueOnce({
    kind: 'sanitized',
    builderId: fixture.buildId,
    manifestDigest: 'b'.repeat(64),
  });
  await expect(fixture.run()).rejects.toThrow();
  expect((await fixture.inspection()).builderWork).toMatchObject({
    progress: { kind: 'sanitizing' },
  });
  expect(await fixture.run()).toMatchObject({ value: { kind: 'cleanup' } });
});

it('SQL refuses JSON that would make inspection or cleanup unreadable', async () => {
  const fixture = await scenario();
  fixture.guest({ kind: 'started' });
  await fixture.run();
  const update = (progress: unknown) =>
    database.connection.db
      .update(imageBuilderWork)
      .set({ progress })
      .where(eq(imageBuilderWork.buildId, fixture.buildId));
  const installation = fixture.installed.receipt;
  for (const progress of [
    { kind: 'installed', installation, extra: true },
    { kind: 'installed', installation: { ...installation, extra: true } },
    { kind: 'installed', installation: { ...installation, machineId: 123 } },
    { kind: 'installed', installation: { ...installation, machineId: null } },
    { kind: 'installed', installation: null },
  ])
    await expect(update(progress)).rejects.toThrow();
  expect((await fixture.inspection()).builderWork).toMatchObject({
    progress: { kind: 'installing' },
  });
  await update({ kind: 'installed', installation });
  await expect(update({ kind: 'sanitizing', installation, extra: true })).rejects.toThrow();
  await update({ kind: 'sanitizing', installation });
  const sanitation = {
    kind: 'sanitized',
    builderId: fixture.buildId,
    manifestDigest: fixture.admission.source.manifestDigest,
  };
  await expect(
    update({ kind: 'sanitized', installation, sanitation: { ...sanitation, extra: true } }),
  ).rejects.toThrow();
  await expect(
    update({ kind: 'sanitized', installation, sanitation, extra: true }),
  ).rejects.toThrow();
  await update({ kind: 'sanitized', installation, sanitation });
  await requestImageCleanup(database.connection.db, fixture.buildId);
  expect((await fixture.inspection()).state.kind).toBe('cleaning');
});

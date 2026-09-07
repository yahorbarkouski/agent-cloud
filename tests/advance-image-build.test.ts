import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { CloudError } from '../packages/contracts/dist/index.js';
import { connect } from '../packages/db/dist/index.js';
import type { createImageBuilder } from '../packages/remote/dist/index.js';
import { createImageAccessStore } from '../apps/control/dist/image-access.js';
import {
  admitImageBuild,
  inspectImageBuild,
  requestImageCleanup,
} from '../apps/control/dist/image-builds.js';
import { advanceImageBuild } from '../apps/control/dist/advance-image-build.js';
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
  directory = await mkdtemp(join(tmpdir(), 'agent-cloud-image-controller-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function scenario() {
  const sourceDirectory = join(directory, 'inputs');
  const fixture = await imageBuildFixture(sourceDirectory);
  const access = createImageAccessStore({ directory: join(directory, 'keys') });
  const { admission } = fixture;
  admission.access = await access.prepare({
    buildId: admission.id,
    manifestDigest: admission.source.manifestDigest,
    managementAddress: admission.access.managementAddress,
  });
  await admitImageBuild({ ...fixture, db: database.connection.db, sourceDirectory });
  const inspection = () => inspectImageBuild(database.connection.db, admission.id);
  const installed = {
    kind: 'installed',
    receipt: {
      kind: 'builder',
      builderId: admission.id,
      manifestDigest: admission.source.manifestDigest,
      machineId: 'a'.repeat(32),
    },
  } satisfies Awaited<ReturnType<Remote['install']>>;
  let complete = false;
  const remote = {
    inspect: vi.fn<Remote['inspect']>(() =>
      Promise.resolve(complete ? installed : { kind: 'not_started' }),
    ),
    upload: vi.fn<Remote['upload']>((input) =>
      Promise.resolve({
        kind: 'uploaded',
        manifestDigest: input.boot.manifestDigest,
        checksumDigest: input.checksumDigest,
      }),
    ),
    install: vi.fn<Remote['install']>(() => {
      complete = true;
      return Promise.resolve(installed);
    }),
    sanitize: vi.fn<Remote['sanitize']>(() =>
      Promise.resolve({
        kind: 'sanitized',
        builderId: admission.id,
        manifestDigest: admission.source.manifestDigest,
      }),
    ),
  };
  const input = {
    connection: database.connection,
    buildId: admission.id,
    provider: new ImageProviderFixture(),
    access,
    remote,
    sourceDirectory,
    limits: fixture.limits,
    pricing: vi.fn(() => Promise.resolve(imagePricing())),
  };
  const cleanup = async () => {
    for (let pass = 0; pass < 12; pass++) {
      if ((await advanceImageBuild(input)).kind === 'cleaned') return;
    }
    throw new Error('Controller did not finish cleanup.');
  };
  return {
    ...input,
    admission,
    inspection,
    cleanup,
    advance: () => advanceImageBuild(input),
    installed,
    complete: () => {
      complete = true;
    },
  };
}

it('builds through a stopped snapshot, awaits verification, and aborts with authoritative resource and key cleanup', async () => {
  const fixture = await scenario();
  for (let pass = 0; pass < 8; pass++) await fixture.advance();
  expect(await fixture.advance()).toMatchObject({ kind: 'verification_required' });
  expect(await fixture.advance()).toMatchObject({ kind: 'verification_required' });
  const commands = fixture.provider.submitted.map((command) => command.kind);
  expect(commands).toEqual([
    'create_ssh_key',
    'create_firewall',
    'create_primary_ip',
    'create_server',
    'power_off',
    'create_snapshot',
  ]);
  expect(fixture.remote.install).toHaveBeenCalledOnce();
  expect(fixture.remote.sanitize).toHaveBeenCalledOnce();
  expect((await fixture.inspection()).builderWork).toMatchObject({
    progress: { kind: 'sanitized' },
  });
  await fixture.access.recover(fixture.admission);
  await requestImageCleanup(database.connection.db, fixture.buildId);
  await fixture.cleanup();
  expect(fixture.provider.resources.size).toBe(0);
  expect(await readdir(join(directory, 'keys'))).toEqual([]);
  expect((await fixture.inspection()).state.kind).toBe('cleaned');
  expect(
    (await fixture.inspection()).resources.every((resource) => resource.state.kind === 'absent'),
  ).toBe(true);
  expect(fixture.pricing).toHaveBeenCalledTimes(5);
  expect(await fixture.advance()).toMatchObject({ kind: 'cleaned' });
});

it.each([0, 1, 4, 5, 6, 7, 8])(
  'honors cancellation after %i passes without further build work',
  async (passes) => {
    const fixture = await scenario();
    for (let pass = 0; pass < passes; pass++) await fixture.advance();
    const before = fixture.provider.submitted.length;
    const remoteCalls = [
      fixture.remote.upload.mock.calls.length,
      fixture.remote.install.mock.calls.length,
      fixture.remote.sanitize.mock.calls.length,
    ];
    await requestImageCleanup(database.connection.db, fixture.buildId);
    await fixture.cleanup();
    expect(
      fixture.provider.submitted.slice(before).every((command) => command.kind === 'delete'),
    ).toBe(true);
    expect([
      fixture.remote.upload.mock.calls.length,
      fixture.remote.install.mock.calls.length,
      fixture.remote.sanitize.mock.calls.length,
    ]).toEqual(remoteCalls);
    expect(fixture.provider.resources.size).toBe(0);
    expect(await readdir(join(directory, 'keys'))).toEqual([]);
  },
);

it('holds access and reservations for an unknown create after cancellation, and never submits that create again', async () => {
  const fixture = await scenario();
  for (let pass = 0; pass < 3; pass++) await fixture.advance();
  fixture.provider.mode = 'invisible';
  await fixture.advance();
  await fixture.advance();
  expect(fixture.provider.submitted).toHaveLength(4);
  await requestImageCleanup(database.connection.db, fixture.buildId);
  for (let pass = 0; pass < 3; pass++)
    expect(await fixture.advance()).toMatchObject({ kind: 'waiting' });
  expect(fixture.provider.submitted).toHaveLength(4);
  expect((await fixture.inspection()).state.kind).toBe('cleaning');
  await fixture.access.recover(fixture.admission);
});

it('recovers a lost install response after a controller restart and disposes an uncertain sanitation result', async () => {
  const fixture = await scenario();
  for (let pass = 0; pass < 4; pass++) await fixture.advance();
  fixture.remote.install.mockImplementationOnce(() => {
    fixture.complete();
    return Promise.reject(new CloudError('guest_unreachable', 'Lost result.', true));
  });
  expect(await fixture.advance()).toMatchObject({
    kind: 'builder',
    result: { value: { kind: 'waiting' } },
  });
  const restarted = connect(database.databaseUrl);
  try {
    expect(
      await advanceImageBuild({
        ...fixture,
        connection: restarted,
        access: createImageAccessStore({ directory: join(directory, 'keys') }),
      }),
    ).toMatchObject({ kind: 'builder', result: { value: { progress: { kind: 'installed' } } } });
  } finally {
    await restarted.pool.end();
  }
  expect(fixture.remote.install).toHaveBeenCalledOnce();
  fixture.remote.sanitize.mockRejectedValueOnce(
    new CloudError('guest_unreachable', 'Lost result.', true),
  );
  await fixture.advance();
  await fixture.cleanup();
  expect(fixture.remote.sanitize).toHaveBeenCalledOnce();
  expect(fixture.provider.submitted.some((command) => command.kind === 'create_snapshot')).toBe(
    false,
  );
  expect(fixture.provider.resources.size).toBe(0);
});

it('retries local key removal after provider cleanup without recreating or deleting resources again', async () => {
  const fixture = await scenario();
  await fixture.advance();
  await requestImageCleanup(database.connection.db, fixture.buildId);
  vi.spyOn(fixture.access, 'remove').mockRejectedValueOnce(
    new Error('Local filesystem unavailable.'),
  );
  await expect(fixture.cleanup()).rejects.toThrow('Local filesystem unavailable');
  expect((await fixture.inspection()).state.kind).toBe('cleaned');
  expect(fixture.provider.resources.size).toBe(0);
  await fixture.access.recover(fixture.admission);
  const count = fixture.provider.submitted.length;
  expect(await fixture.advance()).toMatchObject({ kind: 'cleaned' });
  expect(fixture.provider.submitted).toHaveLength(count);
  expect(await readdir(join(directory, 'keys'))).toEqual([]);
});

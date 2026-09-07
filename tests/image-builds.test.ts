import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  newId,
  imageBuildIdSchema,
  imageBuildLabels,
  type ImageProviderCommand,
} from '../packages/contracts/dist/index.js';
import {
  machines,
  allocations,
  providerResources,
  imageBuildEffects,
  imageBuilds,
  imageBuildResources,
} from '../packages/db/dist/index.js';
import {
  admitImageBuild,
  inspectImageBuild,
  requestImageCleanup,
} from '../apps/control/dist/image-builds.js';
import {
  checkImageAdmission,
  checkImagePrices,
  imageReservation,
} from '../apps/control/dist/image-budget.js';
import { runImageEffect } from '../apps/control/dist/image-effect-journal.js';
import { planImageCleanup } from '../apps/control/dist/image-cleanup.js';
import { imageBuildFixture, ImageProviderFixture, imagePricing } from './image-build-fixture.js';
import { testDatabase, seedAccount } from './database.js';
import { readHetznerImagePrice } from '../packages/hetzner/dist/image-pricing.js';

let database: Awaited<ReturnType<typeof testDatabase>>;
let directory: string;
let fixture: Awaited<ReturnType<typeof imageBuildFixture>>;
let provider: ImageProviderFixture;
beforeAll(async () => {
  database = await testDatabase();
});
afterAll(async () => {
  await database.close();
});
beforeEach(async () => {
  await database.reset();
  directory = await mkdtemp(join(tmpdir(), 'agent-cloud-build-'));
  fixture = await imageBuildFixture(directory);
  provider = new ImageProviderFixture();
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const admit = () =>
  admitImageBuild({ ...fixture, db: database.connection.db, sourceDirectory: directory });
function keyCommand(): ImageProviderCommand {
  return {
    kind: 'create_ssh_key',
    name: 'image-access',
    labels: imageBuildLabels(fixture.admission.id, 'access_key'),
    publicKey: fixture.admission.access.publicKey,
  };
}
const run = (command: ImageProviderCommand, pricing = () => Promise.resolve(imagePricing())) =>
  runImageEffect({
    connection: database.connection,
    buildId: fixture.admission.id,
    command,
    provider,
    limits: fixture.limits,
    pricing,
  });
const inspect = () => inspectImageBuild(database.connection.db, fixture.admission.id);
const cleanup = () =>
  planImageCleanup({ connection: database.connection, buildId: fixture.admission.id, provider });

it('prevents customer and image journals from claiming the same provider ID concurrently', async () => {
  await admit();
  const db = database.connection.db;
  const account = await seedAccount(db, { currency: 'USD' });
  const machineId = newId.machine();
  const allocationId = newId.allocation();
  await db.insert(machines).values({
    id: machineId,
    accountId: account.principal.accountId,
    projectId: account.projectId,
    name: 'scope-test',
    spec: { size: 'small', region: 'nbg1', name: 'scope-test' },
    provider: 'hetzner',
    state: { kind: 'provisioning', allocationId },
  });
  await db.insert(allocations).values({
    id: allocationId,
    accountId: account.principal.accountId,
    machineId,
    provider: 'hetzner',
    networkProfile: 'primary_ip_v1',
    currency: 'USD',
    hourlyMicros: 27798,
  });
  const effectId = randomUUID();
  await db.insert(imageBuildEffects).values({
    id: effectId,
    buildId: fixture.admission.id,
    effectKey: 'create:builder_ip',
    command: {
      kind: 'create_primary_ip',
      name: 'builder-ip',
      labels: imageBuildLabels(fixture.admission.id, 'builder_ip'),
      region: 'nbg1',
    },
  });
  const outcomes = await Promise.allSettled([
    db.insert(imageBuildResources).values({
      provider: 'hetzner',
      kind: 'primary_ip',
      providerId: '900',
      buildId: fixture.admission.id,
      effectId,
      role: 'builder_ip',
    }),
    db.insert(providerResources).values({
      provider: 'hetzner',
      kind: 'primary_ip',
      providerId: '900',
      accountId: account.principal.accountId,
      allocationId,
      labels: { managed_by: 'agent-cloud' },
    }),
  ]);
  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  expect(
    (await db.select().from(imageBuildResources)).length +
      (await db.select().from(providerResources)).length,
  ).toBe(1);
  const imageOwnsFirst = (await db.select().from(imageBuildResources)).length === 1;
  if (imageOwnsFirst) {
    await db.insert(providerResources).values({
      provider: 'hetzner',
      kind: 'primary_ip',
      providerId: '901',
      accountId: account.principal.accountId,
      allocationId,
      labels: {},
    });
  } else {
    await db.insert(imageBuildResources).values({
      provider: 'hetzner',
      kind: 'primary_ip',
      providerId: '901',
      buildId: fixture.admission.id,
      effectId,
      role: 'builder_ip',
    });
  }
  await expect(
    db.update(providerResources).set({ providerId: imageOwnsFirst ? '900' : '901' }),
  ).rejects.toThrow();
});

it('rounds each of two VM and IPv4 lifetimes upward and reserves a full snapshot month', () => {
  expect(imageReservation(fixture.admission)).toEqual({
    vmGrossMicros: 111192,
    snapshotMonthlyGrossMicros: 979080,
  });
  expect(() => {
    checkImageAdmission(
      { ...fixture.admission, budget: { ...fixture.admission.budget, maxVmGrossMicros: 111191 } },
      Date.now(),
    );
  }).toThrow('caps');
  expect(() => {
    checkImageAdmission(
      {
        ...fixture.admission,
        budget: { ...fixture.admission.budget, maxSnapshotMonthlyGrossMicros: 979079 },
      },
      Date.now(),
    );
  }).toThrow('caps');
});

it('admits no resource, replays the same admission, and rejects reusing its identity', async () => {
  expect(await admit()).toMatchObject({ state: { kind: 'running' } });
  expect(await admit()).toMatchObject({ state: { kind: 'running' } });
  expect(await inspect()).toMatchObject({ effects: [], resources: [] });
  fixture.admission.baseImageId = '101';
  await expect(admit()).rejects.toThrow('different admission');
  expect(provider.submitted).toEqual([]);
});

it('reserves the operator allowance atomically across concurrent admissions', async () => {
  const input = { ...fixture, db: database.connection.db, sourceDirectory: directory };
  const results = await Promise.allSettled([
    admitImageBuild(input),
    admitImageBuild({
      ...input,
      admission: { ...fixture.admission, id: imageBuildIdSchema.parse(randomUUID()) },
    }),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(await database.connection.db.select().from(imageBuilds)).toHaveLength(1);
});

it('rejects tampered public inputs before recording any admission', async () => {
  await writeFile(join(directory, 'install.sh'), 'replaced');
  await expect(admit()).rejects.toThrow('inventory');
  expect(await database.connection.db.select().from(imageBuilds)).toEqual([]);
});

it.each(['currency', 'server_price', 'ipv4_price', 'type', 'disk', 'expiry', 'storage'])(
  'refuses fresh effects after %s changes without releasing existing ownership',
  async (change) => {
    await admit();
    const prices = imagePricing();
    const offer = prices.catalog.items[0];
    if (!offer) throw new Error('Missing fixture offer.');
    if (change === 'currency') offer.currency = 'EUR';
    if (change === 'server_price') {
      offer.serverHourlyMicros += 1;
      offer.ipv4HourlyMicros -= 1;
    }
    if (change === 'ipv4_price') {
      offer.ipv4HourlyMicros += 1;
      offer.serverHourlyMicros -= 1;
    }
    if (change === 'type') offer.serverType = 'expensive';
    if (change === 'disk') offer.diskGb = 80;
    if (change === 'expiry') prices.catalog.expiresAt = new Date(0).toISOString();
    if (change === 'storage') prices.storagePrice.grossMicrosPerGbMonth += 1;
    expect(() => {
      checkImagePrices({ admission: fixture.admission, ...prices, now: Date.now() });
    }).toThrow();
    await expect(run(keyCommand(), () => Promise.resolve(prices))).rejects.toThrow();
    expect(provider.submitted).toEqual([]);
    expect((await inspect()).state.kind).toBe('running');
  },
);

it('recovers a lost create response using its exact labels without another submission', async () => {
  await admit();
  provider.mode = 'lost';
  expect(await run(keyCommand())).toMatchObject({ kind: 'acquired', value: { kind: 'confirmed' } });
  expect(await run(keyCommand())).toMatchObject({ kind: 'acquired', value: { kind: 'confirmed' } });
  expect(provider.submitted).toHaveLength(1);
  const state = await inspect();
  expect(state.effects[0]).toMatchObject({
    outcome: { kind: 'unknown' },
    resolution: { kind: 'confirmed' },
  });
  expect(state.resources).toHaveLength(1);
});

it('keeps a crash after preparation unresolved even when lookup finds nothing', async () => {
  await admit();
  const command = keyCommand();
  await database.connection.db.insert(imageBuildEffects).values({
    id: randomUUID(),
    buildId: fixture.admission.id,
    effectKey: 'create:access_key',
    command,
  });
  expect(await run(command)).toMatchObject({ value: { kind: 'pending' } });
  expect(await run(command)).toMatchObject({ value: { kind: 'pending' } });
  expect(await cleanup()).toMatchObject({ value: { kind: 'waiting' } });
  expect(provider.submitted).toEqual([]);
  const second = { ...fixture.admission, id: imageBuildIdSchema.parse(randomUUID()) };
  await expect(
    admitImageBuild({
      ...fixture,
      admission: second,
      sourceDirectory: directory,
      db: database.connection.db,
    }),
  ).rejects.toThrow('operator limits');
});

it('retains every duplicate create identity and never chooses one as successful', async () => {
  await admit();
  provider.mode = 'invisible';
  expect(await run(keyCommand())).toMatchObject({ value: { kind: 'pending' } });
  for (const id of ['100', '101'])
    provider.add({
      kind: 'ssh_key',
      id,
      labels: imageBuildLabels(fixture.admission.id, 'access_key'),
      publicKey: fixture.admission.access.publicKey,
      fingerprint: id,
    });
  expect(await run(keyCommand())).toMatchObject({
    value: { kind: 'pending', reason: 'Duplicate image resources require reconciliation.' },
  });
  expect((await inspect()).resources.map((resource) => resource.ref.id)).toEqual(['100', '101']);
  expect(provider.submitted).toHaveLength(1);
  provider.mode = 'normal';
  for (let index = 0; index < 2; index++) {
    const plan = await cleanup();
    if (plan.kind !== 'acquired' || plan.value.kind !== 'delete')
      throw new Error('Expected duplicate cleanup.');
    await run(plan.value.command);
  }
  expect(provider.resources.size).toBe(0);
  expect(await cleanup()).toMatchObject({ value: { kind: 'waiting' } });
  expect(
    (await inspect()).effects.find((effect) => effect.command.kind === 'create_ssh_key')?.resolution
      .kind,
  ).toBe('pending');
});

it.each(['prepared', 'unknown'])(
  'recovers a %s delete with a new exact-ID attempt and immutable original receipt',
  async (state) => {
    await admit();
    await run(keyCommand());
    const plan = await cleanup();
    if (plan.kind !== 'acquired' || plan.value.kind !== 'delete')
      throw new Error('Expected deletion.');
    const command = plan.value.command;
    const id = randomUUID();
    await database.connection.db.insert(imageBuildEffects).values({
      id,
      buildId: fixture.admission.id,
      effectKey: `delete:${command.resource.kind}:${command.resource.id}:1`,
      command,
    });
    if (state === 'unknown')
      await database.connection.db
        .update(imageBuildEffects)
        .set({ outcome: { kind: 'unknown', reason: 'Lost before mutation.' } })
        .where(eq(imageBuildEffects.id, id));
    await run(command);
    const effects = (await inspect()).effects.filter((effect) => effect.command.kind === 'delete');
    expect(effects[0]).toMatchObject({
      outcome: { kind: state },
      resolution: { kind: 'superseded', byEffectId: effects[1]?.id },
    });
    expect(effects[1]).toMatchObject({ resolution: { kind: 'confirmed' } });
    expect(await cleanup()).toMatchObject({ value: { kind: 'cleaned' } });
  },
);

it('cleans duplicates after an accepted create action succeeds while retaining unresolved ownership', async () => {
  await admit();
  const id = randomUUID();
  const labels = imageBuildLabels(fixture.admission.id, 'builder_ip');
  await database.connection.db.insert(imageBuildEffects).values({
    id,
    buildId: fixture.admission.id,
    effectKey: 'create:builder_ip',
    command: { kind: 'create_primary_ip', name: 'builder-ip', labels, region: 'nbg1' },
  });
  await database.connection.db
    .update(imageBuildEffects)
    .set({
      outcome: { kind: 'accepted', resource: { kind: 'primary_ip', id: '800' }, actionId: '777' },
    })
    .where(eq(imageBuildEffects.id, id));
  for (const providerId of ['800', '801'])
    provider.add({
      kind: 'primary_ip',
      id: providerId,
      labels,
      region: 'nbg1',
      ipv4: '203.0.113.9',
      autoDelete: false,
      serverId: null,
    });
  for (let index = 0; index < 2; index++) {
    const plan = await cleanup();
    if (plan.kind !== 'acquired' || plan.value.kind !== 'delete')
      throw new Error('Expected duplicate cleanup.');
    await run(plan.value.command);
  }
  expect(provider.resources.size).toBe(0);
  expect(await cleanup()).toMatchObject({ value: { kind: 'waiting' } });
});

async function builder() {
  await run(keyCommand());
  await run({
    kind: 'create_firewall',
    name: 'access-firewall',
    labels: imageBuildLabels(fixture.admission.id, 'access_firewall'),
    managementAddress: fixture.admission.access.managementAddress,
  });
  await run({
    kind: 'create_primary_ip',
    name: 'builder-ip',
    labels: imageBuildLabels(fixture.admission.id, 'builder_ip'),
    region: 'nbg1',
  });
  await run({
    kind: 'create_server',
    name: 'builder',
    labels: imageBuildLabels(fixture.admission.id, 'builder'),
    serverType: 'cpx12',
    region: 'nbg1',
    imageId: '100',
    primaryIpId: '1003',
    sshKeyId: '1001',
    firewallId: '1002',
    bootData: {
      kind: 'image_build_secret',
      id: fixture.admission.access.secretId,
      digest: fixture.admission.source.manifestDigest,
    },
  });
}

it('requires recorded sanitation and observed shutdown before a snapshot, then deletes all owned resource kinds', async () => {
  await admit();
  await builder();
  const command: ImageProviderCommand = {
    kind: 'create_snapshot',
    name: 'snapshot',
    labels: imageBuildLabels(fixture.admission.id, 'snapshot'),
    serverId: '1004',
  };
  await expect(run(command)).rejects.toThrow('sanitized');
  const stop: ImageProviderCommand = {
    kind: 'power_off',
    serverId: '1004',
    sanitation: {
      kind: 'sanitized',
      builderId: fixture.admission.id,
      manifestDigest: fixture.admission.source.manifestDigest,
    },
  };
  await database.connection.db.insert(imageBuildEffects).values({
    id: randomUUID(),
    buildId: fixture.admission.id,
    effectKey: 'power_off:1004:1',
    command: stop,
  });
  expect(await run(stop)).toMatchObject({ value: { kind: 'confirmed' } });
  expect(await run(command)).toMatchObject({ value: { kind: 'confirmed' } });
  for (let index = 0; index < 5; index++) {
    const plan = await cleanup();
    if (plan.kind !== 'acquired' || plan.value.kind !== 'delete')
      throw new Error('Expected owned resource cleanup.');
    if (index === 0) expect(plan.value.command).toMatchObject({ resource: { kind: 'server' } });
    await run(plan.value.command);
  }
  expect(await cleanup()).toMatchObject({ value: { kind: 'cleaned' } });
  expect(provider.resources.size).toBe(0);
});

it('operator CLI inspects and cancels through the real database without provider credentials', async () => {
  await admit();
  const exec = promisify(execFile);
  for (const command of ['inspect', 'cancel']) {
    const result = await exec(
      process.execPath,
      ['--import', 'tsx', 'scripts/image-build.ts', command, fixture.admission.id],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: database.databaseUrl,
          HCLOUD_TOKEN_FILE: '/no-provider-token',
        },
      },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      admission: { id: fixture.admission.id },
      state: { kind: command === 'inspect' ? 'running' : 'cleaning' },
    });
  }
});

it('operator CLI replays an admission without provider credentials and rejects changed intent', async () => {
  await admit();
  const admission = fixture.admission;
  const config = {
    id: admission.id,
    sourceDirectory: directory,
    manifestDigest: admission.source.manifestDigest,
    offer: { size: 'small', region: 'nbg1' },
    provider: {
      currency: 'USD',
      architecture: 'x86',
      serverTypes: { small: 'cpx12', medium: 'cx33', large: 'cx43' },
    },
    baseImageId: admission.baseImageId,
    access: admission.access,
    budget: admission.budget,
    limits: fixture.limits,
    durationMinutes: 90,
    retention: admission.retention,
  };
  // Configuration stays outside the complete public input tree.
  const configPath = join(tmpdir(), `agent-cloud-build-${randomUUID()}.json`);
  try {
    await writeFile(configPath, JSON.stringify(config));
    const exec = promisify(execFile);
    const args = ['--import', 'tsx', 'scripts/image-build.ts', 'admit', configPath];
    const options = {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: database.databaseUrl,
        HCLOUD_TOKEN_FILE: '/no-provider-token',
      },
    };
    const result = await exec(process.execPath, args, options);
    expect(JSON.parse(result.stdout)).toMatchObject({ admission: { id: admission.id } });
    await writeFile(configPath, JSON.stringify({ ...config, durationMinutes: 91 }));
    await expect(exec(process.execPath, args, options)).rejects.toThrow('idempotency_conflict');
  } finally {
    await rm(configPath, { force: true });
  }
});

it('reads gross snapshot storage prices and rounds fractional micro-units upward', async () => {
  const paths: string[] = [];
  const result = await readHetznerImagePrice((request) => {
    paths.push(request.path);
    return Promise.resolve({
      pricing: { currency: 'USD', image: { price_per_gb_month: { net: '0', gross: '0.0244771' } } },
    });
  });
  expect(paths).toEqual(['/pricing']);
  expect(result).toMatchObject({ currency: 'USD', grossMicrosPerGbMonth: 24478 });
  expect(Date.parse(result.expiresAt) - Date.parse(result.observedAt)).toBe(300000);
});

it('serializes concurrent execution of the same create through its durable intent', async () => {
  await admit();
  const results = await Promise.all([run(keyCommand()), run(keyCommand())]);
  expect(results.some((result) => result.kind === 'acquired')).toBe(true);
  expect(provider.submitted).toHaveLength(1);
  expect((await inspect()).effects).toHaveLength(1);
});

it('cleanup needs observed absence and continues with unavailable pricing and zero fresh budget', async () => {
  await admit();
  await run(keyCommand());
  const plan = await cleanup();
  if (plan.kind !== 'acquired' || plan.value.kind !== 'delete')
    throw new Error('Expected owned deletion.');
  fixture.limits.maxOpenBuilds = 0;
  await run(plan.value.command, () => Promise.reject(new Error('Cleanup must not fetch pricing.')));
  expect(await cleanup()).toMatchObject({ value: { kind: 'cleaned' } });
  expect((await inspect()).resources).toMatchObject([{ state: { kind: 'absent' } }]);
  expect(provider.resources.size).toBe(0);
});

it('retries only a definitively failed deletion and preserves the original failure', async () => {
  await admit();
  await run(keyCommand());
  const plan = await cleanup();
  if (plan.kind !== 'acquired' || plan.value.kind !== 'delete')
    throw new Error('Expected deletion.');
  provider.mode = 'rejected';
  await run(plan.value.command);
  provider.mode = 'normal';
  await run(plan.value.command);
  const effects = (await inspect()).effects;
  expect(effects.filter((effect) => effect.command.kind === 'delete')).toMatchObject([
    { outcome: { kind: 'rejected' }, resolution: { kind: 'failed' } },
    { outcome: { kind: 'completed' }, resolution: { kind: 'confirmed' } },
  ]);
  expect(await cleanup()).toMatchObject({ value: { kind: 'cleaned' } });
});

it('does not delete a resource after provider labels change', async () => {
  await admit();
  await run(keyCommand());
  const resource = [...provider.resources.values()][0];
  if (!resource) throw new Error('Missing resource.');
  provider.add({ ...resource, labels: { ...resource.labels, build_id: randomUUID() } });
  await expect(cleanup()).rejects.toThrow('ownership');
  expect(provider.submitted).toHaveLength(1);
});

it('database guards retain immutable admission, intent, receipt, resolution and ownership', async () => {
  await admit();
  await run(keyCommand());
  const db = database.connection.db;
  const build = await inspect();
  const effect = build.effects[0];
  if (!effect) throw new Error('Missing effect.');
  await expect(
    db
      .update(imageBuilds)
      .set({ admission: { ...fixture.admission, deadlineAt: new Date().toISOString() } }),
  ).rejects.toThrow();
  await expect(
    db
      .update(imageBuildEffects)
      .set({ command: { kind: 'delete' } })
      .where(eq(imageBuildEffects.id, effect.id)),
  ).rejects.toThrow();
  await expect(
    db.update(imageBuildEffects).set({ outcome: { kind: 'unknown', reason: 'changed' } }),
  ).rejects.toThrow();
  await expect(
    db.update(imageBuildEffects).set({ resolution: { kind: 'pending' } }),
  ).rejects.toThrow();
  await expect(db.update(imageBuildResources).set({ providerId: '999' })).rejects.toThrow();
  await expect(db.delete(imageBuildResources)).rejects.toThrow();
  await requestImageCleanup(db, fixture.admission.id);
  await expect(
    db.update(imageBuilds).set({ state: { kind: 'cleaned', at: new Date().toISOString() } }),
  ).rejects.toThrow();
  await expect(
    run({
      kind: 'create_primary_ip',
      name: 'late-ip',
      labels: imageBuildLabels(fixture.admission.id, 'builder_ip'),
      region: 'nbg1',
    }),
  ).rejects.toThrow('cleaning');
});

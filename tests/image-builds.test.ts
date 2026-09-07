import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  newId,
  imageBuildIdSchema,
  imageBuildLabels,
  imageEffectLabels,
  type ImageProviderCommand,
} from '../packages/contracts/dist/index.js';
import {
  machines,
  allocations,
  providerResources,
  imageBuildEffects,
  imageBuilds,
  imageBuildResources,
  imageBuilderWork,
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
import { observeImageResource, imageCreateMatches } from '../apps/control/dist/image-resources.js';
import { checkImageCommand } from '../apps/control/dist/image-effect-policy.js';
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
  const effectId = (await inspect()).effects[0]?.id;
  if (!effectId) throw new Error('Expected key effect.');
  for (const id of ['100', '101'])
    provider.add({
      kind: 'ssh_key',
      id,
      labels: imageEffectLabels({ buildId: fixture.admission.id, role: 'access_key', effectId }),
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

it.each(['missing', 'other', 'matching'])(
  'requires the exact effect label after an unknown create, with %s provider labels',
  async (label) => {
    await admit();
    provider.mode = 'invisible';
    await run(keyCommand());
    const effect = (await inspect()).effects[0];
    if (!effect) throw new Error('Expected create effect.');
    const base = imageBuildLabels(fixture.admission.id, 'access_key');
    const labels =
      label === 'missing'
        ? base
        : { ...base, effect_id: label === 'matching' ? effect.id : randomUUID() };
    const resource = {
      kind: 'ssh_key',
      id: '800',
      labels,
      publicKey: fixture.admission.access.publicKey,
      fingerprint: 'fixture',
    } satisfies Parameters<typeof provider.add>[0];
    provider.add(resource);
    const find = vi.spyOn(provider, 'find');
    // A malformed provider result must fail the same ownership check even if it ignores the selector.
    find.mockResolvedValue([resource]);
    expect(await run(keyCommand())).toMatchObject({
      value: { kind: label === 'matching' ? 'confirmed' : 'pending' },
    });
    expect(find).toHaveBeenCalledWith({
      kind: 'ssh_key',
      labels: { ...base, effect_id: effect.id },
    });
    expect((await inspect()).resources).toHaveLength(label === 'matching' ? 1 : 0);
    expect(provider.submitted).toHaveLength(1);
  },
);

it.each(['missing', 'other'])(
  'retains an accepted receipt with a %s effect label without confirming or deleting it',
  async (label) => {
    await admit();
    const effectId = randomUUID();
    const command = keyCommand();
    await database.connection.db.insert(imageBuildEffects).values({
      id: effectId,
      buildId: fixture.admission.id,
      effectKey: 'create:access_key',
      command,
    });
    await database.connection.db
      .update(imageBuildEffects)
      .set({
        outcome: { kind: 'accepted', resource: { kind: 'ssh_key', id: '800' }, actionId: '777' },
      })
      .where(eq(imageBuildEffects.id, effectId));
    provider.action = { kind: 'missing' };
    const base = imageBuildLabels(fixture.admission.id, 'access_key');
    provider.add({
      kind: 'ssh_key',
      id: '800',
      labels: label === 'missing' ? base : { ...base, effect_id: randomUUID() },
      publicKey: fixture.admission.access.publicKey,
      fingerprint: 'fixture',
    });
    expect(await run(command)).toMatchObject({ value: { kind: 'pending' } });
    expect((await inspect()).resources).toMatchObject([
      { ref: { kind: 'ssh_key', id: '800' }, state: { kind: 'unverified' } },
    ]);
    await expect(cleanup()).rejects.toThrow('ownership');
    expect(provider.submitted).toEqual([]);
  },
);

it.each(['missing', 'other'])(
  'rejects changed %s effect labels in observations, dependencies, deletion policy and SQL',
  async (label) => {
    await admit();
    await builder();
    const build = await inspect();
    const effect = build.effects.find((effect) => effect.command.kind === 'create_server');
    const resource = provider.resources.get('server:1004');
    if (!effect || !resource) throw new Error('Expected builder.');
    const base = imageBuildLabels(fixture.admission.id, 'builder');
    const changed = {
      ...resource,
      labels: label === 'missing' ? base : { ...base, effect_id: randomUUID() },
    };
    const ref = { kind: 'server', id: '1004' } satisfies { kind: 'server'; id: string };
    provider.add(changed);
    expect(imageCreateMatches(build, effect, changed)).toBe(false);
    await expect(observeImageResource(database.connection.db, build, ref, changed)).rejects.toThrow(
      'ownership',
    );
    await expect(
      checkImageCommand(build, { kind: 'delete', resource: ref }, provider),
    ).rejects.toThrow('ownership');
    await expect(
      checkImageCommand(
        build,
        {
          kind: 'create_snapshot',
          serverId: ref.id,
          name: 'snapshot',
          labels: imageBuildLabels(fixture.admission.id, 'snapshot'),
        },
        provider,
      ),
    ).rejects.toThrow('ownership');
    await expect(
      database.connection.db
        .update(imageBuildResources)
        .set({ state: { kind: 'observed', resource: changed, at: new Date().toISOString() } })
        .where(eq(imageBuildResources.providerId, ref.id)),
    ).rejects.toThrow();
  },
);

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

it.each(['present', 'absent', 'running', 'lookup_failed'])(
  'reconciles an accepted delete with %s state without rewriting its receipt',
  async (state) => {
    await admit();
    await run(keyCommand());
    const plan = await cleanup();
    if (plan.kind !== 'acquired' || plan.value.kind !== 'delete')
      throw new Error('Expected deletion.');
    const command = plan.value.command;
    const id = randomUUID();
    const outcome = { kind: 'accepted', resource: command.resource, actionId: '777' } satisfies {
      kind: 'accepted';
      resource: typeof command.resource;
      actionId: string;
    };
    await database.connection.db.insert(imageBuildEffects).values({
      id,
      buildId: fixture.admission.id,
      effectKey: `delete:${command.resource.kind}:${command.resource.id}:1`,
      command,
    });
    await database.connection.db
      .update(imageBuildEffects)
      .set({ outcome })
      .where(eq(imageBuildEffects.id, id));
    provider.action = { kind: state === 'running' ? 'running' : 'missing' };
    if (state === 'absent') provider.resources.clear();
    if (state === 'lookup_failed')
      vi.spyOn(provider, 'getAction').mockRejectedValue(new Error('Lookup unavailable.'));
    if (state === 'lookup_failed') await expect(run(command)).rejects.toThrow('Lookup unavailable');
    else
      expect(await run(command)).toMatchObject({
        value: { kind: state === 'running' ? 'pending' : 'confirmed' },
      });
    const effects = (await inspect()).effects.filter((effect) => effect.command.kind === 'delete');
    expect(effects[0]?.outcome).toEqual(outcome);
    expect(provider.submitted).toHaveLength(state === 'present' ? 2 : 1);
    expect(effects).toHaveLength(state === 'present' ? 2 : 1);
    expect(effects[0]?.resolution.kind).toBe(
      state === 'present' ? 'superseded' : state === 'absent' ? 'confirmed' : 'pending',
    );
  },
);

it.each(['present', 'absent'])(
  'does not repeat an accepted create after its action disappears and the resource is %s',
  async (state) => {
    await admit();
    const command = keyCommand();
    const id = randomUUID();
    await database.connection.db
      .insert(imageBuildEffects)
      .values({ id, buildId: fixture.admission.id, effectKey: 'create:access_key', command });
    await database.connection.db
      .update(imageBuildEffects)
      .set({
        outcome: { kind: 'accepted', resource: { kind: 'ssh_key', id: '800' }, actionId: '777' },
      })
      .where(eq(imageBuildEffects.id, id));
    provider.action = { kind: 'missing' };
    if (state === 'present')
      provider.add({
        kind: 'ssh_key',
        id: '800',
        labels: imageEffectLabels({
          buildId: fixture.admission.id,
          role: 'access_key',
          effectId: id,
        }),
        publicKey: fixture.admission.access.publicKey,
        fingerprint: 'fixture',
      });
    for (let index = 0; index < 2; index++)
      expect(await run(command)).toMatchObject({
        value: { kind: state === 'present' ? 'confirmed' : 'pending' },
      });
    expect(provider.submitted).toEqual([]);
    expect((await inspect()).resources).toHaveLength(1);
  },
);

it.each([
  'id',
  'type',
  'status',
  'architecture',
  'os',
  'version',
  'disk',
  'deprecated',
  'deleted',
  'missing',
])(
  'rejects incompatible pinned base-image %s before recording or submitting a create',
  async (change) => {
    await admit();
    const base = await provider.getBaseImage(fixture.admission.baseImageId);
    if (!base) throw new Error('Fixture image absent.');
    switch (change) {
      case 'id':
        base.id = '101';
        break;
      case 'type':
        base.type = 'snapshot';
        break;
      case 'status':
        base.status = 'unavailable';
        break;
      case 'architecture':
        base.architecture = 'arm';
        break;
      case 'os':
        base.osFlavor = 'debian';
        break;
      case 'version':
        base.osVersion = '22.04';
        break;
      case 'disk':
        base.diskGb = 41;
        break;
      case 'deprecated':
        base.deprecated = true;
        break;
      case 'deleted':
        base.deleted = true;
        break;
    }
    vi.spyOn(provider, 'getBaseImage').mockResolvedValue(change === 'missing' ? null : base);
    await expect(run(keyCommand())).rejects.toThrow('base image');
    expect(provider.submitted).toEqual([]);
    expect((await inspect()).effects).toEqual([]);
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
      labels: { ...labels, effect_id: id },
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
  await expect(run(stop)).rejects.toThrow('Sanitation receipt');
  const build = await inspect();
  const source = build.resources.find((resource) => resource.role === 'builder');
  if (!source) throw new Error('Expected the builder resource.');
  await database.connection.db
    .insert(imageBuilderWork)
    .values({ buildId: fixture.admission.id, effectId: source.effectId, serverId: source.ref.id });
  const installation = {
    kind: 'builder',
    builderId: fixture.admission.id,
    manifestDigest: fixture.admission.source.manifestDigest,
    machineId: 'a'.repeat(32),
  };
  for (const progress of [
    { kind: 'installed', installation },
    { kind: 'sanitizing', installation },
    { kind: 'sanitized', installation, sanitation: stop.sanitation },
  ])
    await database.connection.db
      .update(imageBuilderWork)
      .set({ progress })
      .where(eq(imageBuilderWork.buildId, fixture.admission.id));
  await database.connection.db.insert(imageBuildEffects).values({
    id: randomUUID(),
    buildId: fixture.admission.id,
    effectKey: 'power_off:1004:1',
    command: stop,
  });
  const submit = provider.submit.bind(provider);
  const delayedShutdown = vi.spyOn(provider, 'submit').mockImplementation(async (input) => {
    if (input.command.kind === 'power_off') {
      return {
        kind: 'accepted',
        resource: { kind: 'server', id: input.command.serverId },
        actionId: '999',
      };
    }
    return submit(input);
  });
  provider.action = { kind: 'succeeded' };
  expect(await run(stop)).toMatchObject({ value: { kind: 'pending' } });
  await expect(run(command)).rejects.toThrow();
  expect(await run(stop)).toMatchObject({ value: { kind: 'pending' } });
  expect(delayedShutdown).toHaveBeenCalledTimes(1);
  const runningBuilder = provider.resources.get('server:1004');
  if (runningBuilder?.kind !== 'server') throw new Error('Expected the running builder.');
  provider.add({ ...runningBuilder, power: 'off' });
  expect(await run(stop)).toMatchObject({ value: { kind: 'confirmed' } });
  expect(delayedShutdown).toHaveBeenCalledTimes(1);
  delayedShutdown.mockRestore();
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

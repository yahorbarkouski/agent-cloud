import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  imageEffectLabels,
  imageResourceKindSchema,
  imageResourceRoleSchema,
  imageResourceStateSchema,
} from '../packages/contracts/dist/index.js';
import { imageBuildResources, imagePublications } from '../packages/db/dist/index.js';
import { readConfig } from '../apps/control/src/config.js';
import { createControlRecoveryVerifiers } from '../apps/control/src/control-recovery-verifiers.js';
import {
  createImageReleaseKeySource,
  initializeRuntimeIdentity,
} from '../apps/control/src/runtime-identity.js';
import { imageRuntimeConfigSchema } from '../apps/control/src/runtime-config.js';
import { verifiedImageScenario } from './image-publication-fixture.js';
import { testDatabase } from './database.js';

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
  directory = await mkdtemp(join(tmpdir(), 'acld-recovery-verifiers-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const resourcePaths = {
  server: 'servers',
  snapshot: 'images',
  primary_ip: 'primary_ips',
  ssh_key: 'ssh_keys',
  firewall: 'firewalls',
};

async function scenario() {
  const image = await verifiedImageScenario(database.connection, directory);
  const release = await image.publish();
  const build = await image.inspection();
  const [publication] = await database.connection.db
    .select()
    .from(imagePublications)
    .where(eq(imagePublications.buildId, image.buildId));
  const resources = await database.connection.db
    .select()
    .from(imageBuildResources)
    .where(eq(imageBuildResources.buildId, image.buildId));
  const input = {
    buildId: image.buildId,
    admission: build.admission,
    state: build.state,
    publication,
    resources,
  };
  const snapshot = [...image.provider.resources.values()].find(
    (resource) => resource.kind === 'snapshot',
  );
  if (!snapshot) throw new Error('Expected a retained fixture snapshot.');
  expect(build.state.kind).toBe('retained');
  expect(image.provider.resources.size).toBe(1);

  const config = readConfig({
    DATABASE_URL: database.databaseUrl,
    PROVIDER: 'hetzner',
    PROVIDER_CURRENCY: 'USD',
    MAX_PROVIDER_HOURLY: '0.03',
    HCLOUD_TOKEN_FILE: join(directory, 'provider-token'),
    AGENT_CLOUD_RUNTIME: join(directory, 'runtime.json'),
  });
  if (config.provider !== 'hetzner') throw new Error('Expected Hetzner configuration.');
  const token = 'fixture-recovery-token'.padEnd(64, 'x');
  await writeFile(config.providerTokenFile, token, { mode: 0o600, flag: 'wx' });
  const identityDirectory = join(directory, 'identity');
  await initializeRuntimeIdentity(identityDirectory);
  const keys = [
    ...(await createImageReleaseKeySource(identityDirectory)()),
    ...image.publication.keys,
  ];
  const policyFile = join(identityDirectory, 'release-policy.json');
  await writeFile(policyFile, JSON.stringify({ version: 1, keys }));
  const runtime = imageRuntimeConfigSchema.parse({
    version: 1,
    mode: 'image_factory',
    identityDirectory,
    images: {
      inputsDirectory: image.sourceDirectory,
      accessDirectory: join(directory, 'keys'),
      limits: image.limits,
    },
    // Recovery reads public release policy. Issuer files need not exist and are never opened.
    pki: {
      binary: '/usr/bin/false',
      caUrl: 'https://ca.fixture.test',
      tlsRootFile: join(directory, 'missing-root'),
      sshHostCaFile: join(directory, 'missing-host'),
      sshUserCaFile: join(directory, 'missing-user'),
      provisioner: 'fixture',
      provisionerPasswordFile: join(directory, 'missing-password'),
    },
  });
  await writeFile(config.runtimeConfigFile, JSON.stringify(runtime), { mode: 0o600, flag: 'wx' });
  const snapshotPath = `/v1/images/${snapshot.id}`;
  const snapshotReply = {
    image: {
      id: Number(snapshot.id),
      labels: snapshot.labels,
      type: 'snapshot',
      status: snapshot.status,
      architecture: snapshot.architecture,
      os_flavor: 'ubuntu',
      os_version: '24.04',
      disk_size: snapshot.diskGb,
      image_size: snapshot.imageSizeGb,
      created: snapshot.createdAt,
      created_from: snapshot.sourceServerId ? { id: Number(snapshot.sourceServerId) } : null,
      protection: { delete: snapshot.deleteProtected },
      deprecated: null,
      deleted: null,
    },
  };
  const replies = new Map<string, unknown>([[snapshotPath, snapshotReply]]);
  const paths = resources.map(
    (row) => `/v1/${resourcePaths[imageResourceKindSchema.parse(row.kind)]}/${row.providerId}`,
  );
  const requests: { method: string; path: string }[] = [];
  const transport: typeof fetch = (value, init) => {
    const request = new Request(value, init);
    const url = new URL(request.url);
    requests.push({ method: request.method, path: url.pathname });
    expect(request.method).toBe('GET');
    expect(url.origin).toBe('https://api.hetzner.cloud');
    expect(request.headers.get('authorization')).toBe(`Bearer ${token}`);
    expect(paths).toContain(url.pathname);
    if (request.method !== 'GET') throw new Error('Recovery fixture forbids provider mutations.');
    return Promise.resolve(
      replies.has(url.pathname)
        ? Response.json(replies.get(url.pathname))
        : Response.json({ error: { code: 'not_found' } }, { status: 404 }),
    );
  };
  const verifiers = createControlRecoveryVerifiers({
    connection: database.connection,
    config,
    transport,
  });
  const verify = () => verifiers.verifyImage(input);
  return {
    verifiers,
    verify,
    input,
    release,
    snapshot,
    snapshotPath,
    snapshotReply,
    replies,
    paths,
    requests,
    policyFile,
    keys,
  };
}

it('verifies the signed retained snapshot through exact read-only Hetzner lookups and private release policy', async () => {
  const f = await scenario();
  try {
    const first = await f.verify();
    expect(first.ok).toBe(true);
    expect(first.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(f.requests).toHaveLength(f.input.resources.length);
    expect(f.requests.map((request) => request.path).sort()).toEqual([...f.paths].sort());
    expect(
      f.input.resources.filter((row) => imageResourceStateSchema.parse(row.state).kind === 'absent')
        .length,
    ).toBeGreaterThan(0);
    expect(await f.verify()).toEqual(first);
    expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
  } finally {
    f.verifiers.close();
  }
});

it('rejects changed ownership even in matching recorded observations and rejects a reappeared tombstoned resource', async () => {
  const f = await scenario();
  try {
    expect((await f.verify()).ok).toBe(true);
    const altered = { ...f.snapshot, labels: { ...f.snapshot.labels, effect_id: randomUUID() } };
    f.replies.set(f.snapshotPath, { image: { ...f.snapshotReply.image, labels: altered.labels } });
    const changed = {
      ...f.input,
      resources: f.input.resources.map((row) => {
        const state = imageResourceStateSchema.parse(row.state);
        return row.role === 'snapshot' && state.kind === 'observed'
          ? { ...row, state: { ...state, resource: altered } }
          : row;
      }),
    };
    const rejected = await f.verifiers.verifyImage(changed);
    expect(rejected.ok).toBe(false);
    f.replies.set(f.snapshotPath, f.snapshotReply);
    const key = f.input.resources.find((row) => row.kind === 'ssh_key');
    if (!key) throw new Error('Expected a recorded fixture SSH key.');
    expect(imageResourceStateSchema.parse(key.state).kind).toBe('absent');
    const path = `/v1/ssh_keys/${key.providerId}`;
    f.replies.set(path, {
      ssh_key: {
        id: Number(key.providerId),
        labels: imageEffectLabels({
          buildId: f.input.buildId,
          role: imageResourceRoleSchema.parse(key.role),
          effectId: key.effectId,
        }),
        public_key: 'ssh-ed25519 AAAA',
        fingerprint: 'fixture',
      },
    });
    f.requests.splice(0);
    expect(await f.verify()).toEqual(rejected);
    expect(f.requests).toContainEqual({ method: 'GET', path });
    expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
  } finally {
    f.verifiers.close();
  }
});

it('honors revocation from the private release policy without restarting or contacting provider inventory', async () => {
  const f = await scenario();
  try {
    expect((await f.verify()).ok).toBe(true);
    await writeFile(
      f.policyFile,
      JSON.stringify({
        version: 1,
        keys: [...f.keys, { kind: 'revoked', keyId: f.release.signature.keyId }],
      }),
    );
    f.requests.splice(0);
    const rejected = await f.verify();
    expect(rejected.ok).toBe(false);
    expect(rejected.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(f.requests).toEqual([]);
  } finally {
    f.verifiers.close();
  }
});

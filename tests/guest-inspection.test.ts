import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { guestManifestSchema, newId } from '../packages/contracts/dist/index.js';
import { inspectRuntime, type RuntimeSystem } from '../packages/guestctl/src/inspect.js';

let state: string;
beforeEach(async () => {
  state = await mkdtemp(join(tmpdir(), 'agent-cloud-inspection-'));
});
afterEach(async () => {
  await rm(state, { recursive: true, force: true });
});

async function fixture() {
  const binary = 'public guest executable fixture';
  const manifest = guestManifestSchema.parse({
    format: 1,
    version: 'inspection-v1',
    architecture: 'x86',
    components: {
      node: process.versions.node,
      docker: '29.8.0',
      compose: '5.5.1',
      caddy: '2.11.4',
      step: '0.30.6',
      guestctlSha256: createHash('sha256').update(binary).digest('hex'),
    },
    trust: {
      sshUserCa: 'ssh-ed25519 AAAA',
      sshHostCa: 'ssh-ed25519 BBBB',
      tlsRoot: 'fixture-root',
    },
  });
  const proof = {
    version: 1,
    allocationId: newId.allocation(),
    imageVersion: manifest.version,
    manifestDigest: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    sshHostPublicKey: 'ssh-ed25519 CCCC',
    tlsCsr: 'fixture-csr',
  };
  const configuration = {
    state,
    manifest: join(state, 'image.json'),
    binary: join(state, 'guest.mjs'),
    step: '/unused/step',
    keygen: '/unused/keygen',
  };
  await writeFile(configuration.binary, binary, { mode: 0o644 });
  await writeFile(configuration.manifest, JSON.stringify(manifest), { mode: 0o644 });
  await writeFile(join(state, 'proof.json'), JSON.stringify(proof), { mode: 0o644 });
  const bootId = randomUUID();
  const system: RuntimeSystem = {
    architecture: () => 'x86',
    bootId: () => Promise.resolve(bootId),
    version: (name) => Promise.resolve(manifest.components[name]),
    disk: () => Promise.resolve({ availableBytes: 5 * 1024 ** 3, totalBytes: 20 * 1024 ** 3 }),
    proxy: () =>
      Promise.resolve({ allocationId: proof.allocationId, imageVersion: proof.imageVersion }),
  };
  return { configuration, system, proof, bootId };
}

it('reports independent component failures without losing other fresh evidence', async () => {
  const guest = await fixture();
  const version = guest.system.version;
  guest.system.version = (name) =>
    name === 'docker' ? Promise.reject(new Error('Daemon stopped')) : version(name);
  guest.system.proxy = () =>
    Promise.resolve({
      allocationId: guest.proof.allocationId,
      imageVersion: guest.proof.imageVersion,
      extra: 'invalid',
    });
  const runtime = await inspectRuntime(guest.configuration, guest.system);
  expect(runtime.proof).toEqual(guest.proof);
  expect(runtime.bootId).toBe(guest.bootId);
  expect(runtime.checks.docker).toEqual({ kind: 'unavailable' });
  expect(runtime.checks.proxy).toEqual({ kind: 'unavailable' });
  expect(runtime.checks.compose).toEqual({ kind: 'ok', version: '5.5.1' });
  expect(runtime.checks.disk.kind).toBe('ok');
});

it('rejects changed executable or identity evidence rather than reporting readiness', async () => {
  const guest = await fixture();
  await writeFile(
    join(state, 'proof.json'),
    JSON.stringify({ ...guest.proof, manifestDigest: 'f'.repeat(64) }),
  );
  await expect(inspectRuntime(guest.configuration, guest.system)).rejects.toThrow('disagree');
  await writeFile(join(state, 'proof.json'), JSON.stringify(guest.proof));
  await writeFile(guest.configuration.binary, 'changed executable');
  await expect(inspectRuntime(guest.configuration, guest.system)).rejects.toThrow('executable');
});

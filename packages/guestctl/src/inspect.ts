import { readFile, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  guestBootProofSchema,
  guestRuntimeSchema,
  imageVerifierRuntimeSchema,
  type GuestRuntime,
  type GuestBootRuntime,
} from '@agent-cloud/contracts';
import { loadManifest, type GuestConfiguration } from './identity.js';
import { readOwnedFile } from './files.js';
import { runTool } from './tools.js';

type Checks = GuestRuntime['checks'];
export type RuntimeSystem = {
  architecture: () => GuestRuntime['architecture'];
  bootId: () => Promise<string>;
  machineId: () => Promise<string>;
  version: (component: 'docker' | 'compose' | 'caddy' | 'step') => Promise<string>;
  disk: () => Promise<Omit<Extract<Checks['disk'], { kind: 'ok' }>, 'kind'>>;
  proxy: () => Promise<unknown>;
};

export function runtimeSystem(configuration: GuestConfiguration): RuntimeSystem {
  const run = (binary: string, args: string[]) => runTool(binary, args, configuration.state);
  return {
    architecture: () => {
      if (process.arch === 'x64') return 'x86';
      if (process.arch === 'arm64') return 'arm';
      throw new Error('Unsupported guest architecture.');
    },
    bootId: async () => (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
    machineId: async () => (await readFile('/etc/machine-id', 'utf8')).trim(),
    version: async (component) => {
      switch (component) {
        case 'docker':
          return (
            await run('/usr/bin/docker', [
              '--host',
              'unix:///var/run/docker.sock',
              'version',
              '--format',
              '{{.Server.Version}}',
            ])
          ).trim();
        case 'compose':
          return (
            await run('/usr/bin/docker', [
              '--host',
              'unix:///var/run/docker.sock',
              'compose',
              'version',
              '--short',
            ])
          ).trim();
        case 'caddy':
          return z
            .string()
            .parse((await run('/usr/local/bin/caddy', ['version'])).match(/^v([0-9.]+) /)?.[1]);
        case 'step':
          return z
            .string()
            .parse(
              (await run(configuration.step, ['version'])).match(/^Smallstep CLI\/([0-9.]+) /)?.[1],
            );
      }
    },
    disk: async () => {
      // Both locations must retain headroom even if an operator moved Docker onto another disk.
      const filesystems = await Promise.all([
        statfs(configuration.state),
        statfs('/var/lib/docker'),
      ]);
      return {
        availableBytes: Math.min(...filesystems.map((disk) => disk.bavail * disk.bsize)),
        totalBytes: Math.min(...filesystems.map((disk) => disk.blocks * disk.bsize)),
      };
    },
    proxy: async () => {
      const response = await fetch('http://127.0.0.1:8081/ready', {
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok || !response.body) throw new Error('Guest proxy is not healthy.');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 4096) throw new Error('Guest proxy health response exceeds its limit.');
          chunks.push(value);
        }
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return value;
      } finally {
        await reader.cancel();
      }
    },
  };
}

/** Fresh read-only evidence. Component failures stay explicit rather than hiding other checks. */
export async function inspectRuntime(
  configuration: GuestConfiguration,
  system = runtimeSystem(configuration),
): Promise<GuestBootRuntime> {
  const { manifest, digest } = await loadManifest(configuration);
  const proof = guestBootProofSchema.parse(
    JSON.parse(await readOwnedFile(join(configuration.state, 'proof.json'), 'public')),
  );
  if (proof.manifestDigest !== digest || proof.imageVersion !== manifest.version)
    throw new Error('Guest proof and installed image disagree.');
  const schema = proof.version === 1 ? guestRuntimeSchema : imageVerifierRuntimeSchema;
  async function measured(name: keyof Checks, measure: () => Promise<unknown>) {
    try {
      return schema.shape.checks.shape[name].parse(await measure());
    } catch {
      return { kind: 'unavailable' };
    }
  }
  const [docker, compose, caddy, step, disk, proxy] = await Promise.all([
    measured('docker', async () => ({ kind: 'ok', version: await system.version('docker') })),
    measured('compose', async () => ({ kind: 'ok', version: await system.version('compose') })),
    measured('caddy', async () => ({ kind: 'ok', version: await system.version('caddy') })),
    measured('step', async () => ({ kind: 'ok', version: await system.version('step') })),
    measured('disk', async () => ({ kind: 'ok', ...(await system.disk()) })),
    measured('proxy', async () => {
      const proxySchema =
        proof.version === 1
          ? guestRuntimeSchema.shape.checks.shape.proxy.options[0].omit({ kind: true })
          : imageVerifierRuntimeSchema.shape.checks.shape.proxy.options[0].omit({ kind: true });
      const value = proxySchema.parse(await system.proxy());
      return { kind: 'ok', ...value };
    }),
  ]);
  return schema.parse({
    version: proof.version,
    ...(proof.version === 2 ? { machineId: await system.machineId() } : {}),
    proof,
    manifest,
    architecture: system.architecture(),
    bootId: await system.bootId(),
    checks: {
      node: { kind: 'ok', version: process.versions.node },
      docker,
      compose,
      caddy,
      step,
      disk,
      proxy,
    },
  });
}

import { chown, chmod, open, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  CloudError,
  hostingGuestRouteSchema,
  type HostingGuestCommand,
} from '@agent-cloud/contracts';
import { atomicWrite, ensureDirectory, isMissing, readOwnedFile, syncDirectory } from './files.js';
import { runTool } from './tools.js';

const maximumBytes = 2 * 1024 * 1024;
function encode(value: unknown) {
  const encoded = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(encoded) > maximumBytes)
    throw new CloudError('quota_exceeded', 'Guest routing state exceeds its supported size.');
  return encoded;
}
const stateSchema = z.strictObject({
  prepared: z.array(hostingGuestRouteSchema).max(100),
  committed: z.array(hostingGuestRouteSchema).max(100),
  bindings: z.array(hostingGuestRouteSchema).max(1000),
});
const caddySchema = z
  .object({
    apps: z
      .object({
        http: z
          .object({
            servers: z
              .object({ guest: z.object({ routes: z.array(z.unknown()) }).loose() })
              .loose(),
          })
          .loose(),
      })
      .loose(),
  })
  .loose();
export function createGuestHosting(input: {
  state: string;
  apply?: (candidate: string) => Promise<void>;
}) {
  const directory = join(input.state, 'hosting');
  const statePath = join(directory, 'routes.json');
  const configPath = join(input.state, 'caddy.json');
  const apply =
    input.apply ??
    (async (candidate: string) => {
      await runTool('/usr/local/bin/caddy', ['validate', '--config', candidate], input.state);
      await runTool('/usr/local/bin/caddy', ['reload', '--config', candidate], input.state);
    });
  async function read() {
    try {
      return stateSchema.parse(JSON.parse(await readOwnedFile(statePath, 'private', maximumBytes)));
    } catch (error) {
      if (isMissing(error)) return stateSchema.parse({ prepared: [], committed: [], bindings: [] });
      throw error;
    }
  }
  return {
    async command(command: HostingGuestCommand) {
      await ensureDirectory(directory, 0o700);
      const state = await read();
      const committed = state.committed.find((route) => route.hostname === command.hostname);
      if (command.kind === 'inspect') return { route: committed ?? null };
      const { retainFromVersion, ...desired } = command;
      if (retainFromVersion > command.version)
        throw new CloudError(
          'invalid_input',
          'Retention cannot exceed the requested route version.',
        );
      const current = state.prepared.find((route) => route.hostname === command.hostname);
      if (
        current &&
        (current.version > desired.version ||
          (current.version === desired.version &&
            JSON.stringify(current) !== JSON.stringify(desired)))
      )
        throw new CloudError(
          'version_conflict',
          'Guest route version belongs to a different change.',
        );
      if (committed?.version === desired.version) return { route: committed };
      if (!current && state.prepared.length >= 100)
        throw new CloudError(
          'quota_exceeded',
          'Guest route history is limited to one hundred names.',
        );
      const bindings = state.bindings.filter(
        (route) =>
          route.hostname !== desired.hostname ||
          (route.version >= retainFromVersion && route.version !== desired.version),
      );
      if (desired.kind === 'put') bindings.push(desired);
      if (bindings.length > 1000)
        throw new CloudError(
          'quota_exceeded',
          'Gateway acknowledgement is required before retaining more route versions.',
        );
      const prepared = stateSchema.parse({
        ...state,
        bindings,
        prepared: [
          ...state.prepared.filter((route) => route.hostname !== desired.hostname),
          desired,
        ],
      });
      // Record every possibly live binding before reload. A lost reply must never let
      // a subsequent command forget a version the gateway may already be using.
      await atomicWrite(statePath, encode(prepared), 0o600);
      const config = caddySchema.parse(
        JSON.parse(await readOwnedFile(configPath, 'public', maximumBytes)),
      );
      config.apps.http.servers.guest.routes = [
        ...bindings.flatMap((route) =>
          route.kind === 'remove'
            ? []
            : [
                {
                  match: [
                    {
                      host: [route.hostname],
                      header: { 'X-Agent-Cloud-Route-Version': [String(route.version)] },
                    },
                  ],
                  handle: [
                    {
                      handler: 'reverse_proxy',
                      headers: { request: { delete: ['X-Agent-Cloud-Route-Version'] } },
                      upstreams: [{ dial: `127.0.0.1:${route.port}` }],
                      flush_interval: -1,
                      transport: {
                        protocol: 'http',
                        dial_timeout: 5_000_000_000,
                        response_header_timeout: 30_000_000_000,
                      },
                    },
                  ],
                  terminal: true,
                },
              ],
        ),
        { handle: [{ handler: 'static_response', status_code: 404 }] },
      ];
      const candidate = join(directory, 'candidate.json');
      await atomicWrite(candidate, encode(config), 0o600);
      await apply(candidate);
      const configOwner = await stat(configPath);
      await chown(candidate, configOwner.uid, configOwner.gid);
      await chmod(candidate, 0o640);
      const file = await open(candidate, 'r');
      try {
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(candidate, configPath);
      await syncDirectory(input.state);
      await atomicWrite(
        statePath,
        encode({
          ...prepared,
          committed: [
            ...state.committed.filter((route) => route.hostname !== desired.hostname),
            desired,
          ],
        }),
        0o600,
      );
      return { route: desired };
    },
  };
}

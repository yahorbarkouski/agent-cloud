import { expect, it, vi } from 'vitest';
import { HetznerProvider, type GuestRenderer } from '../packages/hetzner/src/index.js';
import { newId, type ProviderCommand } from '../packages/contracts/src/index.js';

const ip = {
  id: 23,
  name: 'owned-ip',
  type: 'ipv4',
  ip: '192.0.2.23',
  location: { name: 'nbg1' },
  labels: { managed_by: 'agent-cloud' },
  auto_delete: true,
  assignee_type: 'unassigned',
  assignee_id: null,
};
function provider(
  transport: typeof fetch,
  renderGuest = vi
    .fn<GuestRenderer>()
    .mockResolvedValue({ image: 'pinned-image', userData: '#cloud-config\n' }),
) {
  return new HetznerProvider({
    token: 'fake-test-token'.padEnd(64, 'x'),
    offers: {
      currency: 'USD',
      architecture: 'x86',
      serverTypes: { small: 'cpx12', medium: 'cx33', large: 'cx43' },
    },
    access: {
      firewallIds: [1],
    },
    renderGuest,
    transport,
  });
}

it('enables provider backups on the exact server and distinguishes enabled, disabled and unreported status', async () => {
  const calls: Request[] = [];
  for (const backupWindow of [undefined, null, '22-02']) {
    const source = provider((input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      return Promise.resolve(
        Response.json(
          request.method === 'POST'
            ? { action: { id: 71, status: 'running' } }
            : {
                server: {
                  id: 42,
                  name: 'owned',
                  status: 'running',
                  server_type: { name: 'cpx12' },
                  location: { name: 'nbg1' },
                  labels: { managed_by: 'agent-cloud' },
                  public_net: { ipv4: null },
                  ...(backupWindow === undefined ? {} : { backup_window: backupWindow }),
                },
              },
        ),
      );
    });
    const server = await source.getServer({ serverId: '42' });
    expect(server?.backupStatus).toBe(
      backupWindow === undefined ? 'unknown' : backupWindow === null ? 'disabled' : 'enabled',
    );
    expect(
      await source.submit({
        attemptId: newId.attempt(),
        command: { kind: 'enable_backup', serverId: '42' },
      }),
    ).toEqual({ kind: 'accepted', resource: { kind: 'server', id: '42' }, actionId: '71' });
    expect(calls.at(-1)?.url).toBe('https://api.hetzner.cloud/v1/servers/42/actions/enable_backup');
    expect(await calls.at(-1)?.text()).toBe('');
  }
});

it('creates explicitly owned IPv4, attaches it without automatic IPv6, and accepts bodyless deletion', async () => {
  const requests: Request[] = [];
  const source = provider((input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));
    return Promise.resolve(
      Response.json(
        new URL(request.url).pathname.endsWith('/primary_ips')
          ? { primary_ip: ip }
          : { server: { id: 42 }, action: { id: 61, status: 'running' } },
      ),
    );
  });
  const labels = { managed_by: 'agent-cloud', allocation_id: 'allocation' };
  const attemptId = newId.attempt();
  expect(
    await source.submit({
      attemptId,
      command: { kind: 'create_primary_ip', name: 'owned-ip', region: 'nbg1', labels },
    }),
  ).toEqual({ kind: 'completed', resource: { kind: 'primary_ip', id: '23' } });
  expect(await requests[0]?.json()).toEqual({
    name: 'owned-ip',
    type: 'ipv4',
    location: 'nbg1',
    auto_delete: true,
    labels: { ...labels, attempt_id: attemptId },
  });
  expect(
    await source.submit({
      attemptId: newId.attempt(),
      command: {
        kind: 'create_guest',
        bootstrap: { version: 1, allocationId: newId.allocation() },
        name: 'owned-vm',
        serverType: 'cpx12',
        region: 'nbg1',
        labels,
        network: { kind: 'primary_ip', id: '23' },
      },
    }),
  ).toMatchObject({ kind: 'accepted', resource: { kind: 'server', id: '42' } });
  expect(await requests[1]?.json()).toMatchObject({
    public_net: { enable_ipv4: true, ipv4: 23, enable_ipv6: false },
    image: 'pinned-image',
    user_data: '#cloud-config\n',
    ssh_keys: [],
  });
  expect(
    await source.submit({
      attemptId: newId.attempt(),
      command: { kind: 'delete_primary_ip', primaryIpId: '23' },
    }),
  ).toEqual({ kind: 'completed', resource: { kind: 'primary_ip', id: '23' } });
  expect(requests[2]?.url).toBe('https://api.hetzner.cloud/v1/primary_ips/23');
});

it.each(['server', 'unassigned'])(
  'recognizes null assignee IDs with type %s across creation and reconciliation',
  async (assigneeType) => {
    const wire = { ...ip, assignee_type: assigneeType };
    const source = provider((input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return Promise.resolve(
        Response.json(
          url.searchParams.has('label_selector')
            ? { primary_ips: [wire], meta: { pagination: { next_page: null } } }
            : { primary_ip: wire },
        ),
      );
    });
    expect(
      await source.submit({
        attemptId: newId.attempt(),
        command: { kind: 'create_primary_ip', name: ip.name, region: 'nbg1', labels: ip.labels },
      }),
    ).toEqual({ kind: 'completed', resource: { kind: 'primary_ip', id: '23' } });
    const observed = await source.getPrimaryIp({ primaryIpId: '23' });
    expect(observed).toMatchObject({ assignment: { kind: 'unassigned' } });
    expect(await source.findPrimaryIps({ labels: ip.labels })).toEqual([observed]);
  },
);

it('preserves exact server assignments and rejects contradictory assignment states', async () => {
  const source = provider(() => Promise.resolve(Response.json({ primary_ip: ip })));
  expect(await source.getPrimaryIp({ primaryIpId: '23' })).toMatchObject({
    assignment: { kind: 'unassigned' },
  });
  const assigned = provider(() =>
    Promise.resolve(
      Response.json({ primary_ip: { ...ip, assignee_type: 'server', assignee_id: 42 } }),
    ),
  );
  expect(await assigned.getPrimaryIp({ primaryIpId: '23' })).toMatchObject({
    assignment: { kind: 'server', serverId: '42' },
  });
  const invalid = provider(() =>
    Promise.resolve(Response.json({ primary_ip: { ...ip, assignee_id: 42 } })),
  );
  await expect(invalid.getPrimaryIp({ primaryIpId: '23' })).rejects.toThrow();
});

it('only treats a definite resource-not-found response as absence', async () => {
  const absent = provider(() =>
    Promise.resolve(Response.json({ error: { code: 'not_found' } }, { status: 404 })),
  );
  expect(await absent.getPrimaryIp({ primaryIpId: '23' })).toBe(null);
  for (const [status, code] of [
    [403, 'forbidden'],
    [404, 'invalid_response'],
    [500, 'not_found'],
  ]) {
    const source = provider(() =>
      Promise.resolve(
        Response.json({ error: { code } }, { status: typeof status === 'number' ? status : 500 }),
      ),
    );
    await expect(source.getPrimaryIp({ primaryIpId: '23' })).rejects.toThrow();
  }
});

it('reads every ownership inventory page and rejects a pagination cycle', async () => {
  const pages: string[] = [];
  const source = provider((input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    pages.push(url.searchParams.get('page') ?? '');
    const first = url.searchParams.get('page') === '1';
    return Promise.resolve(
      Response.json({
        primary_ips: first ? [{ ...ip, labels: { managed_by: 'foreign' } }] : [ip],
        meta: { pagination: { next_page: first ? 2 : null } },
      }),
    );
  });
  expect(await source.findPrimaryIps({ labels: ip.labels })).toHaveLength(1);
  expect(pages).toEqual(['1', '2']);
  const cycling = provider(() =>
    Promise.resolve(Response.json({ primary_ips: [], meta: { pagination: { next_page: 1 } } })),
  );
  await expect(cycling.findPrimaryIps({ labels: ip.labels })).rejects.toThrow('pagination');
});

it('keeps transport errors and malformed successful mutation responses uncertain', async () => {
  for (const transport of [
    () => Promise.reject(new Error('Connection reset after commit')),
    () => Promise.resolve(Response.json({ primary_ip: { id: 23 } })),
    () => Promise.resolve(Response.json({ error: { code: 'timeout' } }, { status: 408 })),
  ]) {
    const source = provider(transport);
    expect(
      await source.submit({
        attemptId: newId.attempt(),
        command: { kind: 'create_primary_ip', name: 'owned', region: 'nbg1', labels: ip.labels },
      }),
    ).toMatchObject({ kind: 'unknown' });
  }
  const rejected = provider(() =>
    Promise.resolve(Response.json({ error: { code: 'resource_unavailable' } }, { status: 409 })),
  );
  expect(
    await rejected.submit({
      attemptId: newId.attempt(),
      command: { kind: 'create_primary_ip', name: 'owned', region: 'nbg1', labels: ip.labels },
    }),
  ).toMatchObject({ kind: 'rejected', error: { code: 'capacity_unavailable' } });
});

it('rejects legacy live creates and local rendering failures without a network mutation', async () => {
  const transport = vi.fn<typeof fetch>();
  const render = vi.fn<GuestRenderer>().mockRejectedValue(new Error('sensitive local data'));
  const source = provider(transport, render);
  const command = {
    name: 'guest',
    serverType: 'cpx12',
    region: 'nbg1',
    labels: {},
    network: { kind: 'primary_ip', id: '23' },
  } satisfies Omit<Extract<ProviderCommand, { kind: 'create' }>, 'kind'>;
  expect(
    await source.submit({ attemptId: newId.attempt(), command: { ...command, kind: 'create' } }),
  ).toMatchObject({ kind: 'rejected' });
  expect(render).not.toHaveBeenCalled();
  const result = await source.submit({
    attemptId: newId.attempt(),
    command: {
      ...command,
      kind: 'create_guest',
      bootstrap: { version: 1, allocationId: newId.allocation() },
    },
  });
  expect(result).toMatchObject({ kind: 'rejected' });
  expect(JSON.stringify(result)).not.toContain('sensitive');
  expect(render).toHaveBeenCalledTimes(1);
  expect(transport).not.toHaveBeenCalled();
});

it('requests graceful shutdown for customer power-off without falling back to hard poweroff', async () => {
  const paths: string[] = [];
  const source = provider((input, init) => {
    paths.push(new URL(new Request(input, init).url).pathname);
    return Promise.resolve(Response.json({ action: { id: 12, status: 'running' } }));
  });
  expect(
    await source.submit({
      attemptId: newId.attempt(),
      command: { kind: 'power_off', serverId: '42' },
    }),
  ).toMatchObject({ kind: 'accepted', actionId: '12' });
  expect(paths).toEqual(['/v1/servers/42/actions/shutdown']);
});

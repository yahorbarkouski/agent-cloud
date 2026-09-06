import { expect, it } from 'vitest';
import { HetznerProvider } from '../packages/hetzner/src/index.js';
import { newId } from '../packages/contracts/src/index.js';

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
function provider(transport: typeof fetch) {
  return new HetznerProvider({
    token: 'fake-test-token'.padEnd(64, 'x'),
    offers: {
      currency: 'USD',
      architecture: 'x86',
      serverTypes: { small: 'cpx12', medium: 'cx33', large: 'cx43' },
    },
    template: {
      image: 'ubuntu-24.04',
      firewallIds: [1],
      sshKeys: ['test-key'],
      userData: '#cloud-config\n',
    },
    transport,
  });
}

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
        kind: 'create',
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
  });
  expect(
    await source.submit({
      attemptId: newId.attempt(),
      command: { kind: 'delete_primary_ip', primaryIpId: '23' },
    }),
  ).toEqual({ kind: 'completed', resource: { kind: 'primary_ip', id: '23' } });
  expect(requests[2]?.url).toBe('https://api.hetzner.cloud/v1/primary_ips/23');
});

it('recognizes unassigned IPs and rejects contradictory assignment states', async () => {
  const source = provider(() => Promise.resolve(Response.json({ primary_ip: ip })));
  expect(await source.getPrimaryIp({ primaryIpId: '23' })).toMatchObject({
    assignment: { kind: 'unassigned' },
  });
  const ambiguous = provider(() =>
    Promise.resolve(Response.json({ primary_ip: { ...ip, assignee_type: 'server' } })),
  );
  await expect(ambiguous.getPrimaryIp({ primaryIpId: '23' })).rejects.toThrow();
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

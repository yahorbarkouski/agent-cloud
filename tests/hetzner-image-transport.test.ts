import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { HetznerImageProvider, type ImageBootRenderer } from '../packages/hetzner/src/index.js';
import {
  imageBuildIdSchema,
  imageBuildLabels,
  type ImageProviderCommand,
} from '../packages/contracts/src/index.js';

const buildId = imageBuildIdSchema.parse(randomUUID());
const effectId = randomUUID();
const labels = imageBuildLabels(buildId, 'builder');
const serverCommand = {
  kind: 'create_server',
  name: 'builder',
  labels,
  serverType: 'cpx12',
  region: 'nbg1',
  imageId: '100',
  primaryIpId: '23',
  sshKeyId: '24',
  firewallId: '25',
  bootData: { kind: 'image_build_secret', id: randomUUID(), digest: 'a'.repeat(64) },
} satisfies ImageProviderCommand;
const ip = {
  id: 23,
  labels: imageBuildLabels(buildId, 'builder_ip'),
  type: 'ipv4',
  ip: '192.0.2.23',
  location: { name: 'nbg1' },
  auto_delete: false,
  assignee_type: 'unassigned',
  assignee_id: null,
};
const providerImage = {
  id: 100,
  labels: {},
  type: 'system',
  status: 'available',
  architecture: 'x86',
  os_flavor: 'ubuntu',
  os_version: '24.04',
  disk_size: 10,
  image_size: null,
  created: '2026-09-01T00:00:00Z',
  created_from: null,
  protection: { delete: false },
  deprecated: null,
  deleted: null,
};
function provider(
  transport: typeof fetch,
  renderBoot: ImageBootRenderer = () => Promise.resolve('#cloud-config\n'),
) {
  return new HetznerImageProvider({
    token: 'fixture-token'.padEnd(64, 'x'),
    transport,
    renderBoot,
  });
}

it('creates an exact owned server using the persisted effect ID and isolated HTTP settings', async () => {
  const requests: Request[] = [];
  const render = vi.fn<ImageBootRenderer>().mockResolvedValue('#cloud-config\n');
  const source = provider((input, init) => {
    requests.push(new Request(input, init));
    return Promise.resolve(Response.json({ server: { id: 42 }, action: { id: 61 } }));
  }, render);
  expect(await source.submit({ effectId, command: serverCommand })).toEqual({
    kind: 'accepted',
    resource: { kind: 'server', id: '42' },
    actionId: '61',
  });
  expect(render).toHaveBeenCalledExactlyOnceWith({ effectId, command: serverCommand });
  const request = requests[0];
  expect(request?.url).toBe('https://api.hetzner.cloud/v1/servers');
  expect(request?.redirect).toBe('error');
  expect(request?.signal).toBeInstanceOf(AbortSignal);
  expect(await request?.json()).toEqual({
    name: 'builder',
    server_type: 'cpx12',
    location: 'nbg1',
    image: '100',
    labels: { ...labels, effect_id: effectId },
    ssh_keys: [24],
    firewalls: [{ firewall: 25 }],
    user_data: '#cloud-config\n',
    start_after_create: true,
    automount: false,
    public_net: { enable_ipv4: true, ipv4: 23, enable_ipv6: false },
  });
});

it('does not submit a VM when rendering fails or cloud-init exceeds the provider limit', async () => {
  const transport = vi.fn<typeof fetch>();
  for (const render of [
    () => Promise.reject(new Error('private-key-data')),
    () => Promise.resolve('é'.repeat(16385)),
  ]) {
    expect(await provider(transport, render).submit({ effectId, command: serverCommand })).toEqual({
      kind: 'rejected',
      reason: 'Builder boot data could not be prepared; no server request was made.',
    });
  }
  expect(transport).not.toHaveBeenCalled();
});

it('creates separate persistent IPv4 and single-host SSH access resources', async () => {
  const requests: Request[] = [];
  const source = provider((input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const path = new URL(request.url).pathname;
    return Promise.resolve(
      Response.json(
        path.endsWith('/primary_ips')
          ? { primary_ip: ip, action: null }
          : path.endsWith('/firewalls')
            ? { firewall: { id: 25 }, actions: [] }
            : { ssh_key: { id: 24 } },
      ),
    );
  });
  const commands: ImageProviderCommand[] = [
    { kind: 'create_primary_ip', name: 'builder-ip', labels: ip.labels, region: 'nbg1' },
    {
      kind: 'create_firewall',
      name: 'builder-access',
      labels: imageBuildLabels(buildId, 'access_firewall'),
      managementAddress: '203.0.113.7',
    },
    {
      kind: 'create_ssh_key',
      name: 'builder-access',
      labels: imageBuildLabels(buildId, 'access_key'),
      publicKey: 'ssh-ed25519 AAAA',
    },
  ];
  for (const command of commands)
    expect(await source.submit({ effectId, command })).toMatchObject({ kind: 'completed' });
  expect(await requests[0]?.json()).toEqual({
    name: 'builder-ip',
    type: 'ipv4',
    location: 'nbg1',
    auto_delete: false,
    labels: { ...ip.labels, effect_id: effectId },
  });
  expect(await requests[1]?.json()).toMatchObject({
    apply_to: [],
    rules: [{ direction: 'in', protocol: 'tcp', port: '22', source_ips: ['203.0.113.7/32'] }],
  });
  expect(await requests[2]?.json()).toMatchObject({ public_key: 'ssh-ed25519 AAAA' });
});

it('records snapshot identity separately from the source server action and deletes exact resource kinds', async () => {
  const requests: Request[] = [];
  const source = provider((input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.method === 'DELETE' && !new URL(request.url).pathname.includes('/servers/'))
      return Promise.resolve(new Response(null, { status: 204 }));
    return Promise.resolve(Response.json({ image: { id: 80 }, action: { id: 61 } }));
  });
  expect(
    await source.submit({
      effectId,
      command: {
        kind: 'create_snapshot',
        name: 'candidate',
        labels: imageBuildLabels(buildId, 'snapshot'),
        serverId: '42',
      },
    }),
  ).toEqual({ kind: 'accepted', resource: { kind: 'snapshot', id: '80' }, actionId: '61' });
  expect(requests[0]?.url).toBe('https://api.hetzner.cloud/v1/servers/42/actions/create_image');
  expect(await requests[0]?.json()).toMatchObject({ type: 'snapshot', description: 'candidate' });
  for (const kind of ['server', 'snapshot', 'primary_ip', 'ssh_key', 'firewall'] satisfies Array<
    'server' | 'snapshot' | 'primary_ip' | 'ssh_key' | 'firewall'
  >) {
    expect(
      await source.submit({ effectId, command: { kind: 'delete', resource: { kind, id: '80' } } }),
    ).toMatchObject({
      kind: kind === 'server' ? 'accepted' : 'completed',
      resource: { kind, id: '80' },
    });
  }
  expect(requests.slice(1).map((request) => new URL(request.url).pathname)).toEqual([
    '/v1/servers/80',
    '/v1/images/80',
    '/v1/primary_ips/80',
    '/v1/ssh_keys/80',
    '/v1/firewalls/80',
  ]);
});

it.each([
  { status: 403, code: 'forbidden', kind: 'rejected' },
  { status: 429, code: 'rate_limit_exceeded', kind: 'rejected' },
  { status: 408, code: 'timeout', kind: 'unknown' },
  { status: 504, code: 'timeout', kind: 'unknown' },
  { status: 500, code: 'internal_error', kind: 'unknown' },
  { status: 422, code: 'invalid_response', kind: 'unknown' },
])(
  'classifies HTTP $status/$code without echoing provider data',
  async ({ status, code, kind }) => {
    const source = provider(() =>
      Promise.resolve(
        Response.json({ error: { code, message: 'private-customer-data' } }, { status }),
      ),
    );
    const result = await source.submit({ effectId, command: serverCommand });
    expect(result.kind).toBe(kind);
    expect(JSON.stringify(result)).not.toContain('private-customer-data');
  },
);

it('keeps network errors and malformed successful receipts uncertain without resubmitting', async () => {
  for (const transport of [
    () => Promise.reject(new Error('secret')),
    () => Promise.resolve(Response.json({ server: { id: 42 }, action: {} })),
    () => Promise.resolve(new Response('not-json')),
  ]) {
    const request = vi.fn<typeof fetch>().mockImplementation(transport);
    expect(await provider(request).submit({ effectId, command: serverCommand })).toEqual({
      kind: 'unknown',
      reason: 'Hetzner did not return a definitive valid image-operation receipt.',
    });
    expect(request).toHaveBeenCalledTimes(1);
  }
});

it('checks the exact action ID and target association, and distinguishes missing from failed actions', async () => {
  for (const [status, kind] of [
    ['running', 'running'],
    ['success', 'succeeded'],
    ['error', 'failed'],
  ]) {
    const source = provider(() =>
      Promise.resolve(
        Response.json({ action: { id: 61, status, resources: [{ id: 42, type: 'server' }] } }),
      ),
    );
    expect(
      await source.getAction({ actionId: '61', resource: { kind: 'server', id: '42' } }),
    ).toMatchObject({ kind });
  }
  for (const action of [
    { id: 62, status: 'success', resources: [{ id: 42, type: 'server' }] },
    { id: 61, status: 'success', resources: [{ id: 99, type: 'server' }] },
  ]) {
    await expect(
      provider(() => Promise.resolve(Response.json({ action }))).getAction({
        actionId: '61',
        resource: { kind: 'server', id: '42' },
      }),
    ).rejects.toThrow('another');
  }
  expect(
    await provider(() =>
      Promise.resolve(Response.json({ error: { code: 'not_found' } }, { status: 404 })),
    ).getAction({ actionId: '61', resource: { kind: 'server', id: '42' } }),
  ).toEqual({ kind: 'missing' });
});

it('only accepts exact authoritative absence and refuses malformed or foreign resource identities', async () => {
  for (const response of [
    Response.json({ error: { code: 'forbidden' } }, { status: 403 }),
    Response.json({ error: { code: 'unknown' } }, { status: 404 }),
    Response.json({ primary_ip: { ...ip, id: 24 } }),
    Response.json({ primary_ip: { ...ip, assignee_id: 42 } }),
  ]) {
    await expect(
      provider(() => Promise.resolve(response)).get({ kind: 'primary_ip', id: '23' }),
    ).rejects.toThrow();
  }
  expect(
    await provider(() =>
      Promise.resolve(Response.json({ error: { code: 'not_found' } }, { status: 404 })),
    ).get({ kind: 'primary_ip', id: '23' }),
  ).toBeNull();
  for (const assignee_type of ['unassigned', 'server']) {
    expect(
      await provider(() =>
        Promise.resolve(Response.json({ primary_ip: { ...ip, assignee_type } })),
      ).get({ kind: 'primary_ip', id: '23' }),
    ).toMatchObject({ serverId: null });
  }
});

it('reads every ownership page without hiding out-of-scope resources or returning a partial inventory', async () => {
  const pages: string[] = [];
  const source = provider((input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const page = url.searchParams.get('page') ?? '';
    pages.push(page);
    expect(url.searchParams.get('label_selector')).toContain(`build_id=${buildId}`);
    return Promise.resolve(
      Response.json({
        primary_ips: [{ ...ip, id: page === '1' ? 23 : 24 }],
        meta: { pagination: { next_page: page === '1' ? 2 : null } },
      }),
    );
  });
  expect(
    (await source.find({ kind: 'primary_ip', labels: ip.labels })).map((resource) => resource.id),
  ).toEqual(['23', '24']);
  expect(pages).toEqual(['1', '2']);
  for (const body of [
    { primary_ips: [], meta: { pagination: { next_page: 1 } } },
    { primary_ips: [{ ...ip, labels: {} }], meta: { pagination: { next_page: null } } },
    { primary_ips: [ip] },
  ]) {
    await expect(
      provider(() => Promise.resolve(Response.json(body))).find({
        kind: 'primary_ip',
        labels: ip.labels,
      }),
    ).rejects.toThrow();
  }
});

it('retains unavailable snapshots for cleanup and observes every base-image compatibility field', async () => {
  const source = provider(() => Promise.resolve(Response.json({ image: providerImage })));
  expect(await source.getBaseImage('100')).toEqual({
    id: '100',
    type: 'system',
    status: 'available',
    architecture: 'x86',
    osFlavor: 'ubuntu',
    osVersion: '24.04',
    diskGb: 10,
    deprecated: false,
    deleted: false,
  });
  const snapshot = provider(() =>
    Promise.resolve(
      Response.json({
        image: {
          ...providerImage,
          type: 'snapshot',
          status: 'unavailable',
          created_from: { id: 42 },
          disk_size: 40,
          labels: imageBuildLabels(buildId, 'snapshot'),
        },
      }),
    ),
  );
  expect(await snapshot.get({ kind: 'snapshot', id: '100' })).toMatchObject({
    kind: 'snapshot',
    status: 'unavailable',
    sourceServerId: '42',
    imageSizeGb: null,
  });
  await expect(source.getBaseImage('101')).rejects.toThrow('another');
});

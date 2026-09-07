import { imageInstallCommand } from '../packages/images/dist/index.js';
import { readGuestBuild } from './support/guest-build.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { builderPath, builderSchema, imageReceiptSchema } from './support/image-builder.js';
import {
  guestBootstrapFileSchema,
  guestManifestSchema,
  newId,
} from '../packages/contracts/dist/index.js';

const progress = (phase: string) =>
  process.stdout.write(JSON.stringify({ phase, cloudResourcesCreated: 0 }) + '\n');
async function run(binary: string, args: string[], timeout = 30_000, environment = process.env) {
  try {
    return (
      await promisify(execFile)(binary, args, {
        timeout,
        killSignal: 'SIGKILL',
        maxBuffer: 65_536,
        env: environment,
      })
    ).stdout;
  } catch {
    throw new Error(
      `Image smoke failed at ${binary}; inspect only the recorded builder and guest.`,
    );
  }
}
const guestBuild = await readGuestBuild();
await mkdir('.local', { recursive: true, mode: 0o700 });
const builder = builderSchema.parse({
  purpose: 'agent-cloud-local-image-builder',
  name: 'agent-cloud-builder-' + randomUUID().slice(0, 8),
  builderId: randomUUID(),
  phase: 'building',
});
await writeFile(builderPath, JSON.stringify(builder) + '\n', { mode: 0o600, flag: 'wx' });
await run(
  'orb',
  ['create', '--arch', 'amd64', '--user', 'agent-cloud-build', 'ubuntu:noble', builder.name],
  180_000,
);
const vm = (args: string[], timeout?: number) =>
  run('orb', ['run', '-m', builder.name, '-u', 'root', '-w', '/tmp', ...args], timeout);
progress('installing owned image builder');
await vm(['cp', '-R', '/mnt/mac' + guestBuild.directory, '/tmp/agent-cloud-input']);
// A package-manager sentinel proves installer refusal precedes package mutation.
await vm([
  '/bin/sh',
  '-c',
  'mkdir /tmp/agent-cloud-preflight-tools; printf "#!/bin/sh\ntouch /tmp/agent-cloud-preflight-ran\nexit 99\n" > /tmp/agent-cloud-preflight-tools/apt-get; chmod 0755 /tmp/agent-cloud-preflight-tools/apt-get',
]);
const refuseInstallation = async () => {
  await assert.rejects(
    vm([
      'env',
      'PATH=/tmp/agent-cloud-preflight-tools:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      '/bin/sh',
      '/tmp/agent-cloud-input/install.sh',
      '/tmp/agent-cloud-input',
      builder.builderId,
      guestBuild.manifestDigest,
    ]),
  );
  await vm(['test', '!', '-e', '/tmp/agent-cloud-preflight-ran']);
};
await vm(['mkdir', '/tmp/agent-cloud-preflight-state']);
await vm(['ln', '-s', '/tmp/agent-cloud-preflight-state', '/var/lib/agent-cloud']);
await refuseInstallation();
await vm(['rm', '/var/lib/agent-cloud']);
await vm(['touch', '/var/lib/agent-cloud']);
await refuseInstallation();
await vm(['rm', '/var/lib/agent-cloud']);
await vm(['mv', '/home/agent-cloud-build', '/tmp/agent-cloud-preflight-home']);
await vm(['ln', '-s', '/tmp/agent-cloud-preflight-home', '/home/agent-cloud-build']);
await refuseInstallation();
await vm(['rm', '/home/agent-cloud-build']);
await vm(['mv', '/tmp/agent-cloud-preflight-home', '/home/agent-cloud-build']);
const homeOwner = (await vm(['stat', '-c', '%u', '/home/agent-cloud-build'])).trim();
await vm(['chown', '0', '/home/agent-cloud-build']);
await refuseInstallation();
await vm(['chown', homeOwner, '/home/agent-cloud-build']);
await vm([
  '/bin/sh',
  '-c',
  'PATH=/tmp/agent-cloud-preflight-tools:/usr/bin:/bin apt-get; test -f /tmp/agent-cloud-preflight-ran',
]);
await vm([
  'rm',
  '-rf',
  '/tmp/agent-cloud-preflight-tools',
  '/tmp/agent-cloud-preflight-ran',
  '/tmp/agent-cloud-preflight-state',
]);
await vm(
  imageInstallCommand({
    directory: '/tmp/agent-cloud-input',
    builderId: builder.builderId,
    manifestDigest: guestBuild.manifestDigest,
    checksumDigest: guestBuild.checksumDigest,
  }),
  600_000,
);
const manifest = guestManifestSchema.parse(
  JSON.parse(await readFile(guestBuild.directory + '/image.json', 'utf8')),
);
const refusalBootstrap = guestBootstrapFileSchema.parse({
  token: 'a'.repeat(43),
  spec: {
    version: 1,
    accountId: newId.account(),
    machineId: newId.machine(),
    allocationId: newId.allocation(),
    operationId: newId.operation(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    enrollmentUrl: 'https://enrollment.invalid/guest/enroll',
    image: {
      providerImage: 'refusal-fixture',
      architecture: manifest.architecture,
      version: manifest.version,
      ...manifest.trust,
      manifestDigest: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    },
  },
});
const refusalFile = resolve('.local/image-refusal-' + builder.builderId + '.json');
try {
  await writeFile(refusalFile, JSON.stringify(refusalBootstrap), { mode: 0o600, flag: 'wx' });
  await vm([
    'install',
    '-m',
    '0600',
    '/mnt/mac' + refusalFile,
    '/var/lib/agent-cloud/bootstrap.json',
  ]);
  await assert.rejects(vm(['/usr/local/bin/guestctl', 'enroll', '--json']));
  await vm([
    '/bin/sh',
    '-c',
    'test ! -e /var/lib/agent-cloud/keys && test ! -e /var/lib/agent-cloud/allocation.json',
  ]);
} finally {
  await rm(refusalFile, { force: true });
  await vm(['rm', '-f', '/var/lib/agent-cloud/bootstrap.json']);
}
// Native refusal tests must preserve both the sentinel and builder access before any cleanup.
await vm(['/bin/sh', '-c', 'printf "allocation-sentinel" > /var/lib/agent-cloud/allocation.json']);
await assert.rejects(vm(['/usr/local/bin/guestctl', 'prepare-image', '--json']));
assert.equal(await vm(['cat', '/var/lib/agent-cloud/allocation.json']), 'allocation-sentinel');
await vm(['rm', '/var/lib/agent-cloud/allocation.json']);
await vm(['docker', 'volume', 'create', 'agent-cloud-refusal-sentinel']);
await assert.rejects(vm(['/usr/local/bin/guestctl', 'prepare-image', '--json']));
assert.ok(
  (await vm(['docker', 'volume', 'ls', '--quiet'])).includes('agent-cloud-refusal-sentinel'),
);
await vm(['docker', 'volume', 'rm', 'agent-cloud-refusal-sentinel']);
await vm(['docker', 'network', 'create', 'agent-cloud-refusal-sentinel']);
await assert.rejects(vm(['/usr/local/bin/guestctl', 'prepare-image', '--json']));
await vm(['docker', 'network', 'inspect', 'agent-cloud-refusal-sentinel']);
await vm(['docker', 'network', 'rm', 'agent-cloud-refusal-sentinel']);
await vm(['mkdir', '/home/agent-cloud-unexpected']);
try {
  await assert.rejects(vm(['/usr/local/bin/guestctl', 'prepare-image', '--json']));
  await vm(['test', '-d', '/home/agent-cloud-unexpected']);
} finally {
  await vm(['rmdir', '/home/agent-cloud-unexpected']);
}
await vm(['mv', '/var/lib/agent-cloud', '/tmp/agent-cloud-empty-state']);
await vm(['ln', '-s', '/tmp/agent-cloud-empty-state', '/var/lib/agent-cloud']);
try {
  await assert.rejects(vm(['/usr/local/bin/guestctl', 'prepare-image', '--json']));
} finally {
  await vm(['rm', '/var/lib/agent-cloud']);
  await vm(['mv', '/tmp/agent-cloud-empty-state', '/var/lib/agent-cloud']);
}
progress('verifying sanitation cannot restart a stopped Docker workload');
const sentinelImage =
  'alpine:3.23@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40';
await vm(['docker', 'pull', sentinelImage], 120_000);
await vm(['mkdir', '/tmp/agent-cloud-restart-sentinel']);
await vm([
  'docker',
  'run',
  '--detach',
  '--name',
  'agent-cloud-restart-sentinel',
  '--restart',
  'always',
  '--mount',
  'type=bind,source=/tmp/agent-cloud-restart-sentinel,target=/marker',
  sentinelImage,
  '/bin/sh',
  '-c',
  'touch /marker/ran; sleep 600',
]);
await vm(['docker', 'stop', '--time', '0', 'agent-cloud-restart-sentinel']);
await vm(['rm', '-f', '/tmp/agent-cloud-restart-sentinel/ran']);
await vm(['systemctl', 'stop', 'docker.service', 'docker.socket']);
await assert.rejects(vm(['/usr/local/bin/guestctl', 'prepare-image', '--json']));
assert.equal(
  (await vm(['systemctl', 'show', '--property=ActiveState', '--value', 'docker.service'])).trim(),
  'inactive',
);
await vm(['test', '!', '-e', '/tmp/agent-cloud-restart-sentinel/ran']);
await vm(['systemctl', 'start', 'docker.service']);
for (let i = 0; i < 20; i++) {
  if (
    (
      await vm([
        '/bin/sh',
        '-c',
        'if test -f /tmp/agent-cloud-restart-sentinel/ran; then printf ran; fi',
      ])
    ).trim() === 'ran'
  )
    break;
  await setTimeout(500);
}
await vm(['test', '-f', '/tmp/agent-cloud-restart-sentinel/ran']);
await vm(['docker', 'rm', '--force', 'agent-cloud-restart-sentinel']);
await vm(['docker', 'image', 'rm', sentinelImage]);
await vm(['rm', '-rf', '/tmp/agent-cloud-restart-sentinel']);
progress('sanitizing empty builder and verifying retry');
// Force a real error after the durable preparing write and machine-ID cleanup.
const logMode = (await vm(['stat', '-c', '%a', '/var/log'])).trim();
await vm(['touch', '/home/agent-cloud-build/.agent-cloud-access-sentinel']);
await vm(['chmod', '0777', '/var/log']);
try {
  await assert.rejects(vm(['/usr/local/bin/guestctl', 'prepare-image', '--json'], 120_000));
  assert.equal(
    (await vm(['jq', '-r', '.kind', '/usr/lib/agent-cloud/image-build.json'])).trim(),
    'preparing',
  );
  assert.equal((await vm(['cat', '/etc/machine-id'])).trim(), 'uninitialized');
  await vm(['test', '-f', '/home/agent-cloud-build/.agent-cloud-access-sentinel']);
} finally {
  await vm(['chmod', logMode, '/var/log']);
}
// Unexpected daemon restart during recovery must not erase newly added data.
// The preceding negative drills deliberately restart Docker repeatedly in one short run.
await vm(['systemctl', 'reset-failed', 'docker.service', 'docker.socket']);
await vm(['systemctl', 'start', 'docker.service']);
await vm(['docker', 'volume', 'create', 'agent-cloud-retry-sentinel']);
await assert.rejects(vm(['/usr/local/bin/guestctl', 'prepare-image', '--json']));
await vm(['docker', 'volume', 'inspect', 'agent-cloud-retry-sentinel']);
await vm(['docker', 'volume', 'rm', 'agent-cloud-retry-sentinel']);
await vm(['systemctl', 'stop', 'docker.service', 'docker.socket']);
const receipt = imageReceiptSchema.parse(
  JSON.parse(await vm(['/usr/local/bin/guestctl', 'prepare-image', '--json'], 120_000)),
);
assert.equal(receipt.builderId, builder.builderId);
assert.deepEqual(
  imageReceiptSchema.parse(
    JSON.parse(await vm(['/usr/local/bin/guestctl', 'prepare-image', '--json'], 120_000)),
  ),
  receipt,
);
await vm(['logger', 'agent-cloud-sanitized-log-sentinel']);
await vm(['journalctl', '--sync']);
assert.equal((await vm(['find', '/var/log', '-mindepth', '1', '-print', '-quit'])).trim(), '');
await run('orb', ['stop', builder.name], 120_000);
await writeFile(builderPath, JSON.stringify({ ...builder, phase: 'sanitized' }) + '\n', {
  mode: 0o600,
});
const rejectedClonePath = resolve('.local/guest-image-refusal.json');
const rejectedClone = {
  purpose: 'agent-cloud-image-refusal-clone',
  name: 'agent-cloud-refusal-' + randomUUID().slice(0, 8),
  builderId: builder.builderId,
};
await writeFile(rejectedClonePath, JSON.stringify(rejectedClone) + '\n', {
  mode: 0o600,
  flag: 'wx',
});
await run('orb', ['clone', builder.name, rejectedClone.name], 120_000);
const rejectedVm = (args: string[]) =>
  run('orb', ['run', '-m', rejectedClone.name, '-u', 'root', '-w', '/tmp', ...args]);
const cloneMachineId = (await rejectedVm(['cat', '/etc/machine-id'])).trim();
await rejectedVm([
  '/usr/local/bin/node',
  '--input-type=module',
  '-e',
  'import {readFileSync,writeFileSync} from "node:fs"; const path="/usr/lib/agent-cloud/image-build.json"; const record=JSON.parse(readFileSync(path,"utf8")); record.kind="preparing"; writeFileSync(path,JSON.stringify(record),{mode:0o600});',
]);
await assert.rejects(rejectedVm(['/usr/local/bin/guestctl', 'prepare-image', '--json']));
assert.equal((await rejectedVm(['cat', '/etc/machine-id'])).trim(), cloneMachineId);
await run('orb', ['delete', '--force', rejectedClone.name], 60_000);
await rm(rejectedClonePath);
const resultSchema = z.object({
  result: z.literal('guest-verified'),
  machineId: z.string().regex(/^[0-9a-f]{32}$/),
  sshIdentity: z.string().length(64),
  tlsIdentity: z.string().length(64),
  allocationId: z.string().startsWith('alloc_'),
});
const identities: Array<z.infer<typeof resultSchema>> = [];
for (let clone = 1; clone <= 2; clone++) {
  progress(`verifying fresh clone ${clone}`);
  const output = await run(
    process.execPath,
    ['--import', 'tsx', 'scripts/smoke-guest.ts'],
    600_000,
    {
      ...process.env,
      AGENT_CLOUD_SANITIZED_IMAGE: '1',
      AGENT_CLOUD_INPUT_DIGEST: guestBuild.manifestDigest,
    },
  );
  const reports = output
    .trim()
    .split('\n')
    .map((line) => resultSchema.safeParse(JSON.parse(line)));
  const report = reports.find((result) => result.success);
  if (!report?.success) throw new Error('Clone did not report verified identity.');
  identities.push(report.data);
  process.stdout.write(output);
}
for (const field of ['machineId', 'sshIdentity', 'tlsIdentity', 'allocationId'] satisfies Array<
  keyof z.infer<typeof resultSchema>
>)
  assert.equal(
    new Set(identities.map((identity) => identity[field])).size,
    2,
    `Clones share ${field}.`,
  );
// Re-read the exact record before deleting the builder.
assert.equal(
  builderSchema.parse(JSON.parse(await readFile(builderPath, 'utf8'))).name,
  builder.name,
);
await run('orb', ['delete', '--force', builder.name], 60_000);
await rm(builderPath);
progress('sanitized image passed two distinct cloned identities and cleanup');

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { newId, guestProofSchema } from '../packages/contracts/dist/index.js';
import { createSigner, guestName, probePrincipal } from '../packages/pki/dist/index.js';
import { createGuestProbe } from '../packages/remote/dist/index.js';
import { readPrivateFile } from '../apps/control/src/private-file.js';

const scratch = await mkdtemp(resolve('.local/ssh-smoke-'));
const fixture = join(scratch, 'fixture');
const containerName = `agent-cloud-ssh-${randomUUID()}`;
const step = resolve('.local/tools/step-0.30.6');
const run = async (binary: string, args: string[]) => {
  try {
    return await promisify(execFile)(binary, args, {
      env: { ...process.env, STEPPATH: scratch },
      timeout: 20_000,
      maxBuffer: 32768,
    });
  } catch {
    throw new Error('SSH smoke subprocess failed.');
  }
};
async function cleanup() {
  try {
    await promisify(execFile)('docker', ['rm', '-f', containerName], {
      timeout: 20_000,
      maxBuffer: 4096,
    });
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        'stderr' in error &&
        typeof error.stderr === 'string' &&
        error.stderr.includes(`No such container: ${containerName}`)
      )
    )
      throw new Error(`Could not confirm cleanup of SSH fixture ${containerName}.`, {
        cause: error,
      });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
try {
  await mkdir(fixture, { mode: 0o755 });
  const signer = createSigner({
    binary: step,
    caUrl: 'https://localhost:9449',
    tlsRoot: await readFile(resolve('.local/pki/public/root_ca.crt'), 'utf8'),
    sshHostCa: (await readFile(resolve('.local/pki/public/ssh_host_ca_key.pub'), 'utf8')).trim(),
    sshUserCa: (await readFile(resolve('.local/pki/public/ssh_user_ca_key.pub'), 'utf8')).trim(),
    provisioner: 'agent-cloud-control',
    provisionerPassword: await readPrivateFile(resolve('.local/pki/provisioner-password')),
  });
  const allocationId = newId.allocation();
  const name = guestName(allocationId);
  await run('/usr/bin/ssh-keygen', [
    '-t',
    'ed25519',
    '-N',
    '',
    '-C',
    '',
    '-f',
    join(fixture, 'host_key'),
  ]);
  const publicKey = (await readFile(join(fixture, 'host_key.pub'), 'utf8')).trim();
  await writeFile(
    join(fixture, 'host_key-cert.pub'),
    (await signer.signHost({ allocationId, publicKey })) + '\n',
    { mode: 0o644 },
  );
  await writeFile(
    join(fixture, 'user_ca.pub'),
    await readFile(resolve('.local/pki/public/ssh_user_ca_key.pub')),
    { mode: 0o644 },
  );
  await writeFile(join(fixture, 'principals'), probePrincipal(allocationId) + '\n', {
    mode: 0o644,
  });
  await run(step, [
    'certificate',
    'create',
    name,
    join(scratch, 'guest.csr'),
    join(scratch, 'guest.key'),
    '--csr',
    '--kty',
    'EC',
    '--curve',
    'P-256',
    '--no-password',
    '--insecure',
    '--san',
    name,
  ]);
  const proof = guestProofSchema.parse({
    version: 1,
    allocationId,
    imageVersion: 'fixture-v1',
    manifestDigest: 'a'.repeat(64),
    sshHostPublicKey: publicKey,
    tlsCsr: await readFile(join(scratch, 'guest.csr'), 'utf8'),
  });
  await writeFile(join(fixture, 'proof.json'), JSON.stringify(proof) + '\n', { mode: 0o644 });
  await run('docker', [
    'run',
    '--detach',
    '--rm',
    '--name',
    containerName,
    '--label',
    'agent-cloud.test=ssh-proof',
    '--publish',
    '127.0.0.1::2222',
    '--mount',
    `type=bind,source=${fixture},target=/fixture,readonly`,
    '--memory',
    '64m',
    '--cpus',
    '0.25',
    '--security-opt',
    'no-new-privileges:true',
    'agent-cloud-ssh-fixture:development',
  ]);
  const published = (await run('docker', ['port', containerName, '2222/tcp'])).stdout.trim();
  const match = /^127\.0\.0\.1:(\d+)$/.exec(published);
  if (!match?.[1]) throw new Error('Expected a loopback-only SSH port.');
  const port = Number(match[1]);
  let listening = false;
  for (let count = 0; count < 30 && !listening; count++) {
    listening = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: '127.0.0.1', port });
      socket.setTimeout(500);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (!listening) await setTimeout(100);
  }
  assert.ok(listening, 'Disposable SSH server must listen.');
  const probe = createGuestProbe();
  const target = {
    allocationId,
    address: '127.0.0.1',
    port,
    credential: await signer.issueProbeCredential(allocationId),
  };
  assert.deepEqual(
    await probe.readIdentity({ ...target, trust: { kind: 'pinned_key', publicKey } }),
    proof,
  );
  const hostCa = (await readFile(resolve('.local/pki/public/ssh_host_ca_key.pub'), 'utf8')).trim();
  assert.deepEqual(
    await probe.readIdentity({ ...target, trust: { kind: 'host_ca', publicKey: hostCa } }),
    proof,
  );
  await run('/usr/bin/ssh-keygen', [
    '-t',
    'ed25519',
    '-N',
    '',
    '-C',
    '',
    '-f',
    join(scratch, 'wrong_key'),
  ]);
  const wrongKey = (await readFile(join(scratch, 'wrong_key.pub'), 'utf8')).trim();
  await assert.rejects(
    probe.readIdentity({ ...target, trust: { kind: 'pinned_key', publicKey: wrongKey } }),
    /SSH identity proof failed/,
  );
  await assert.rejects(
    probe.readIdentity({ ...target, trust: { kind: 'host_ca', publicKey: wrongKey } }),
    /SSH identity proof failed/,
  );
  const foreign = newId.allocation();
  await assert.rejects(
    probe.readIdentity({
      ...target,
      allocationId: foreign,
      credential: await signer.issueProbeCredential(foreign),
      trust: { kind: 'pinned_key', publicKey },
    }),
    /SSH identity proof failed/,
  );
  await writeFile(
    join(fixture, 'proof.json'),
    JSON.stringify({ ...proof, allocationId: newId.allocation() }),
    { mode: 0o644 },
  );
  await assert.rejects(
    probe.readIdentity({ ...target, trust: { kind: 'pinned_key', publicKey } }),
    /disagrees with the allocation/,
  );
  process.stdout.write(
    JSON.stringify({
      ok: true,
      pinnedHostKey: 'verified connection',
      hostCa: 'verified connection',
      wrongHostKey: 'rejected',
      wrongHostCa: 'rejected',
      foreignAllocationCertificate: 'rejected',
      wrongGuestEvidence: 'rejected',
      cloudResourcesCreated: 0,
    }) + '\n',
  );
} finally {
  // Even an uncertain docker-run response may have created the uniquely named owned fixture.
  await cleanup();
}

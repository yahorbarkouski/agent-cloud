import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createPublicKey, randomUUID, X509Certificate } from 'node:crypto';
import { createServer, request } from 'node:https';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { guestSubject, imageBuildIdSchema, newId } from '../packages/contracts/dist/index.js';
import {
  createSigner,
  guestName,
  probePrincipal,
  runtimePrincipal,
} from '../packages/pki/dist/index.js';
import { readPrivateFile } from '../apps/control/src/private-file.js';
import { inspectIssuedTls } from '../packages/pki/dist/tls-certificate.js';

const subjects = [
  guestSubject({ version: 1, allocationId: newId.allocation() }),
  guestSubject({
    version: 2,
    subject: { kind: 'image_verifier', id: imageBuildIdSchema.parse(randomUUID()) },
  }),
];
// Check the policy before signing and the actual service output afterwards. Never print CA logs.
const caConfiguration: unknown = JSON.parse(
  await readFile(resolve('.local/pki/issuer/config/ca.json'), 'utf8'),
);
assert.ok(
  typeof caConfiguration === 'object' &&
    caConfiguration !== null &&
    !Object.hasOwn(caConfiguration, 'logger'),
  'CA access logging must be disabled before signing.',
);
const logStart = new Date().toISOString();
for (const subject of subjects) {
  const scratch = await mkdtemp(resolve('.local/pki-smoke-'));
  const step = resolve('.local/tools/step-0.30.6');
  const ca = await readFile(resolve('.local/pki/public/root_ca.crt'), 'utf8');
  const run = async (binary: string, args: string[]) => {
    try {
      return await promisify(execFile)(binary, args, {
        env: { PATH: '/usr/bin:/bin', STEPPATH: scratch, LANG: 'C' },
        timeout: 20_000,
        maxBuffer: 32768,
      });
    } catch {
      throw new Error('PKI smoke subprocess failed.');
    }
  };
  try {
    const signer = createSigner({
      binary: step,
      caUrl: 'https://localhost:9449',
      tlsRoot: ca,
      sshHostCa: (await readFile(resolve('.local/pki/public/ssh_host_ca_key.pub'), 'utf8')).trim(),
      sshUserCa: (await readFile(resolve('.local/pki/public/ssh_user_ca_key.pub'), 'utf8')).trim(),
      provisioner: 'agent-cloud-control',
      provisionerPassword: await readPrivateFile(resolve('.local/pki/provisioner-password')),
    });
    const name = guestName(subject);
    const sshKeyPath = join(scratch, 'ssh_key');
    await run('/usr/bin/ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', '', '-f', sshKeyPath]);
    const publicKey = (await readFile(sshKeyPath + '.pub', 'utf8')).trim();
    const host = await signer.signHost({ subject, publicKey });
    const probe = (await signer.issueProbeCredential(subject)).certificate;
    const runtime = (await signer.issueRuntimeCredential(subject)).certificate;
    await writeFile(join(scratch, 'host-cert.pub'), host + '\n', { mode: 0o600 });
    await writeFile(join(scratch, 'probe-cert.pub'), probe + '\n', { mode: 0o600 });
    await writeFile(join(scratch, 'runtime-cert.pub'), runtime + '\n', { mode: 0o600 });
    const hostInspection = await run('/usr/bin/ssh-keygen', [
      '-L',
      '-f',
      join(scratch, 'host-cert.pub'),
    ]);
    const probeInspection = await run('/usr/bin/ssh-keygen', [
      '-L',
      '-f',
      join(scratch, 'probe-cert.pub'),
    ]);
    assert.match(hostInspection.stdout, /host certificate/);
    assert.ok(hostInspection.stdout.includes(name));
    assert.match(probeInspection.stdout, /user certificate/);
    assert.ok(probeInspection.stdout.includes(probePrincipal(subject)));
    assert.ok(
      probeInspection.stdout.includes('force-command /usr/local/bin/guestctl identity --json'),
    );
    const runtimeInspection = await run('/usr/bin/ssh-keygen', [
      '-L',
      '-f',
      join(scratch, 'runtime-cert.pub'),
    ]);
    assert.match(runtimeInspection.stdout, /user certificate/);
    assert.ok(runtimeInspection.stdout.includes(runtimePrincipal(subject)));
    assert.ok(
      runtimeInspection.stdout.includes(
        'force-command /usr/bin/sudo -n -- /usr/local/bin/guestctl inspect --json',
      ),
    );
    assert.match(runtimeInspection.stdout, /Extensions:\s+\(none\)/);
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
    const csr = await readFile(join(scratch, 'guest.csr'), 'utf8');
    await assert.rejects(
      signer.signTls({ subject: { kind: 'allocation', id: newId.allocation() }, csr }),
      /guest identity name/,
    );
    await run(step, [
      'certificate',
      'create',
      name,
      join(scratch, 'extra.csr'),
      join(scratch, 'extra.key'),
      '--csr',
      '--kty',
      'EC',
      '--curve',
      'P-256',
      '--no-password',
      '--insecure',
      '--san',
      name,
      '--san',
      'other.guest.agent-cloud.internal',
    ]);
    await assert.rejects(
      signer.signTls({ subject, csr: await readFile(join(scratch, 'extra.csr'), 'utf8') }),
      /guest identity name/,
    );
    await run(step, [
      'certificate',
      'create',
      name,
      join(scratch, 'curve.csr'),
      join(scratch, 'curve.key'),
      '--csr',
      '--kty',
      'EC',
      '--curve',
      'P-384',
      '--no-password',
      '--insecure',
      '--san',
      name,
    ]);
    await assert.rejects(
      signer.signTls({ subject, csr: await readFile(join(scratch, 'curve.csr'), 'utf8') }),
      /P-256/,
    );
    const cert = await signer.signTls({ subject, csr });
    const leaf = new X509Certificate(cert);
    assert.equal(leaf.subjectAltName, `DNS:${name}`);
    assert.ok(leaf.validToDate.getTime() - Date.now() <= 3_600_000);
    assert.equal(leaf.ca, false);
    const expectedKey = createPublicKey(await readFile(join(scratch, 'guest.key')));
    const wrongKey = createPublicKey(await readFile(join(scratch, 'extra.key')));
    assert.throws(() => {
      inspectIssuedTls(leaf, {
        name,
        key: wrongKey,
        timing: { kind: 'signing', startedAt: Date.now() },
      });
    }, /incompatible guest certificate/);
    assert.throws(() => {
      inspectIssuedTls(leaf, {
        name,
        key: expectedKey,
        timing: { kind: 'signing', startedAt: Date.now() - 3_600_000 },
      });
    }, /incompatible certificate validity/);
    const server = createServer(
      { cert, key: await readFile(join(scratch, 'guest.key')) },
      (_request, response) => {
        response.end('guest-proof');
      },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP listener.');
      const port = address.port;
      function probeTls(servername: string) {
        return new Promise<string>((resolve, reject) => {
          const req = request(
            { host: '127.0.0.1', port, servername, ca, agent: false, timeout: 5000 },
            (response) => {
              let body = '';
              response.on('data', (chunk: Buffer) => {
                body += chunk.toString();
              });
              response.on('end', () => {
                resolve(body);
              });
              response.on('error', reject);
            },
          );
          req.on('error', reject);
          req.on('timeout', () => {
            req.destroy(new Error('TLS probe timed out.'));
          });
          req.end();
        });
      }
      assert.equal(await probeTls(name), 'guest-proof');
      await assert.rejects(
        probeTls(guestName({ kind: 'allocation', id: newId.allocation() })),
        /Hostname\/IP does not match/,
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    }
    process.stdout.write(
      JSON.stringify({
        ok: true,
        subject: subject.kind,
        sshHostCertificate: 'issued and inspected',
        sshProbeCertificate: 'issued and inspected',
        sshRuntimeCertificate: 'issued with fixed privileged inspection command and no extensions',
        tls: 'verified real connection',
        wrongAllocation: 'rejected before signing',
        wrongTlsName: 'rejected',
        cloudResourcesCreated: 0,
      }) + '\n',
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
const logs = await promisify(execFile)(
  'docker',
  [
    'compose',
    '--env-file',
    '.local/pki/compose.env',
    '-f',
    'infra/compose/pki-development.yaml',
    'logs',
    '--since',
    logStart,
    '--no-color',
    'ca',
  ],
  { timeout: 10_000, maxBuffer: 256 * 1024 },
).catch(() => {
  throw new Error('CA logging verification could not read service output.');
});
assert.ok(
  !/(?:ott[=:]|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.test(logs.stdout + logs.stderr),
  'CA service output exposed a signing token.',
);
process.stdout.write(JSON.stringify({ caTokenLogging: 'absent during native signing' }) + '\n');

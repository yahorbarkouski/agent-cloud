import assert from 'node:assert/strict';
import { request } from 'node:https';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  accessSessionRecordSchema,
  type AccessSessionRecord,
} from '../packages/contracts/src/index.js';
import { createSigner } from '../packages/pki/src/index.js';
import {
  createCustomerSshSigner,
  customerSshClaim,
  inspectCustomerSsh,
} from '../packages/pki/src/customer-ssh.js';
import { createStepTooling } from '../packages/pki/src/step-tooling.js';
import { accessPublicKey, pendingAccessSession } from '../tests/access-fixture.js';
import { withCaFixture } from './support/ca-fixture.js';
import { checkCustomerSigningTransport } from './support/customer-signer-transport.js';
import { checkCustomerSshProof } from './support/customer-ssh-proof.js';

await withCaFixture(async ({ configuration, scratch, run }) => {
  const tooling = createStepTooling(configuration);
  for (const fault of [false, true]) {
    let workspace = '';
    const result = tooling.inWorkspace({
      work: async (directory) => {
        workspace = directory;
        assert.equal((await stat(directory)).mode & 0o077, 0);
        assert.equal((await stat(join(directory, 'provisioner-password'))).mode & 0o077, 0);
        if (fault) throw new Error('Deliberate fixture failure.');
      },
    });
    if (fault) await assert.rejects(result, /Deliberate fixture failure/);
    else await result;
    await assert.rejects(stat(workspace), { code: 'ENOENT' });
  }
  const now = Date.now();
  const session = accessSessionRecordSchema.parse({
    ...pendingAccessSession(),
    admittedAt: new Date(now - 2000).toISOString(),
    issueDeadline: new Date(now + 88_000).toISOString(),
    hardDeadline: new Date(now + 3_598_000).toISOString(),
    issuance: { kind: 'attempted', attemptedAt: new Date(now - 1000).toISOString() },
    gateway: {
      id: 'local',
      origin: 'ws://127.0.0.1:4322',
      egressCidrs: ['::1/128', '127.0.0.1/32'],
    },
  });
  const authority = { checkedAt: new Date(now), expiresAt: new Date(now + 3_598_000) };
  const claim = customerSshClaim({ session, authority });
  const signer = createCustomerSshSigner(configuration);
  const issued = await signer.sign({ session, authority, signal: AbortSignal.timeout(20_000) });
  assert.equal(issued.kind, 'issued');
  assert.equal(issued.expiresAt, claim.validBefore);

  async function submit(claims: unknown, changes: Record<string, unknown> = {}) {
    return tooling.inWorkspace({
      work: async (directory, step, flags) => {
        const path = join(directory, 'claims.json');
        await writeFile(path, JSON.stringify(claims), { mode: 0o600, flag: 'wx' });
        const token = (
          await step([
            'ca',
            'token',
            claim.keyId,
            '--ssh',
            '--principal',
            claim.principal,
            '--cert-not-before',
            claim.validAfter,
            '--cert-not-after',
            claim.validBefore,
            '--set-file',
            path,
            ...flags,
          ])
        ).trim();
        for (const name of await readdir(directory)) {
          const path = join(directory, name);
          if ((await stat(path)).isFile()) {
            assert.ok(
              !(await readFile(path, 'utf8')).includes(token),
              'OTT must stay out of workspace files.',
            );
          }
        }
        const body = JSON.stringify({
          publicKey: claim.publicKeyWire,
          ott: token,
          certType: 'user',
          keyID: claim.keyId,
          principals: [claim.principal],
          validAfter: claim.validAfter,
          validBefore: claim.validBefore,
          ...changes,
        });
        return new Promise<{ status: number; body: string }>((resolve, reject) => {
          const fail = () => {
            reject(new Error('Native negative signing request failed.'));
          };
          const call = request(
            new URL('/ssh/sign', configuration.caUrl),
            {
              method: 'POST',
              ca: configuration.tlsRoot,
              agent: false,
              signal: AbortSignal.timeout(10_000),
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
              },
            },
            (response) => {
              let data = '';
              response.on('error', fail);
              response.on('data', (chunk: Buffer) => {
                data += chunk.toString();
                if (data.length > 32 * 1024) {
                  call.destroy();
                  fail();
                }
              });
              response.on('end', () => {
                resolve({ status: response.statusCode ?? 0, body: data });
              });
            },
          );
          call.on('error', fail);
          call.end(body);
        });
      },
    });
  }

  const bound = { agentCloudAccess: claim };
  const substituted = await submit(bound, {
    publicKey: accessPublicKey().slice('ssh-ed25519 '.length),
  });
  assert.equal(substituted.status, 400, 'Signed claim must reject a substituted public key.');
  for (const claims of [
    {},
    { agentCloudAccess: { ...claim, kind: 'other' } },
    { agentCloudAccess: { ...claim, extra: 'unexpected' } },
    { agentCloudAccess: { ...claim, keyId: 'customer:other' } },
    { agentCloudAccess: { ...claim, principal: 'customer-other' } },
    { agentCloudAccess: { ...claim, sourceAddresses: [] } },
    { agentCloudAccess: { ...claim, sourceAddresses: ['127.0.0.1/32', '127.0.0.1/32'] } },
    { agentCloudAccess: { ...claim, sourceAddresses: ['0.0.0.0/0'] } },
  ]) {
    const response = await submit(claims);
    assert.ok(
      [400, 403].includes(response.status),
      'Malformed signed customer claims must fail closed.',
    );
  }
  const unsigned = await submit({}, { templateData: bound });
  assert.ok(
    [400, 403].includes(unsigned.status),
    'Unsigned template data must not authorize customer access.',
  );
  const extraPermissions = await submit(bound, {
    templateData: { agentCloudAccess: { ...claim, sourceAddresses: ['0.0.0.0/0'] } },
    extensions: { 'permit-port-forwarding': '' },
    criticalOptions: {},
  });
  assert.equal(extraPermissions.status, 201);
  const parsed = z.object({ crt: z.string().min(1) }).parse(JSON.parse(extraPermissions.body));
  const certPath = join(scratch, 'request-options-cert.pub');
  await writeFile(certPath, `ssh-ed25519-cert-v01@openssh.com ${parsed.crt}\n`, { mode: 0o600 });
  inspectCustomerSsh(
    JSON.parse(await run(configuration.binary, ['ssh', 'inspect', certPath, '--format', 'json'])),
    {
      claim,
      userCa: configuration.sshUserCa,
    },
  );
  const shortenedAuthority = { checkedAt: new Date(), expiresAt: new Date(Date.now() + 10_000) };
  const shortened = await signer.sign({
    session,
    authority: shortenedAuthority,
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(
    shortened.kind,
    'issued',
    'Near-expiry authority must meet the CA minimum without widening expiry.',
  );
  assert.equal(
    shortened.expiresAt,
    customerSshClaim({ session, authority: shortenedAuthority }).validBefore,
  );

  const existing = createSigner(configuration);
  const subject = { kind: 'allocation', id: session.allocationId } satisfies Parameters<
    typeof existing.signHost
  >[0]['subject'];
  await existing.signHost({ subject, publicKey: session.publicKey });
  await existing.issueProbeCredential(subject);
  await existing.issueRuntimeCredential(subject);
  const expired = { ...session, issuance: { kind: 'pending' } } satisfies AccessSessionRecord;
  await assert.rejects(
    signer.sign({ session: expired, authority, signal: AbortSignal.timeout(20_000) }),
  );
  assert.equal(
    (await signer.sign({ session, authority, signal: AbortSignal.abort() })).kind,
    'failed',
  );
  await checkCustomerSigningTransport({ configuration, scratch, run, session });
  await checkCustomerSshProof({ configuration, session });
  process.stdout.write(
    JSON.stringify({
      customerCertificate:
        'issued with exact key, allocation, sources, PTY-only permission and absolute validity',
      keySubstitution: 'rejected by native CA',
      malformedOrUnsignedClaims: 'rejected',
      requestPermissions: 'cannot expand signed policy',
      nearExpiry: 'issued without widening ancestry expiry',
      existingHostProbeRuntime: 'native inspectors passed',
      paidResourcesCreated: 0,
    }) + '\n',
  );
});
process.stdout.write(
  JSON.stringify({
    cleanup: 'fresh CA container and all private fixture keys removed',
    caTokenLogging: 'absent',
  }) + '\n',
);

import { request } from 'node:https';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  accessSessionRecordSchema,
  accessGatewaySchema,
  CloudError,
  type AccessSessionRecord,
} from '@agent-cloud/contracts';
import { sshFingerprint } from './ssh-certificate.js';
import { createStepTooling, type SignerConfiguration } from './step-tooling.js';

const claimSchema = z.strictObject({
  kind: z.literal('customer_ssh_v1'),
  keyId: z.string().min(1).max(256),
  principal: z.string().min(1).max(128),
  publicKeyWire: z
    .string()
    .length(68)
    .regex(/^[A-Za-z0-9+/]+$/),
  sourceAddresses: accessGatewaySchema.shape.egressCidrs,
  validAfter: z.iso.datetime(),
  validBefore: z.iso.datetime(),
});
export type CustomerSshClaim = z.infer<typeof claimSchema>;

export function customerSshClaim(input: {
  session: AccessSessionRecord;
  authority: { checkedAt: Date; expiresAt: Date };
}): CustomerSshClaim {
  const session = accessSessionRecordSchema.parse(input.session);
  const now = input.authority.checkedAt.getTime();
  const deadline = Math.min(
    input.authority.expiresAt.getTime(),
    Date.parse(session.hardDeadline),
    now + 240_000,
  );
  const before = Math.floor(deadline / 1000) * 1000;
  if (
    session.issuance.kind !== 'attempted' ||
    session.connection.kind !== 'unclaimed' ||
    now < Date.parse(session.issuance.attemptedAt) ||
    now >= Date.parse(session.issueDeadline) ||
    !Number.isFinite(before) ||
    before <= now
  )
    throw new CloudError(
      'permission_denied',
      'Customer signing requires a current recorded attempt.',
    );
  return claimSchema.parse({
    kind: 'customer_ssh_v1',
    keyId: `customer:${session.id}:${session.grantId}:${session.machineId}`,
    principal: `customer-${session.allocationId}`,
    publicKeyWire: session.publicKey.slice('ssh-ed25519 '.length),
    sourceAddresses: session.gateway.egressCidrs.toSorted(),
    validAfter: new Date(Math.floor(now / 1000) * 1000 - 60_000).toISOString(),
    validBefore: new Date(before).toISOString(),
  });
}

/** Policy inspection of the authenticated CA response. OpenSSH verifies its signature. */
export function inspectCustomerSsh(
  value: unknown,
  expected: {
    claim: CustomerSshClaim;
    userCa: string;
  },
) {
  const { claim } = expected;
  const result = z
    .object({
      Type: z.literal('user'),
      KeyName: z.literal('ssh-ed25519-cert-v01@openssh.com'),
      KeyFingerprint: z.literal(sshFingerprint(`ssh-ed25519 ${claim.publicKeyWire}`)),
      SigningKeyFingerprint: z.literal(sshFingerprint(expected.userCa)),
      KeyID: z.literal(claim.keyId),
      Principals: z.tuple([z.literal(claim.principal)]),
      ValidAfter: z.iso.datetime({ offset: true }),
      ValidBefore: z.iso.datetime({ offset: true }),
      CriticalOptions: z.strictObject({
        'source-address': z.literal(claim.sourceAddresses.join(',')),
      }),
      Extensions: z.strictObject({ 'permit-pty': z.literal('') }),
    })
    .safeParse(value);
  if (
    !result.success ||
    Date.parse(result.data.ValidAfter) !== Date.parse(claim.validAfter) ||
    Date.parse(result.data.ValidBefore) !== Date.parse(claim.validBefore)
  )
    throw new CloudError(
      'provider_unavailable',
      'CA returned an incompatible customer certificate.',
    );
  return { expiresAt: new Date(Date.parse(result.data.ValidBefore)).toISOString() };
}

type SigningResponse = { kind: 'received'; value: unknown } | { kind: 'rejected' };

/** One direct TLS request. Redirects, unbounded bodies and ambiguous retries are refused. */
async function submitCertificate(input: {
  caUrl: string;
  root: string;
  token: string;
  claim: CustomerSshClaim;
  signal: AbortSignal;
  onSubmit: () => void;
}): Promise<SigningResponse> {
  const body = JSON.stringify({
    publicKey: input.claim.publicKeyWire,
    ott: input.token,
    certType: 'user',
    keyID: input.claim.keyId,
    principals: [input.claim.principal],
    validAfter: input.claim.validAfter,
    validBefore: input.claim.validBefore,
  });
  if (Buffer.byteLength(body) > 32 * 1024)
    throw new Error('Signing request exceeds its size limit.');
  input.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const fail = () => {
      reject(
        new CloudError(
          'provider_outcome_unknown',
          'Customer signing response was not established.',
        ),
      );
    };
    const call = request(
      new URL('/ssh/sign', input.caUrl),
      {
        method: 'POST',
        ca: input.root,
        rejectUnauthorized: true,
        agent: false,
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(20_000)]),
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('error', fail);
        response.on('aborted', fail);
        response.on('data', (chunk: unknown) => {
          if (!Buffer.isBuffer(chunk) || (size += chunk.length) > 32 * 1024) {
            response.destroy();
            call.destroy();
            fail();
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if ([400, 401, 403].includes(response.statusCode ?? 0)) {
            resolve({ kind: 'rejected' });
            return;
          }
          if (response.statusCode !== 201) {
            fail();
            return;
          }
          try {
            const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve({ kind: 'received', value });
          } catch {
            fail();
          }
        });
      },
    );
    call.on('error', fail);
    input.onSubmit();
    call.end(body);
  });
}

export type CustomerSshResult =
  | { kind: 'issued'; certificate: string; expiresAt: string }
  | { kind: 'rejected' }
  | { kind: 'failed' }
  | { kind: 'unknown' };

export function createCustomerSshSigner(configuration: SignerConfiguration) {
  const tooling = createStepTooling(configuration);
  return {
    userCa: tooling.userCa,
    async sign(
      input: Parameters<typeof customerSshClaim>[0] & { signal: AbortSignal },
    ): Promise<CustomerSshResult> {
      const claim = customerSshClaim(input);
      const submission: { phase: 'prepared' | 'submitted' } = { phase: 'prepared' };
      try {
        return await tooling.inWorkspace({
          signal: input.signal,
          work: async (directory, run, flags) => {
            input.signal.throwIfAborted();
            const path = join(directory, 'customer-claim.json');
            await writeFile(path, JSON.stringify({ agentCloudAccess: claim }), {
              flag: 'wx',
              mode: 0o600,
            });
            const token = z
              .string()
              .max(16 * 1024)
              .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
              .parse(
                (
                  await run([
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
                ).trim(),
              );
            input.signal.throwIfAborted();
            const response = await submitCertificate({
              caUrl: tooling.caUrl,
              root: tooling.root.toString(),
              token,
              claim,
              signal: input.signal,
              onSubmit: () => {
                submission.phase = 'submitted';
              },
            });
            if (response.kind === 'rejected') return response;
            const parsed = z
              .strictObject({
                crt: z
                  .string()
                  .min(1)
                  .max(16300)
                  .regex(/^[A-Za-z0-9+/]+={0,2}$/),
              })
              .parse(response.value);
            const certificate = `ssh-ed25519-cert-v01@openssh.com ${parsed.crt}`;
            const certificatePath = join(directory, 'customer-cert.pub');
            await writeFile(certificatePath, certificate + '\n', { flag: 'wx', mode: 0o600 });
            const validity = inspectCustomerSsh(
              JSON.parse(await run(['ssh', 'inspect', certificatePath, '--format', 'json'])),
              { claim, userCa: tooling.userCa },
            );
            return { kind: 'issued', certificate, ...validity };
          },
        });
      } catch {
        // The session receipt owns uncertainty. This invocation never retries token or CA work.
        return { kind: submission.phase === 'submitted' ? 'unknown' : 'failed' };
      }
    },
  };
}
export type CustomerSshSigner = ReturnType<typeof createCustomerSshSigner>;

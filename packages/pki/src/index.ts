import { execFile } from 'node:child_process';
import { createPublicKey, X509Certificate } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  guestSubjectSchema,
  guestSubjectKey,
  CloudError,
  guestEnrollmentInputSchema,
} from '@agent-cloud/contracts';
import type { GuestSubject } from '@agent-cloud/contracts';
import { inspectIssuedSsh } from './ssh-certificate.js';
import { createStepTooling, type SignerConfiguration } from './step-tooling.js';
export type { SignerConfiguration } from './step-tooling.js';
export {
  createCustomerSshSigner,
  type CustomerSshSigner,
  type CustomerSshResult,
} from './customer-ssh.js';
import { inspectIssuedTls } from './tls-certificate.js';

export async function readCsrKey(
  run: (args: string[]) => Promise<string>,
  request: string,
  name: string,
) {
  const details = z
    .object({
      Subject: z.strictObject({ common_name: z.tuple([z.literal(name)]) }),
      DNSNames: z.tuple([z.literal(name)]),
      EmailAddresses: z.array(z.never()).nullish(),
      IPAddresses: z.array(z.never()).nullish(),
      URIs: z.array(z.never()).nullish(),
      Extensions: z.array(z.object({ id: z.literal('2.5.29.17') })).max(1),
      PublicKeyAlgorithm: z.object({ name: z.literal('ECDSA') }),
      RawSubjectPublicKeyInfo: z.string(),
    })
    .safeParse(JSON.parse(await run(['certificate', 'inspect', request, '--format', 'json'])));
  if (!details.success)
    throw new CloudError(
      'invalid_input',
      'Guest CSR must request only its guest identity name with an ECDSA key.',
    );
  const key = createPublicKey({
    key: Buffer.from(details.data.RawSubjectPublicKeyInfo, 'base64'),
    format: 'der',
    type: 'spki',
  });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
    throw new CloudError('invalid_input', 'Guest TLS keys must use ECDSA P-256.');
  return key;
}

export function guestName(subject: GuestSubject): string {
  return `${guestSubjectKey(subject).replace('_', '-')}.guest.agent-cloud.internal`;
}
export function probePrincipal(subject: GuestSubject): string {
  return `probe-${guestSubjectKey(subject)}`;
}
export function runtimePrincipal(subject: GuestSubject): string {
  return `runtime-${guestSubjectKey(subject)}`;
}

export function hostingPrincipal(subject: GuestSubject): string {
  return `hosting-${guestSubjectKey(subject)}`;
}

export function deploymentPrincipal(subject: GuestSubject): string {
  return `deployment-${guestSubjectKey(subject)}`;
}

export interface ProbeCredential<
  K extends 'probe' | 'runtime' | 'deployment' | 'hosting' = 'probe',
> {
  kind: K;
  subject: GuestSubject;
  privateKey: string;
  certificate: string;
  expiresAt: string;
}
export function createSigner(configuration: SignerConfiguration) {
  const { root, hostCa, userCa, inWorkspace } = createStepTooling(configuration);
  const keygen = resolve(configuration.keygenBinary ?? '/usr/bin/ssh-keygen');

  async function signSsh(input: {
    subject: GuestSubject;
    publicKey: string;
    kind: 'host' | 'probe' | 'runtime' | 'deployment' | 'hosting';
  }) {
    const key = guestEnrollmentInputSchema.shape.sshHostPublicKey.parse(input.publicKey);
    const principal =
      input.kind === 'hosting'
        ? hostingPrincipal(input.subject)
        : input.kind === 'host'
          ? guestName(input.subject)
          : input.kind === 'deployment'
            ? deploymentPrincipal(input.subject)
            : input.kind === 'runtime'
              ? runtimePrincipal(input.subject)
              : probePrincipal(input.subject);
    return inWorkspace({
      work: async (directory, run, flags) => {
        const keyPath = join(directory, 'identity.pub');
        await writeFile(keyPath, key + '\n', { flag: 'wx', mode: 0o600 });
        const startedAt = Date.now();
        await run([
          'ssh',
          'certificate',
          principal,
          keyPath,
          '--sign',
          '--no-agent',
          '--principal',
          principal,
          '--not-after',
          input.kind === 'host' ? '1h' : '5m',
          ...(input.kind === 'host' ? ['--host'] : []),
          ...flags,
        ]);
        const output = join(directory, 'identity-cert.pub');
        const certificate = z
          .string()
          .max(16384)
          .regex(/^ssh-ed25519-cert-v01@openssh.com [A-Za-z0-9+/]+={0,2}(?: [^\r\n]+)?$/)
          .parse((await readFile(output, 'utf8')).trim());
        const validity = inspectIssuedSsh(
          JSON.parse(await run(['ssh', 'inspect', output, '--format', 'json'])),
          {
            kind: input.kind,
            key,
            ca: input.kind === 'host' ? hostCa : userCa,
            principal,
            timing: { kind: 'signing', startedAt },
          },
        );
        return { certificate, ...validity };
      },
    });
  }

  async function validateTlsRequest(input: { subject: GuestSubject; csr: string }): Promise<void> {
    const name = guestName(input.subject);
    const csr = guestEnrollmentInputSchema.shape.tlsCsr.parse(input.csr);
    await inWorkspace({
      work: async (directory, run) => {
        const request = join(directory, 'guest.csr');
        await writeFile(request, csr, { flag: 'wx', mode: 0o600 });
        await readCsrKey(run, request, name);
      },
    });
  }

  async function signTls(input: { subject: GuestSubject; csr: string }) {
    const name = guestName(input.subject);
    const csr = guestEnrollmentInputSchema.shape.tlsCsr.parse(input.csr);
    return inWorkspace({
      work: async (directory, run, flags) => {
        const request = join(directory, 'guest.csr');
        await writeFile(request, csr, { flag: 'wx', mode: 0o600 });
        const key = await readCsrKey(run, request, name);
        const output = join(directory, 'guest.crt');
        const startedAt = Date.now();
        await run(['ca', 'sign', request, output, '--not-after', '1h', ...flags]);
        await run([
          'certificate',
          'verify',
          output,
          '--roots',
          join(directory, 'root.crt'),
          '--host',
          name,
        ]);
        const chain = await readFile(output, 'utf8');
        const leaf = new X509Certificate(chain);
        inspectIssuedTls(leaf, { name, key, timing: { kind: 'signing', startedAt } });
        return chain;
      },
    });
  }
  async function issueCredential<K extends 'probe' | 'runtime' | 'deployment' | 'hosting'>(
    value: GuestSubject,
    kind: K,
  ): Promise<ProbeCredential<K>> {
    const subject = guestSubjectSchema.parse(value);
    return inWorkspace({
      work: async (directory) => {
        const path = join(directory, 'probe');
        try {
          await promisify(execFile)(keygen, ['-t', 'ed25519', '-N', '', '-C', '', '-f', path], {
            env: { PATH: '/usr/bin:/bin', LANG: 'C' },
            timeout: 5000,
            killSignal: 'SIGKILL',
            maxBuffer: 4096,
          });
        } catch {
          throw new CloudError('provider_unavailable', 'Probe key generation failed.', true);
        }
        const signed = await signSsh({
          kind,
          subject,
          publicKey: (await readFile(path + '.pub', 'utf8')).trim(),
        });
        return { kind, subject, privateKey: await readFile(path, 'utf8'), ...signed };
      },
    });
  }
  return Object.freeze({
    trust: Object.freeze({ tlsRoot: root.toString(), sshHostCa: hostCa, sshUserCa: userCa }),
    signHost: async (input: { subject: GuestSubject; publicKey: string }) =>
      (await signSsh({ ...input, kind: 'host' })).certificate,
    issueProbeCredential: (subject: GuestSubject) => issueCredential(subject, 'probe'),
    issueRuntimeCredential: (subject: GuestSubject) => issueCredential(subject, 'runtime'),
    issueHostingCredential: (subject: GuestSubject) => issueCredential(subject, 'hosting'),
    issueDeploymentCredential: (subject: GuestSubject) => issueCredential(subject, 'deployment'),
    validateTlsRequest,
    signTls,
  });
}
export type Signer = ReturnType<typeof createSigner>;

export { inspectIssuedSsh } from './ssh-certificate.js';
export { inspectIssuedTls } from './tls-certificate.js';
export { signGuestRenewal, verifyGuestRenewal } from './guest-renewal.js';
export {
  gatewayTlsName,
  generateGatewayTlsKey,
  inspectGatewayTls,
  issueGatewayTls,
  validateGatewayTls,
  renewGatewayTls,
  type GatewayTlsConfiguration,
  type GatewayTlsIdentity,
} from './gateway-tls.js';

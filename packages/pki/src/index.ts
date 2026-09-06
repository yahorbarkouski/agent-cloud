import { execFile } from 'node:child_process';
import { createPublicKey, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  allocationIdSchema,
  CloudError,
  guestEnrollmentInputSchema,
  guestImageSchema,
} from '@agent-cloud/contracts';
import type { AllocationId } from '@agent-cloud/contracts';
import { inspectIssuedSsh } from './ssh-certificate.js';
import { inspectIssuedTls } from './tls-certificate.js';

async function readCsrKey(run: (args: string[]) => Promise<string>, request: string, name: string) {
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
      'Guest CSR must request only its allocation name with an ECDSA key.',
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

export function guestName(allocationId: AllocationId): string {
  return `${allocationIdSchema.parse(allocationId).replace('alloc_', 'alloc-')}.guest.agent-cloud.internal`;
}
export function probePrincipal(allocationId: AllocationId): string {
  return `probe-${allocationIdSchema.parse(allocationId)}`;
}

export interface SignerConfiguration {
  binary: string;
  caUrl: string;
  tlsRoot: string;
  provisioner: string;
  provisionerPassword: string;
  sshHostCa: string;
  sshUserCa: string;
  keygenBinary?: string;
}
export interface ProbeCredential {
  allocationId: AllocationId;
  privateKey: string;
  certificate: string;
  expiresAt: string;
}
export function createSigner(configuration: SignerConfiguration) {
  const binary = resolve(configuration.binary);
  const caUrl = z
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      );
    })
    .parse(configuration.caUrl);
  const root = new X509Certificate(configuration.tlsRoot);
  if (!root.ca) throw new Error('Signing trust must be a CA certificate.');
  const provisioner = z.string().min(1).max(128).parse(configuration.provisioner);
  const password = z.string().min(1).max(16384).parse(configuration.provisionerPassword);
  const hostCa = guestImageSchema.shape.sshHostCa.parse(configuration.sshHostCa);
  const userCa = guestImageSchema.shape.sshUserCa.parse(configuration.sshUserCa);
  const keygen = resolve(configuration.keygenBinary ?? '/usr/bin/ssh-keygen');

  async function inWorkspace<T>(
    action: (
      directory: string,
      run: (args: string[]) => Promise<string>,
      flags: string[],
    ) => Promise<T>,
  ): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), 'agent-cloud-sign-'));
    try {
      const trust = join(directory, 'root.crt');
      const secret = join(directory, 'provisioner-password');
      await writeFile(trust, root.toString(), { flag: 'wx', mode: 0o600 });
      await writeFile(secret, password, { flag: 'wx', mode: 0o600 });
      const flags = [
        '--ca-url',
        caUrl,
        '--root',
        trust,
        '--provisioner',
        provisioner,
        '--provisioner-password-file',
        secret,
      ];
      const run = async (args: string[]) => {
        try {
          const { stdout } = await promisify(execFile)(binary, args, {
            cwd: directory,
            env: { PATH: '/usr/bin:/bin', STEPPATH: directory, LANG: 'C' },
            timeout: 20_000,
            killSignal: 'SIGKILL',
            maxBuffer: 32 * 1024,
          });
          return stdout;
        } catch {
          throw new CloudError('provider_unavailable', 'Certificate tooling failed.', true);
        }
      };
      return await action(directory, run, flags);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async function signSsh(input: {
    allocationId: AllocationId;
    publicKey: string;
    kind: 'host' | 'probe';
  }) {
    const key = guestEnrollmentInputSchema.shape.sshHostPublicKey.parse(input.publicKey);
    const principal =
      input.kind === 'host' ? guestName(input.allocationId) : probePrincipal(input.allocationId);
    return inWorkspace(async (directory, run, flags) => {
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
          startedAt,
        },
      );
      return { certificate, ...validity };
    });
  }

  async function validateTlsRequest(input: {
    allocationId: AllocationId;
    csr: string;
  }): Promise<void> {
    const name = guestName(input.allocationId);
    const csr = guestEnrollmentInputSchema.shape.tlsCsr.parse(input.csr);
    await inWorkspace(async (directory, run) => {
      const request = join(directory, 'guest.csr');
      await writeFile(request, csr, { flag: 'wx', mode: 0o600 });
      await readCsrKey(run, request, name);
    });
  }

  async function signTls(input: { allocationId: AllocationId; csr: string }) {
    const name = guestName(input.allocationId);
    const csr = guestEnrollmentInputSchema.shape.tlsCsr.parse(input.csr);
    return inWorkspace(async (directory, run, flags) => {
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
      inspectIssuedTls(leaf, { name, key, startedAt });
      return chain;
    });
  }
  async function issueProbeCredential(allocationId: AllocationId): Promise<ProbeCredential> {
    allocationIdSchema.parse(allocationId);
    return inWorkspace(async (directory) => {
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
        kind: 'probe',
        allocationId,
        publicKey: (await readFile(path + '.pub', 'utf8')).trim(),
      });
      return { allocationId, privateKey: await readFile(path, 'utf8'), ...signed };
    });
  }
  return Object.freeze({
    trust: Object.freeze({ tlsRoot: root.toString(), sshHostCa: hostCa, sshUserCa: userCa }),
    signHost: async (input: { allocationId: AllocationId; publicKey: string }) =>
      (await signSsh({ ...input, kind: 'host' })).certificate,
    issueProbeCredential,
    validateTlsRequest,
    signTls,
  });
}
export type Signer = ReturnType<typeof createSigner>;

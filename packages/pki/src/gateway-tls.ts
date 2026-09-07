import { execFile } from 'node:child_process';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  X509Certificate,
} from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { CloudError } from '@agent-cloud/contracts';
import { inspectValidity, type CertificateTiming } from './validity.js';

const nameSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.gateway\.agent-cloud\.internal$/);
const keySchema = z.string().max(4096);
const certificateSchema = z.string().min(1).max(32_768);
const configurationSchema = z.object({
  binary: z.string().min(1),
  caUrl: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  }),
  tlsRoot: certificateSchema,
});
export type GatewayTlsConfiguration = z.infer<typeof configurationSchema>;
export interface GatewayTlsIdentity {
  name: string;
  privateKey: string;
  certificate: string;
  issuedAt: string;
}

export const gatewayTlsName = (id: string) =>
  nameSchema.parse(`${id}.gateway.agent-cloud.internal`);
export const generateGatewayTlsKey = () =>
  generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();

function identityKey(value: string) {
  const key = createPrivateKey(keySchema.parse(value));
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
    throw new CloudError('invalid_input', 'Gateway TLS requires an ECDSA P-256 private key.');
  return key;
}

/** Full certificate path verification accompanies this exact leaf-policy check below. */
export function inspectGatewayTls(input: {
  name: string;
  privateKey: string;
  certificate: string;
  timing: CertificateTiming;
}) {
  const name = nameSchema.parse(input.name);
  const key = identityKey(input.privateKey);
  const leaf = new X509Certificate(certificateSchema.parse(input.certificate));
  if (
    leaf.ca ||
    leaf.subject !== `CN=${name}` ||
    leaf.subjectAltName !== `DNS:${name}` ||
    leaf.checkHost(name) !== name ||
    !z.tuple([z.literal('1.3.6.1.5.5.7.3.2')]).safeParse(leaf.keyUsage).success ||
    !leaf.publicKey
      .export({ type: 'spki', format: 'der' })
      .equals(createPublicKey(key).export({ type: 'spki', format: 'der' }))
  )
    throw new CloudError(
      'provider_unavailable',
      'CA returned an incompatible gateway certificate.',
    );
  inspectValidity({
    after: leaf.validFromDate.getTime(),
    before: leaf.validToDate.getTime(),
    maximum: 3_600_000,
    timing: input.timing,
  });
  return { expiresAt: leaf.validToDate.toISOString() };
}

async function workspace<T>(
  value: GatewayTlsConfiguration,
  work: (context: {
    directory: string;
    run: (args: string[]) => Promise<string>;
    flags: string[];
  }) => Promise<T>,
) {
  const config = configurationSchema.parse(value);
  const root = new X509Certificate(config.tlsRoot);
  if (!root.ca) throw new Error('Gateway trust must be a CA certificate.');
  const directory = await mkdtemp(join(tmpdir(), 'agent-cloud-gateway-tls-'));
  try {
    const trust = join(directory, 'root.crt');
    await writeFile(trust, root.toString(), { flag: 'wx', mode: 0o600 });
    const run = async (args: string[]) => {
      try {
        const { stdout } = await promisify(execFile)(resolve(config.binary), args, {
          cwd: directory,
          env: { PATH: '/usr/bin:/bin', STEPPATH: directory, LANG: 'C' },
          timeout: 20_000,
          killSignal: 'SIGKILL',
          maxBuffer: 32_768,
        });
        return stdout;
      } catch {
        throw new CloudError('provider_unavailable', 'Gateway certificate tooling failed.', true);
      }
    };
    return await work({ directory, run, flags: ['--ca-url', config.caUrl, '--root', trust] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function verify(
  context: { directory: string; run: (args: string[]) => Promise<string> },
  path: string,
  input: Parameters<typeof inspectGatewayTls>[0],
) {
  const validity = inspectGatewayTls(input);
  // step verifies the full RFC 5280 path for any EKU; inspectGatewayTls requires clientAuth only.
  await context.run([
    'certificate',
    'verify',
    path,
    '--roots',
    join(context.directory, 'root.crt'),
    '--host',
    input.name,
  ]);
  return validity;
}

/** The caller owns durable key storage and the one-shot issuance attempt. No retry occurs here. */
export async function issueGatewayTls(
  configuration: GatewayTlsConfiguration & { provisioner: string; provisionerPassword: string },
  input: { name: string; privateKey: string },
) {
  const name = nameSchema.parse(input.name);
  identityKey(input.privateKey);
  const provisioner = z.literal('agent-cloud-gateway').parse(configuration.provisioner);
  const password = z.string().min(1).max(16_384).parse(configuration.provisionerPassword);
  return workspace(configuration, async (context) => {
    const { directory, run, flags } = context;
    const key = join(directory, 'gateway.key');
    const csr = join(directory, 'gateway.csr');
    const path = join(directory, 'gateway.crt');
    const secret = join(directory, 'provisioner-password');
    await writeFile(key, input.privateKey, { flag: 'wx', mode: 0o600 });
    await writeFile(secret, password, { flag: 'wx', mode: 0o600 });
    await run(['certificate', 'create', name, csr, '--csr', '--key', key, '--san', name]);
    const startedAt = Date.now();
    await run([
      'ca',
      'sign',
      csr,
      path,
      '--not-after',
      '1h',
      ...flags,
      '--provisioner',
      provisioner,
      '--provisioner-password-file',
      secret,
    ]);
    const certificate = certificateSchema.parse(await readFile(path, 'utf8'));
    const validity = await verify(context, path, {
      ...input,
      certificate,
      timing: { kind: 'signing', startedAt },
    });
    return { certificate, issuedAt: new Date().toISOString(), ...validity };
  });
}

export async function validateGatewayTls(
  configuration: GatewayTlsConfiguration,
  input: GatewayTlsIdentity,
) {
  const issuedAt = Date.parse(z.iso.datetime().parse(input.issuedAt));
  return workspace(configuration, async (context) => {
    const path = join(context.directory, 'gateway.crt');
    await writeFile(path, certificateSchema.parse(input.certificate), { flag: 'wx', mode: 0o600 });
    return verify(context, path, { ...input, timing: { kind: 'installed', issuedAt } });
  });
}

/** Renewal authenticates with the existing client certificate and key, never issuer credentials. */
export async function renewGatewayTls(
  configuration: GatewayTlsConfiguration,
  input: GatewayTlsIdentity,
) {
  const issuedAt = Date.parse(z.iso.datetime().parse(input.issuedAt));
  return workspace(configuration, async (context) => {
    const { directory, run, flags } = context;
    const path = join(directory, 'gateway.crt');
    const key = join(directory, 'gateway.key');
    const output = join(directory, 'renewed.crt');
    await writeFile(path, certificateSchema.parse(input.certificate), { flag: 'wx', mode: 0o600 });
    await verify(context, path, { ...input, timing: { kind: 'installed', issuedAt } });
    await writeFile(key, input.privateKey, { flag: 'wx', mode: 0o600 });
    const startedAt = Date.now();
    await run(['ca', 'renew', path, key, '--out', output, '--mtls=true', ...flags]);
    const certificate = certificateSchema.parse(await readFile(output, 'utf8'));
    const validity = await verify(context, output, {
      ...input,
      certificate,
      timing: { kind: 'signing', startedAt },
    });
    return { certificate, issuedAt: new Date().toISOString(), ...validity };
  });
}

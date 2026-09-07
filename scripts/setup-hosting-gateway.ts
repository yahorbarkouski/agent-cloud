import { createPrivateKey, X509Certificate } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  generateGatewayTlsKey,
  issueGatewayTls,
  validateGatewayTls,
} from '../packages/pki/src/gateway-tls.js';
import { publicGatewayControllerSchema } from '../apps/public-gateway/src/controller.js';
import {
  createGatewayCertificate,
  gatewayCertificateReceiptSchema,
  gatewayDigest,
  gatewayFileMissing,
  prepareGatewayDirectory,
  readGatewayFile,
  writeGatewayFile,
} from '../apps/public-gateway/src/certificate.js';

const setupInputSchema = z.strictObject({
  controller: publicGatewayControllerSchema,
  provisionerPasswordFile: z.string().refine((path) => path === resolve(path)),
  newAttempt: z.uuid().optional(),
});
type SetupOperations = {
  generateKey: typeof generateGatewayTlsKey;
  issue: typeof issueGatewayTls;
  validate: typeof validateGatewayTls;
};
const nativeOperations: SetupOperations = {
  generateKey: generateGatewayTlsKey,
  issue: issueGatewayTls,
  validate: validateGatewayTls,
};

/** Setup owns one-shot issuance; runtime configuration contains no issuer credential. */
export async function setupHostingGateway(
  value: z.input<typeof setupInputSchema>,
  operations: SetupOperations = nativeOperations,
) {
  const { controller, provisionerPasswordFile, newAttempt } = setupInputSchema.parse(value);
  const { gateway, clientIdentity } = controller;
  const configurationFile = join(gateway.stateDirectory, 'controller.json');
  const attemptFile = `${clientIdentity.receiptFile}.attempt-${newAttempt ?? 'initial'}.json`;
  const privatePaths = [
    controller.tokenFile,
    gateway.guestCaFile,
    gateway.clientKeyFile,
    gateway.clientCertificateFile,
    clientIdentity.receiptFile,
    configurationFile,
    attemptFile,
    provisionerPasswordFile,
  ].map((path) => resolve(path));
  if (new Set(privatePaths).size !== privatePaths.length)
    throw new Error('Setup credentials and issuance records require distinct paths.');
  await access(gateway.caddy, constants.X_OK);
  await access(clientIdentity.step, constants.X_OK);
  z.string()
    .regex(/^acld_hosting_[A-Za-z0-9_-]{43}$/)
    .parse(await readGatewayFile(controller.tokenFile));
  const tlsRoot = await readGatewayFile(gateway.guestCaFile, false, 65_536);
  if (!new X509Certificate(tlsRoot).ca) throw new Error('Gateway trust must be a CA certificate.');
  await prepareGatewayDirectory(gateway.stateDirectory);
  const receipt = await readGatewayFile(clientIdentity.receiptFile, true, 65_536).then(
    (value) => gatewayCertificateReceiptSchema.parse(JSON.parse(value)),
    (error: unknown) => {
      if (gatewayFileMissing(error)) return null;
      throw error;
    },
  );
  if (receipt && receipt.name !== clientIdentity.name)
    throw new Error('Gateway certificate receipt belongs to another identity.');
  let key = await readGatewayFile(gateway.clientKeyFile, true, 4096).catch((error: unknown) => {
    if (gatewayFileMissing(error)) return null;
    throw error;
  });
  if (key === null) {
    const attempts = await readdir(dirname(clientIdentity.receiptFile)).catch((error: unknown) => {
      if (gatewayFileMissing(error)) return [];
      throw error;
    });
    if (
      receipt ||
      attempts.some((name) => name.startsWith(`${basename(clientIdentity.receiptFile)}.attempt-`))
    )
      throw new Error('Restore the original gateway private key.');
    // Once created, even a failed or uncertain issuance must preserve this exact key.
    key = operations.generateKey();
    await writeGatewayFile(gateway.clientKeyFile, key, true);
  }
  const parsedKey = createPrivateKey(key);
  if (
    parsedKey.asymmetricKeyType !== 'ec' ||
    parsedKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
  )
    throw new Error('Gateway TLS requires an ECDSA P-256 private key.');
  const expired = receipt !== null && Date.parse(receipt.expiresAt) <= Date.now() + 30_000;
  if (expired && !newAttempt)
    throw new Error(
      'Gateway certificate has expired. Supply --new-attempt with a fresh UUID to issue a replacement using the original key.',
    );
  if (!receipt || expired) {
    const provisionerPassword = await readGatewayFile(provisionerPasswordFile);
    try {
      await writeGatewayFile(
        attemptFile,
        JSON.stringify({
          name: clientIdentity.name,
          keyDigest: gatewayDigest(key.trim()),
          startedAt: new Date().toISOString(),
        }) + '\n',
        true,
      );
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
        throw new Error(
          'Initial gateway issuance is uncertain. Supply --new-attempt with a new UUID to authorize another attempt using the original key.',
          { cause: error },
        );
      throw error;
    }
    const signed = await operations.issue(
      {
        binary: clientIdentity.step,
        caUrl: clientIdentity.caUrl,
        tlsRoot,
        provisioner: 'agent-cloud-gateway',
        provisionerPassword,
      },
      { name: clientIdentity.name, privateKey: key },
    );
    const accepted = gatewayCertificateReceiptSchema.parse({
      name: clientIdentity.name,
      ...signed,
    });
    const validity = await operations.validate(
      { binary: clientIdentity.step, caUrl: clientIdentity.caUrl, tlsRoot },
      { ...accepted, privateKey: key },
    );
    if (validity.expiresAt !== accepted.expiresAt)
      throw new Error('Gateway receipt expiry disagrees with its certificate.');
    await writeGatewayFile(clientIdentity.receiptFile, JSON.stringify(accepted) + '\n');
  }
  const identity = createGatewayCertificate(controller, {
    validate: operations.validate,
    renew: () => Promise.reject(new Error('Setup never renews or retries certificate issuance.')),
    now: Date.now,
  });
  const installed = await identity.restore();
  await writeGatewayFile(configurationFile, JSON.stringify(controller, null, 2) + '\n');
  return { configurationFile, name: clientIdentity.name, expiresAt: installed.expiresAt };
}

export async function setupHostingGatewayCommand(args: string[]) {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      'provisioner-password-file': { type: 'string' },
      'new-attempt': { type: 'string' },
    },
  });
  const [input, ...extra] = parsed.positionals;
  const password = parsed.values['provisioner-password-file'];
  if (!input || extra.length || !password)
    throw new Error(
      'Supply one private runtime configuration file and --provisioner-password-file; --new-attempt requires a fresh UUID after uncertain issuance.',
    );
  return setupHostingGateway({
    controller: publicGatewayControllerSchema.parse(
      JSON.parse(await readGatewayFile(resolve(input))),
    ),
    provisionerPasswordFile: resolve(password),
    ...(parsed.values['new-attempt'] ? { newAttempt: parsed.values['new-attempt'] } : {}),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(
      JSON.stringify(await setupHostingGatewayCommand(process.argv.slice(2))) + '\n',
    );
  } catch {
    process.stderr.write(
      JSON.stringify({
        error:
          'Gateway setup failed. Check the private configuration and preserved receipt/key. An uncertain issuance requires --new-attempt <fresh UUID>; never remove the original key or attempt records.',
      }) + '\n',
    );
    process.exitCode = 1;
  }
}

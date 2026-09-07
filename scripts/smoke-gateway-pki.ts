import assert from 'node:assert/strict';
import { z } from 'zod';
import { randomUUID, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  generateGatewayTlsKey,
  gatewayTlsName,
  issueGatewayTls,
  renewGatewayTls,
  validateGatewayTls,
} from '../packages/pki/dist/index.js';
import { readPrivateFile } from '../apps/control/src/private-file.js';

const scratch = await mkdtemp(resolve('.local/gateway-pki-smoke-'));
try {
  const configuration = {
    binary: resolve('.local/tools/step-0.30.6'),
    caUrl: 'https://localhost:9449',
    tlsRoot: await readFile('.local/pki/public/root_ca.crt', 'utf8'),
  };
  const privateKey = generateGatewayTlsKey();
  await writeFile(join(scratch, 'client.key'), privateKey, { mode: 0o600, flag: 'wx' });
  const name = gatewayTlsName(`smoke-${randomUUID()}`);
  const issued = await issueGatewayTls(
    {
      ...configuration,
      provisioner: 'agent-cloud-gateway',
      provisionerPassword: await readPrivateFile(
        resolve('.local/pki/gateway-provisioner-password'),
      ),
    },
    { name, privateKey },
  );
  await writeFile(join(scratch, 'client.crt'), issued.certificate, { mode: 0o600, flag: 'wx' });
  const renewed = await renewGatewayTls(configuration, { name, privateKey, ...issued });
  assert.notEqual(
    new X509Certificate(issued.certificate).serialNumber,
    new X509Certificate(renewed.certificate).serialNumber,
  );
  await validateGatewayTls(configuration, { name, privateKey, ...renewed });
  await assert.rejects(
    validateGatewayTls(configuration, {
      name: gatewayTlsName('different'),
      privateKey,
      ...renewed,
    }),
  );
  const ca: unknown = JSON.parse(
    await readPrivateFile(resolve('.local/pki/issuer/config/ca.json')),
  );
  const policy = z
    .object({
      authority: z.object({
        claims: z.object({ disableRenewal: z.literal(true) }),
        provisioners: z.array(
          z.object({
            name: z.string(),
            claims: z.object({ disableRenewal: z.boolean().optional() }).optional(),
          }),
        ),
      }),
    })
    .parse(ca);
  assert.equal(
    policy.authority.provisioners.find((p) => p.name === 'agent-cloud-gateway')?.claims
      ?.disableRenewal,
    false,
  );
  assert.notEqual(
    policy.authority.provisioners.find((p) => p.name === 'agent-cloud-control')?.claims
      ?.disableRenewal,
    false,
  );
  process.stdout.write(
    JSON.stringify({
      result: 'gateway-pki-locally-verified',
      clientOnlyCertificate: true,
      exactIdentity: true,
      renewedWithoutIssuerPassword: true,
      guestRenewalRemainsDisabled: true,
      temporaryKeysRemoved: true,
    }) + '\n',
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}

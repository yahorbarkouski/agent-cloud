import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { apiUrlSchema, hostingSnapshotSchema } from '@agent-cloud/contracts';
import { createPublicGateway, publicGatewayConfigurationSchema } from './index.js';
import {
  createGatewayCertificate,
  gatewayClientIdentitySchema,
  gatewayFileMissing,
  readGatewayFile,
} from './certificate.js';

export const publicGatewayControllerSchema = z
  .strictObject({
    apiUrl: apiUrlSchema,
    tokenFile: z.string().refine(isAbsolute),
    gateway: publicGatewayConfigurationSchema,
    clientIdentity: gatewayClientIdentitySchema,
  })
  .superRefine((value, context) => {
    const paths = [
      value.tokenFile,
      value.gateway.guestCaFile,
      value.gateway.clientCertificateFile,
      value.gateway.clientKeyFile,
      value.clientIdentity.receiptFile,
      `${value.clientIdentity.receiptFile}.renewal.json`,
      join(value.gateway.stateDirectory, 'controller.json'),
      join(value.gateway.stateDirectory, 'last-good.json'),
      join(value.gateway.stateDirectory, 'candidate.json'),
    ].map((path) => resolve(path));
    if (new Set(paths).size !== paths.length)
      context.addIssue({
        code: 'custom',
        message: 'Gateway credentials, receipts and runtime files require distinct paths.',
      });
  });
export const readGatewaySecret = (path: string) => readGatewayFile(path);
async function readReply(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error('Hosting API response is unavailable.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 1_048_576) throw new Error('Hosting API response exceeds its limit.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function createPublicGatewayController(
  value: z.input<typeof publicGatewayControllerSchema>,
  dependencies?: {
    gateway?: ReturnType<typeof createPublicGateway>;
    certificate?: ReturnType<typeof createGatewayCertificate>;
    fetch?: typeof fetch;
  },
) {
  const config = publicGatewayControllerSchema.parse(value);
  const gateway = dependencies?.gateway ?? createPublicGateway(config.gateway);
  const certificate = dependencies?.certificate ?? createGatewayCertificate(config);
  const request = dependencies?.fetch ?? fetch;
  let renewalFailureReported = false;
  async function synchronize() {
    const renewal = await certificate.refresh();
    if (renewal.renewal === 'unavailable' && !renewalFailureReported)
      process.stderr.write(
        JSON.stringify({
          event: 'hosting_gateway.renewal_unavailable',
          expiresAt: renewal.expiresAt,
        }) + '\n',
      );
    renewalFailureReported = renewal.renewal === 'unavailable';
    // Reapply durable routes before requesting fresh authority so TLS rotation survives API outages.
    const retained = await readGatewayFile(
      join(config.gateway.stateDirectory, 'last-good.json'),
      true,
      2 * 1024 * 1024,
    ).then(
      (value) => z.object({ snapshot: hostingSnapshotSchema }).parse(JSON.parse(value)).snapshot,
      (error: unknown) => {
        if (gatewayFileMissing(error)) return null;
        throw error;
      },
    );
    if (retained) await gateway.apply(retained);
    const token = z
      .string()
      .regex(/^acld_hosting_[A-Za-z0-9_-]{43}$/)
      .parse(await readGatewaySecret(config.tokenFile));
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    const origin = config.apiUrl.replace(/\/$/, '');
    const snapshot = hostingSnapshotSchema.parse(
      await readReply(
        await request(`${origin}/hosting/v1/snapshot`, {
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        }),
      ),
    );
    const state = await gateway.apply(snapshot);
    if (!state.active || state.revision !== snapshot.revision)
      throw new Error('Gateway did not confirm the desired route configuration.');
    const reply = await readReply(
      await request(`${origin}/hosting/v1/ack`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ revision: snapshot.revision }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      }),
    );
    z.object({ revision: z.literal(snapshot.revision), appliedAt: z.iso.datetime() }).parse(reply);
    return state;
  }
  async function run(signal: AbortSignal) {
    await certificate.refresh();
    await gateway.start();
    let failureReported = false;
    try {
      while (!signal.aborted) {
        try {
          await synchronize();
          if (failureReported)
            process.stdout.write(JSON.stringify({ event: 'hosting_gateway.recovered' }) + '\n');
          failureReported = false;
        } catch {
          if (!failureReported)
            process.stderr.write(
              JSON.stringify({
                event: 'hosting_gateway.sync_unavailable',
                retainedConfiguration: true,
              }) + '\n',
            );
          failureReported = true;
        }
        try {
          await setTimeout(failureReported ? 5000 : 2000, undefined, { signal });
        } catch {
          break;
        }
      }
    } finally {
      await gateway.stop();
    }
  }
  return { gateway, synchronize, run };
}

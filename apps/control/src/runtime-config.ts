import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { imageBuildLimitsSchema, imageBuildIdSchema } from '@agent-cloud/contracts';
import { readPrivateFile } from './private-file.js';

const absolutePath = z.string().min(1).refine(isAbsolute, 'Use an absolute path.');
const httpsEndpoint = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
});

const pkiSchema = z.strictObject({
  binary: absolutePath,
  caUrl: httpsEndpoint,
  tlsRootFile: absolutePath,
  sshHostCaFile: absolutePath,
  sshUserCaFile: absolutePath,
  provisioner: z.string().min(1).max(256),
  provisionerPasswordFile: absolutePath,
});
const common = { version: z.literal(1), identityDirectory: absolutePath, pki: pkiSchema };

/** Separate processes own image work and customer work. Neither mode starts capacity at startup. */
export const imageRuntimeConfigSchema = z.strictObject({
  ...common,
  mode: z.literal('image_factory'),
  images: z.strictObject({
    inputsDirectory: absolutePath,
    accessDirectory: absolutePath,
    limits: imageBuildLimitsSchema,
  }),
});
export const customerRuntimeConfigSchema = z.strictObject({
  ...common,
  mode: z.literal('customer'),
  releaseBuildId: imageBuildIdSchema,
  firewallIds: z
    .array(z.int().positive())
    .min(1)
    .max(5)
    .refine((ids) => new Set(ids).size === ids.length),
});
export const runtimeConfigSchema = z.discriminatedUnion('mode', [
  imageRuntimeConfigSchema,
  customerRuntimeConfigSchema,
]);
export type ImageRuntimeConfig = z.infer<typeof imageRuntimeConfigSchema>;
export type CustomerRuntimeConfig = z.infer<typeof customerRuntimeConfigSchema>;
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

export async function readRuntimeConfig(path: string): Promise<RuntimeConfig> {
  try {
    const value: unknown = JSON.parse(await readPrivateFile(path));
    return runtimeConfigSchema.parse(value);
  } catch {
    throw new Error('Runtime configuration must be a valid owner-only runtime file.');
  }
}

function publicOrigin(publicUrl: string) {
  const url = new URL(httpsEndpoint.parse(publicUrl));
  if (url.pathname !== '/') throw new Error('PUBLIC_URL must be an HTTPS origin without a path.');
  return url;
}

export function imageEnrollmentUrl(publicUrl: string) {
  return new URL('/image/enroll', publicOrigin(publicUrl)).href;
}
export function guestEnrollmentUrl(publicUrl: string) {
  return new URL('/guest/enroll', publicOrigin(publicUrl)).href;
}

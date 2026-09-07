import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { imageBuildLimitsSchema } from '@agent-cloud/contracts';
import { readPrivateFile } from './private-file.js';

const absolutePath = z.string().min(1).refine(isAbsolute, 'Use an absolute path.');
const httpsEndpoint = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
});

/** Image factory startup cannot admit or execute customer operations. */
export const runtimeConfigSchema = z.strictObject({
  version: z.literal(1),
  mode: z.literal('image_factory'),
  identityDirectory: absolutePath,
  images: z.strictObject({
    inputsDirectory: absolutePath,
    accessDirectory: absolutePath,
    limits: imageBuildLimitsSchema,
  }),
  pki: z.strictObject({
    binary: absolutePath,
    caUrl: httpsEndpoint,
    tlsRootFile: absolutePath,
    sshHostCaFile: absolutePath,
    sshUserCaFile: absolutePath,
    provisioner: z.string().min(1).max(256),
    provisionerPasswordFile: absolutePath,
  }),
});
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

export async function readRuntimeConfig(path: string): Promise<RuntimeConfig> {
  try {
    const value: unknown = JSON.parse(await readPrivateFile(path));
    return runtimeConfigSchema.parse(value);
  } catch {
    throw new Error('Runtime configuration must be a valid owner-only image factory file.');
  }
}

export function imageEnrollmentUrl(publicUrl: string) {
  const url = new URL(httpsEndpoint.parse(publicUrl));
  if (url.pathname !== '/') throw new Error('PUBLIC_URL must be an HTTPS origin without a path.');
  return new URL('/image/enroll', url).href;
}

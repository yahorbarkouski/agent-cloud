import { z } from 'zod';

export const imageDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const imageInputPathSchema = z
  .string()
  .max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._~+-]*(\/[A-Za-z0-9][A-Za-z0-9._~+-]*)*$/);
export const imageInputsSchema = z.strictObject({
  format: z.literal(1),
  files: z
    .array(
      z.strictObject({
        path: imageInputPathSchema,
        sha256: imageDigestSchema,
        bytes: z
          .int()
          .positive()
          .max(128 * 1024 * 1024),
      }),
    )
    .min(1)
    .max(64)
    .refine(
      (files) =>
        files.every((file, index) => {
          const previous = files[index - 1];
          return index === 0 || (previous !== undefined && previous.path < file.path);
        }),
      'Image inputs must be unique and sorted by ASCII path.',
    )
    .refine(
      (files) =>
        files.every(
          (file) => !['image.json', 'image-inputs.json', 'SHA256SUMS'].includes(file.path),
        ),
      'Derived image metadata cannot be its own input.',
    ),
});
export type ImageInputs = z.infer<typeof imageInputsSchema>;

const artifact = z.strictObject({
  version: z.string().min(1).max(128),
  file: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._~+-]*$/),
  url: z.url().refine((value) => new URL(value).protocol === 'https:'),
  sha256: imageDigestSchema,
});
export const imageArtifactsSchema = z.strictObject({
  architecture: z.literal('x86'),
  node: artifact,
  step: artifact,
  caddy: artifact,
  dockerVersion: z.string().min(1),
  composeVersion: z.string().min(1),
  debs: z
    .array(artifact.extend({ name: z.string().min(1) }))
    .min(1)
    .max(32),
});
export type ImageArtifacts = z.infer<typeof imageArtifactsSchema>;

export const enrollmentImageSourcePaths = [
  'install.sh',
  'sshd_config',
  'guest-inspect.sudoers',
  'systemd/agent-cloud-enroll.service',
  'systemd/agent-cloud-proxy.service',
];

export const imageSourcePaths = [
  ...enrollmentImageSourcePaths,
  'systemd/agent-cloud-renew.service',
  'systemd/agent-cloud-renew.timer',
];

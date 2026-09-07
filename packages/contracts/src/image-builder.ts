import { z } from 'zod';
import {
  imageBuildIdSchema,
  imageProviderIdSchema,
  imageSanitationReceiptSchema,
} from './image-build.js';
import { imageDigestSchema } from './image-inputs.js';

export const imageBuilderBootSchema = z.strictObject({
  version: z.literal(1),
  buildId: imageBuildIdSchema,
  effectId: z.uuid(),
  manifestDigest: imageDigestSchema,
});
export type ImageBuilderBoot = z.infer<typeof imageBuilderBootSchema>;
// The installer records additional sanitation metadata; the controller consumes these fields.
export const imageInstallReceiptSchema = z.object({
  kind: z.literal('builder'),
  builderId: imageBuildIdSchema,
  manifestDigest: imageDigestSchema,
  machineId: z.string().regex(/^[0-9a-f]{32}$/),
});
export const imageInstallationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('not_started') }),
  z.strictObject({ kind: z.literal('started') }),
  z.strictObject({ kind: z.literal('installed'), receipt: imageInstallReceiptSchema }),
]);
export type ImageInstallation = z.infer<typeof imageInstallationSchema>;

export const imageBuilderProgressSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('installing') }),
  z.strictObject({ kind: z.literal('installed'), installation: imageInstallReceiptSchema }),
  z.strictObject({ kind: z.literal('sanitizing'), installation: imageInstallReceiptSchema }),
  z.strictObject({
    kind: z.literal('sanitized'),
    installation: imageInstallReceiptSchema,
    sanitation: imageSanitationReceiptSchema,
  }),
]);
export type ImageBuilderProgress = z.infer<typeof imageBuilderProgressSchema>;
export const imageBuilderWorkSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('waiting') }),
  z.strictObject({
    kind: z.literal('recorded'),
    serverId: imageProviderIdSchema,
    effectId: z.uuid(),
    progress: imageBuilderProgressSchema,
    createdAt: z.iso.datetime(),
  }),
]);

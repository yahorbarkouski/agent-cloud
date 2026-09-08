import { z } from 'zod';
import { composeReleaseIdSchema } from './compose.js';

export const recipeIdSchema = z.enum(['postgres', 'umami']);
export const recipeVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
export const recipeSchema = z.strictObject({
  id: recipeIdSchema,
  version: recipeVersionSchema,
  description: z.string(),
  architectures: z.array(z.enum(['amd64', 'arm64'])),
  services: z.array(
    z.strictObject({
      name: z.string(),
      image: z.string().regex(/@sha256:[a-f0-9]{64}$/),
      memoryBytes: z.int().positive(),
      cpus: z.number().positive(),
      pids: z.int().positive(),
    }),
  ),
  loopbackPort: z.int().min(1024).max(65535).nullable(),
  secrets: z.array(z.string()),
  backup: z.strictObject({
    kind: z.literal('postgres-17'),
    service: z.literal('database'),
    database: z.string(),
    user: z.string(),
    requiresOperatorStorage: z.literal(true),
    scope: z.literal('selected-database-and-compose-source'),
    pointInTimeRecovery: z.literal(false),
  }),
  instructions: z.array(z.string()),
});
export type Recipe = z.infer<typeof recipeSchema>;
export const recipesResponseSchema = z.strictObject({ recipes: z.array(recipeSchema) });
export const recipeResponseSchema = z.strictObject({ recipe: recipeSchema });
export const recipePrepareSchema = z
  .strictObject({
    id: recipeIdSchema,
    version: recipeVersionSchema,
    output: z.string().min(1),
    port: z.int().min(1024).max(65535).optional(),
  })
  .refine((value) => value.id === 'umami' || value.port === undefined, {
    message: 'Only Umami accepts a loopback port.',
  });
export const preparedRecipeSchema = z.strictObject({
  recipe: recipeIdSchema,
  version: recipeVersionSchema,
  source: z.string(),
  releaseId: composeReleaseIdSchema,
  prepared: z.literal(true),
});

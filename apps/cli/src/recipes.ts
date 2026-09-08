import { z } from 'zod';
import type { Command } from 'commander';
import { recipeIdSchema, recipeVersionSchema } from '@agent-cloud/contracts';
import { recipes, findRecipe, prepareRecipe } from '@agent-cloud/recipes';

export function registerRecipes(input: { program: Command; output: (value: unknown) => void }) {
  const command = input.program
    .command('recipe')
    .description(
      'Discover bundled versions and prepare private Compose contexts locally. No credentials required.',
    );
  command.command('list').action(() => {
    input.output({ recipes });
  });
  command
    .command('inspect <id>')
    .option('--version <version>', 'Inspect this exact bundled version')
    .action((id: string, raw: unknown) => {
      const { version } = z.object({ version: recipeVersionSchema.optional() }).parse(raw);
      input.output({ recipe: findRecipe(recipeIdSchema.parse(id), version) });
    });
  command
    .command('prepare <id>')
    .requiredOption('--version <version>', 'Explicit version from recipe list')
    .requiredOption('--output <directory>', 'New private deployment context; never overwritten')
    .option('--port <port>', 'Umami loopback port, default 3000')
    .action(async (id: string, raw: unknown) => {
      const options = z
        .object({
          version: recipeVersionSchema,
          output: z.string(),
          port: z.coerce.number().int().optional(),
        })
        .parse(raw);
      input.output(await prepareRecipe({ id, ...options }));
    });
}

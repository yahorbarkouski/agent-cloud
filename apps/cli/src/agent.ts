import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import { z } from 'zod';
import { CloudError } from '@agent-cloud/contracts';

async function instructions() {
  const metadata: unknown = JSON.parse(
    await readFile(new URL(import.meta.resolve('@agent-cloud/skills/metadata')), 'utf8'),
  );
  const { version } = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) }).parse(metadata);
  const markdown = await readFile(
    new URL(import.meta.resolve('@agent-cloud/skills/agent-cloud')),
    'utf8',
  );
  return {
    name: 'agent-cloud',
    version,
    sha256: createHash('sha256').update(markdown).digest('hex'),
    markdown,
  };
}

export function registerAgent(input: { program: Command; output: (value: unknown) => void }) {
  const agent = input.program
    .command('agent')
    .description('Bundled agent instructions; works offline without credentials.');
  agent
    .command('instructions')
    .description('Print the bundled skill as JSON, including its version and digest.')
    .action(async () => {
      input.output(await instructions());
    });
  agent
    .command('install')
    .description('Write the bundled skill into a new directory; never overwrite an existing skill.')
    .requiredOption(
      '--directory <directory>',
      'New skill directory inside your chosen agent configuration',
    )
    .action(async (raw: unknown) => {
      const { directory } = z.object({ directory: z.string().min(1) }).parse(raw);
      const target = resolve(directory);
      const skill = await instructions();
      try {
        await mkdir(target, { mode: 0o700 });
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
          throw new CloudError(
            'invalid_input',
            'Skill directory already exists; inspect it before choosing a new destination.',
          );
        throw error;
      }
      // Leave a partial directory for inspection on failure. A retry must not overwrite user edits.
      const path = join(target, 'SKILL.md');
      const file = await open(path, 'wx', 0o600);
      try {
        await file.writeFile(skill.markdown);
        await file.sync();
      } finally {
        await file.close();
      }
      for (const directory of [target, dirname(target)]) {
        const savedDirectory = await open(directory, 'r');
        try {
          await savedDirectory.sync();
        } finally {
          await savedDirectory.close();
        }
      }
      input.output({ name: skill.name, version: skill.version, sha256: skill.sha256, path });
    });
}

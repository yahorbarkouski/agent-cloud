import type { Command } from 'commander';
import type { CloudClient } from '@agent-cloud/sdk';
import { z } from 'zod';
import {
  backupCaptureRequestSchema,
  backupIdSchema,
  backupRecipeSchema,
  composeAppSchema,
  machineIdSchema,
  machineSpecSchema,
  restoreIdSchema,
} from '@agent-cloud/contracts';

export function registerBackups(input: {
  program: Command;
  client: () => Promise<CloudClient>;
  output: (value: unknown) => void;
}) {
  const backup = input.program
    .command('backup')
    .description('Capture protected backups and restore them into a new isolated machine.');
  backup
    .command('capture <machine> <app>')
    .description('Capture a consistent PostgreSQL dump and explicitly listed application files.')
    .requiredOption('--id <uuid>', 'Stable backup ID; inspect this ID after a lost response')
    .requiredOption('--release <uuid>', 'Exact deployed Compose release')
    .requiredOption('--service <name>', 'Compose PostgreSQL service')
    .requiredOption('--database <name>', 'PostgreSQL database')
    .requiredOption('--user <name>', 'PostgreSQL user')
    .option('--files <paths...>', 'Explicit regular files beneath the customer directory')
    .action(async (machine: string, app: string, raw: unknown) => {
      const options = z
        .object({
          id: backupIdSchema,
          release: backupRecipeSchema.shape.releaseId,
          service: backupRecipeSchema.shape.service,
          database: backupRecipeSchema.shape.database,
          user: backupRecipeSchema.shape.user,
          files: backupRecipeSchema.shape.files,
        })
        .parse(raw);
      const request = backupCaptureRequestSchema.parse({
        id: options.id,
        recipe: {
          kind: 'compose-postgres',
          app: composeAppSchema.parse(app),
          releaseId: options.release,
          service: options.service,
          database: options.database,
          user: options.user,
          files: options.files,
        },
      });
      input.output(
        await (
          await input.client()
        ).captureBackup({ machineId: machineIdSchema.parse(machine), request }),
      );
    });
  backup.command('list <machine>').action(async (machine: string) => {
    input.output(await (await input.client()).backups(machineIdSchema.parse(machine)));
  });
  backup.command('inspect <id>').action(async (id: string) => {
    input.output(await (await input.client()).backup(backupIdSchema.parse(id)));
  });
  backup
    .command('wait <id>')
    .option('--timeout <seconds>', 'Maximum local wait; capture continues after disconnect', '900')
    .action(async (id: string, raw: unknown) => {
      const options = z.object({ timeout: z.coerce.number().int().min(1).max(3600) }).parse(raw);
      const result = await (
        await input.client()
      ).waitBackup({ backupId: backupIdSchema.parse(id), timeoutMs: options.timeout * 1000 });
      input.output(result);
      if (result.backup.state.kind === 'blocked') process.exitCode = 1;
    });
  backup
    .command('restore <backup> <app>')
    .description('Create a budget-checked isolated machine and restore this backup into it.')
    .requiredOption('--id <uuid>', 'Stable restore ID; inspect this ID after a lost response')
    .requiredOption('--name <name>', 'Name for the new isolated machine')
    .option('--size <size>', 'small, medium, or large', 'small')
    .option('--region <region>', 'nbg1, fsn1, or hel1', 'nbg1')
    .action(async (id: string, app: string, raw: unknown) => {
      const options = z.object({ id: restoreIdSchema, ...machineSpecSchema.shape }).parse(raw);
      input.output(
        await (
          await input.client()
        ).restoreBackup({
          id: options.id,
          backupId: backupIdSchema.parse(id),
          app: composeAppSchema.parse(app),
          machine: { name: options.name, size: options.size, region: options.region },
        }),
      );
    });
  backup.command('restore-inspect <id>').action(async (id: string) => {
    input.output(await (await input.client()).restore(restoreIdSchema.parse(id)));
  });
  backup
    .command('restore-wait <id>')
    .option(
      '--timeout <seconds>',
      'Maximum local wait; the isolated restore continues after disconnect',
      '900',
    )
    .action(async (id: string, raw: unknown) => {
      const options = z.object({ timeout: z.coerce.number().int().min(1).max(3600) }).parse(raw);
      const result = await (
        await input.client()
      ).waitRestore({ restoreId: restoreIdSchema.parse(id), timeoutMs: options.timeout * 1000 });
      input.output(result);
      if (result.restore.state.kind === 'blocked') process.exitCode = 1;
    });
}

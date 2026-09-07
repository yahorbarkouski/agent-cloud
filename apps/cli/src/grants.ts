import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import type { Command } from 'commander';
import { CloudError, grantIdSchema, grantInputSchema } from '@agent-cloud/contracts';
import type { CloudClient } from '@agent-cloud/sdk';

export function registerGrants(input: {
  program: Command;
  client: () => Promise<CloudClient>;
  output: (value: unknown) => void;
}) {
  const grant = input.program
    .command('grant')
    .description('Delegate bounded credentials and revoke access.');
  grant
    .command('list')
    .description('List descendants without secrets, including expired/revoked grants.')
    .option('--after <id>', 'Cursor returned by the previous page')
    .action(async (raw: unknown) => {
      const options = z.object({ after: grantIdSchema.optional() }).parse(raw);
      input.output(await (await input.client()).grants(options.after));
    });
  grant.command('revoke <id>').action(async (id: string) => {
    input.output(await (await input.client()).revokeGrant(grantIdSchema.parse(id)));
  });
  grant
    .command('create <name>')
    .requiredOption(
      '--policy <file>',
      'JSON policy containing explicit capabilities, projects and cost limits',
    )
    .requiredOption('--expires-at <timestamp>', 'UTC expiry no later than your own credential')
    .requiredOption(
      '--credentials <file>',
      'New owner-only credential file; existing files are never overwritten',
    )
    .action(async (name: string, raw: unknown) => {
      const options = z
        .object({ policy: z.string(), expiresAt: z.iso.datetime(), credentials: z.string() })
        .parse(raw);
      const policyText = await readFile(options.policy, 'utf8');
      if (Buffer.byteLength(policyText) > 65_536)
        throw new CloudError('invalid_input', 'Policy exceeds 64 KiB.');
      const policy: unknown = JSON.parse(policyText);
      const request = grantInputSchema.parse({
        name,
        expiresAt: options.expiresAt,
        policy,
      });
      const client = await input.client();
      const path = resolve(options.credentials);
      const createdDirectory = await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      // Reserve the destination before admission. A crash or uncertain response leaves this file
      // in place: list/revoke the grant before deliberately choosing a new destination.
      const file = await open(path, 'wx', 0o600);
      try {
        await file.writeFile(
          JSON.stringify({ pendingGrant: name, server: client.credentials.server }) + '\n',
        );
        await file.sync();
        // Persist the new pathname, plus any directories created for it, before issuing authority.
        const lastDirectory = createdDirectory ? dirname(createdDirectory) : dirname(path);
        for (let directory = dirname(path); ; directory = dirname(directory)) {
          const handle = await open(directory, 'r');
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
          if (directory === lastDirectory) break;
        }
        const { grant } = await client.issueGrant(request).catch((error: unknown) => {
          const failure = error instanceof CloudError ? error.failure : null;
          throw new CloudError(
            failure?.code ?? 'provider_outcome_unknown',
            `${failure?.message ?? 'Grant response was not confirmed.'} Destination retained. Inspect acld grant list and revoke any unwanted grant before retrying.`,
          );
        });
        try {
          const bytes = Buffer.from(
            JSON.stringify({ server: client.credentials.server, token: grant.token }) + '\n',
          );
          await file.truncate(0);
          let offset = 0;
          while (offset < bytes.length) {
            const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, offset);
            if (bytesWritten === 0) throw new Error('Credential write made no progress.');
            offset += bytesWritten;
          }
          await file.sync();
        } catch {
          throw new CloudError(
            'internal_error',
            `Credential ${grant.id} was issued but could not be saved. Revoke it with acld grant revoke ${grant.id}.`,
          );
        }
        input.output({
          grant: { id: grant.id, expiresAt: grant.expiresAt },
          credentialsFile: path,
        });
      } finally {
        await file.close();
      }
    });
}

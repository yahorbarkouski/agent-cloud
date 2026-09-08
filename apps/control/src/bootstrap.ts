import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  credentialsSchema,
  newId,
  accountIdSchema,
  projectIdSchema,
  grantIdSchema,
  capabilitySchema,
  regionSchema,
  sizeSchema,
  grantPolicySchema,
} from '@agent-cloud/contracts';
import { connect, accounts, projects, grants } from '@agent-cloud/db';
import { generateToken, hashToken } from './auth.js';
import { readConfig } from './config.js';
import { openControlFence } from './control-fence.js';

const bootstrapSchema = credentialsSchema.extend({
  accountId: accountIdSchema,
  projectId: projectIdSchema,
  grantId: grantIdSchema,
  expiresAt: z.iso.datetime(),
});

export async function bootstrap() {
  const config = readConfig();
  const directory = resolve('.local');
  const path = resolve(directory, 'admin.credentials.json');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(
      path,
      JSON.stringify(
        {
          server: config.publicUrl,
          token: generateToken(),
          accountId: newId.account(),
          projectId: newId.project(),
          grantId: newId.grant(),
          expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600, flag: 'wx' },
    );
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
  }
  const saved = bootstrapSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  const connection = connect(config.databaseUrl);
  const fence = await openControlFence(connection, config.controlGenerationFile, {
    onLost: () => process.exit(1),
  });
  try {
    await connection.db.transaction(async (tx) => {
      const [existing] = await tx.select().from(grants).where(eq(grants.id, saved.grantId));
      if (existing) {
        if (existing.tokenHash !== hashToken(saved.token))
          throw new Error('Saved credential does not match the database.');
        return;
      }
      await tx
        .insert(accounts)
        .values({ id: saved.accountId, name: 'development', ...config.limits });
      await tx
        .insert(projects)
        .values({ id: saved.projectId, accountId: saved.accountId, name: 'default' });
      await tx.insert(grants).values({
        id: saved.grantId,
        accountId: saved.accountId,
        name: 'bootstrap-admin',
        tokenHash: hashToken(saved.token),
        expiresAt: new Date(saved.expiresAt),
        policy: grantPolicySchema.parse({
          capabilities: capabilitySchema.options,
          projects: { kind: 'all' },
          sizes: sizeSchema.options,
          regions: regionSchema.options,
          ...config.limits,
        }),
      });
    });
    process.stdout.write(
      JSON.stringify({ credentialsFile: path, projectId: saved.projectId, server: saved.server }) +
        '\n',
    );
  } finally {
    await fence?.close();
    await connection.pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await bootstrap();

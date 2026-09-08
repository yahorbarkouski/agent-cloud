import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import process from 'node:process';

// These paths and the User model are verified against the pinned Umami 3.3.1 image.
// Complete migrations and retire the upstream default login before binding HTTP.
const require = createRequire('/app/package.json');
let stage = 'setup password';
try {
  const password = process.env.RECIPE_ADMIN_PASSWORD;
  if (!password || !/^[a-f0-9]{64}$/.test(password)) throw new Error('Missing setup password.');
  const env = { ...process.env, PATH: `/app/node_modules/.bin:${process.env.PATH ?? ''}` };
  for (const script of ['scripts/check-db.js', 'scripts/update-tracker.js']) {
    stage = script === 'scripts/check-db.js' ? 'database migration' : 'tracker configuration';
    const result = spawnSync(process.execPath, [script], {
      cwd: '/app',
      env,
      stdio: 'ignore',
      timeout: 180_000,
      killSignal: 'SIGKILL',
    });
    if (result.status !== 0) throw new Error('Upstream initialization failed.');
  }
  stage = 'administrator initialization';
  const { PrismaPg } = require('@prisma/adapter-pg');
  const { PrismaClient } = await import('/app/generated/prisma/client.js');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    const administrators = await prisma.user.findMany({
      where: { role: 'admin', deletedAt: null },
    });
    if (administrators.length === 0) throw new Error('No administrator is available.');
    // pgcrypto uses bcrypt's 2a prefix; Umami's seed uses 2b. Normalize the prefix
    // only when checking the ASCII default password; preserve every other hash.
    await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await prisma.$executeRaw`
      UPDATE "user" SET password = crypt(${password}, gen_salt('bf', 12))
      WHERE role = 'admin' AND deleted_at IS NULL
      AND replace(password, '$2b$', '$2a$') = crypt('umami', replace(password, '$2b$', '$2a$'))
    `;
  } finally {
    await prisma.$disconnect();
  }
} catch {
  // Upstream/driver diagnostics can include connection strings. Fail before HTTP.
  process.stderr.write(`Umami recipe ${stage} failed; the HTTP server was not started.\n`);
  process.exitCode = 1;
}

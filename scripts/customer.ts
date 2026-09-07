import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { connect, customerIdentities, grants, accounts } from '../packages/db/dist/index.js';
import {
  githubUserIdSchema,
  grantPolicySchema,
  grantIdSchema,
} from '../packages/contracts/dist/index.js';
import {
  admitCustomer,
  disableCustomer,
  renewCustomer,
} from '../apps/control/src/customer-login.js';
import { readPrivateFile } from '../apps/control/src/private-file.js';
import { readConfig } from '../apps/control/src/config.js';

const [command, argument, ...extra] = process.argv.slice(2);
if (!argument || extra.length || !['admit', 'renew', 'inspect', 'disable'].includes(command ?? ''))
  throw new Error(
    'Usage: customer admit|renew <owner-only-request.json> | inspect <github-user-id> | disable <github-user-id>',
  );
const config = readConfig();
const connection = connect(config.databaseUrl);
try {
  if (command === 'admit' || command === 'renew') {
    const common = z.strictObject({
      githubUserId: githubUserIdSchema,
      policy: grantPolicySchema,
      expiresAt: z.iso.datetime(),
    });
    const raw: unknown = JSON.parse(await readPrivateFile(argument));
    const request = common.strip().parse(raw);
    if (
      request.policy.currency !== config.limits.currency ||
      request.policy.maxMachines > config.limits.maxMachines ||
      request.policy.maxHourlyMicros > config.limits.maxHourlyMicros
    )
      throw new Error('Customer policy exceeds configured operator limits.');
    const result =
      command === 'admit'
        ? await admitCustomer(connection.db, {
            ...common.extend({ name: z.string().min(1).max(100) }).parse(raw),
            expiresAt: new Date(request.expiresAt),
          })
        : await renewCustomer(connection.db, {
            ...common.extend({ expectedAnchorGrantId: grantIdSchema }).parse(raw),
            expiresAt: new Date(request.expiresAt),
          });
    process.stdout.write(JSON.stringify(result) + '\n');
  } else if (command === 'disable') {
    process.stdout.write(
      JSON.stringify(await disableCustomer(connection.db, githubUserIdSchema.parse(argument))) +
        '\n',
    );
  } else {
    const [identity] = await connection.db
      .select({
        githubUserId: customerIdentities.githubUserId,
        accountId: customerIdentities.accountId,
        anchorGrantId: customerIdentities.anchorGrantId,
        name: accounts.name,
        policy: grants.policy,
        expiresAt: grants.expiresAt,
        revokedAt: grants.revokedAt,
      })
      .from(customerIdentities)
      .innerJoin(grants, eq(grants.id, customerIdentities.anchorGrantId))
      .innerJoin(accounts, eq(accounts.id, customerIdentities.accountId))
      .where(eq(customerIdentities.githubUserId, githubUserIdSchema.parse(argument)));
    if (!identity) throw new Error('Customer identity is not admitted.');
    process.stdout.write(JSON.stringify(identity) + '\n');
  }
} finally {
  await connection.pool.end();
}

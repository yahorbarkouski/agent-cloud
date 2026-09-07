import { sql, type SQL } from 'drizzle-orm';
import { type AccountId, type GrantId, type MachineId } from '@agent-cloud/contracts';
import { databaseTime, type Executor } from '@agent-cloud/db';

/** Call under the account lock. Closing never acquires a machine/session lock in reverse order. */
async function close(
  db: Executor,
  accountId: AccountId,
  selection: SQL,
  reason: 'authorization_changed' | 'target_changed',
) {
  const at = (await databaseTime(db)).toISOString();
  await db.execute(sql`UPDATE access_sessions SET connection=jsonb_build_object(
    'kind','closed','previous',connection,'reason',${reason}::text,'closedAt',${at}::text
  ) WHERE account_id=${accountId} AND connection->>'kind'<>'closed' AND ${selection}`);
}
export async function closeGrantAccess(db: Executor, accountId: AccountId, grantId: GrantId) {
  await close(
    db,
    accountId,
    sql`grant_id IN (
    WITH RECURSIVE subtree AS (
      SELECT id,1 AS depth FROM grants WHERE id=${grantId} AND account_id=${accountId}
      UNION ALL SELECT g.id,s.depth+1 FROM grants g JOIN subtree s ON g.parent_id=s.id
        WHERE g.account_id=${accountId} AND s.depth<32
    ) SELECT id FROM subtree
  )`,
    'authorization_changed',
  );
}
export async function closeMachineAccess(db: Executor, accountId: AccountId, machineId: MachineId) {
  await close(db, accountId, sql`machine_id=${machineId}`, 'target_changed');
}

import assert from 'node:assert/strict';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { databaseTime, guestIdentities, type Connection } from '../../packages/db/src/index.js';
import type { AllocationId } from '../../packages/contracts/dist/index.js';
import type { GuestConfiguration } from '../../packages/guestctl/dist/index.js';
import {
  certificateDigest,
  currentCertificates,
  selectCertificates,
} from '../../packages/guestctl/src/certificates.js';
import { atomicWrite } from '../../packages/guestctl/src/files.js';

/** Accelerate the schedule only in an isolated test DB. CA certificate validity is untouched. */
export async function ageRenewalFixture(input: {
  connection: Connection;
  configuration: GuestConfiguration;
  allocationId: AllocationId;
}) {
  const current = await currentCertificates(input.configuration);
  assert.ok(current);
  const now = await databaseTime(input.connection.db);
  const identity = {
    ...current.identity,
    issuedAt: new Date(now.getTime() - 1_860_000).toISOString(),
  };
  await input.connection.db.transaction(async (tx) => {
    const check = await tx.execute<{ name: string }>('SELECT current_database() AS name');
    assert.match(check.rows[0]?.name ?? '', /^agentcloud_test_[0-9a-f]{32}$/);
    await tx.execute('ALTER TABLE guest_identities DISABLE TRIGGER guest_identity_guard');
    await tx
      .update(guestIdentities)
      .set({ identity })
      .where(eq(guestIdentities.allocationId, input.allocationId));
    await tx.execute('ALTER TABLE guest_identities ENABLE TRIGGER guest_identity_guard');
  });
  const generation = certificateDigest(identity);
  const directory = join(input.configuration.state, 'certificates', generation);
  await mkdir(directory, { mode: 0o755 });
  for (const name of ['host-cert.pub', 'guest.crt', 'root.crt'])
    await copyFile(join(current.path, name), join(directory, name));
  await atomicWrite(join(directory, 'identity.json'), JSON.stringify(identity) + '\n', 0o600);
  await selectCertificates(input.configuration, generation);
}

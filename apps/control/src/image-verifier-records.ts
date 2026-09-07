import { and, desc, eq, sql } from 'drizzle-orm';
import {
  CloudError,
  guestIdentitySchema,
  imageVerifierSpecSchema,
  imageVerificationSchema,
  type ImageBuildId,
} from '@agent-cloud/contracts';
import {
  imageBuilds,
  imageVerifierBootstraps,
  imageVerifierIdentities,
  imageVerifierResults,
  imageVerifierSigningAttempts,
  type Database,
  type Executor,
} from '@agent-cloud/db';

/** Public inspection deliberately excludes token hashes and encrypted bootstrap material. */
export async function readImageVerification(db: Executor, buildId: ImageBuildId) {
  const [bootstrap] = await db
    .select({ spec: imageVerifierBootstraps.spec })
    .from(imageVerifierBootstraps)
    .where(eq(imageVerifierBootstraps.buildId, buildId));
  if (!bootstrap) return imageVerificationSchema.parse({ kind: 'waiting' });
  const spec = imageVerifierSpecSchema.parse(bootstrap.spec);
  const [row] = await db
    .select()
    .from(imageVerifierIdentities)
    .where(eq(imageVerifierIdentities.buildId, buildId));
  if (!row) return imageVerificationSchema.parse({ kind: 'prepared', spec });
  const identity = guestIdentitySchema.parse(row.identity);
  if (identity.kind === 'claimed')
    return imageVerificationSchema.parse({ kind: 'claimed', spec, identity });
  const [verified] = await db
    .select()
    .from(imageVerifierResults)
    .where(eq(imageVerifierResults.buildId, buildId));
  return imageVerificationSchema.parse(
    verified
      ? { kind: 'verified', spec, identity, result: verified.result }
      : { kind: 'enrolled', spec, identity },
  );
}

/** Locks admission only during durable state changes, never during provider, SSH or CA I/O. */
export async function requireActiveImageBuild(db: Executor, buildId: ImageBuildId) {
  const [build] = await db
    .select({
      active: sql<boolean>`${imageBuilds.state}->>'kind' = 'running' AND (${imageBuilds.admission}->>'deadlineAt')::timestamptz > clock_timestamp()`,
    })
    .from(imageBuilds)
    .where(eq(imageBuilds.id, buildId))
    .for('update');
  if (!build?.active) throw new CloudError('permission_denied', 'Image build is no longer active.');
}

export async function reserveImageVerifierSigning(
  db: Database,
  buildId: ImageBuildId,
  purpose: 'probe' | 'identity' | 'runtime',
) {
  await db.transaction(async (tx) => {
    await requireActiveImageBuild(tx, buildId);
    const [last] = await tx
      .select({
        sequence: imageVerifierSigningAttempts.sequence,
        coolingDown: sql<boolean>`${imageVerifierSigningAttempts.createdAt} + interval '30 seconds' > clock_timestamp()`,
      })
      .from(imageVerifierSigningAttempts)
      .where(
        and(
          eq(imageVerifierSigningAttempts.buildId, buildId),
          eq(imageVerifierSigningAttempts.purpose, purpose),
        ),
      )
      .orderBy(desc(imageVerifierSigningAttempts.sequence))
      .limit(1);
    if ((last?.sequence ?? 0) >= (purpose === 'identity' ? 4 : 12))
      throw new CloudError('quota_exceeded', 'Image verifier signing attempt limit reached.');
    if (last?.coolingDown)
      throw new CloudError(
        'resource_busy',
        'Image verifier signing retry must wait at least 30 seconds.',
        true,
      );
    await tx
      .insert(imageVerifierSigningAttempts)
      .values({ buildId, purpose, sequence: (last?.sequence ?? 0) + 1 });
  });
}

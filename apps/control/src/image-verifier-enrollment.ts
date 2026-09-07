import { eq } from 'drizzle-orm';
import {
  CloudError,
  guestIdentitySchema,
  imageVerifierEnrollmentInputSchema,
  imageVerifierSpecSchema,
  issuedGuestIdentitySchema,
  type ImageBuildId,
  type ImageVerifierEnrollmentInput,
  type IssuedGuestIdentity,
  type ImageProvider,
} from '@agent-cloud/contracts';
import {
  imageVerifierBootstraps,
  databaseTime,
  imageVerifierIdentities,
  withImageBuildLock,
  type Connection,
  type Executor,
} from '@agent-cloud/db';
import type { Signer, ProbeCredential } from '@agent-cloud/pki';
import type { createGuestProbe } from '@agent-cloud/remote';
import type { BootstrapSeal } from './bootstrap-seal.js';
import { inspectImageBuild } from './image-builds.js';
import { observeImageVerifier } from './image-verifier.js';
import { requireActiveImageBuild, reserveImageVerifierSigning } from './image-verifier-records.js';

async function bootstrap(db: Executor, seal: BootstrapSeal, input: ImageVerifierEnrollmentInput) {
  const [row] = await db
    .select()
    .from(imageVerifierBootstraps)
    .where(eq(imageVerifierBootstraps.buildId, input.bootstrap.subject.id));
  if (
    !row ||
    !seal.matches(input.token, row.tokenHash) ||
    row.expiresAt.getTime() <= (await databaseTime(db)).getTime()
  )
    throw new CloudError('unauthenticated', 'Image verifier credentials are invalid or expired.');
  const spec = imageVerifierSpecSchema.parse(row.spec);
  if (
    spec.subject.id !== input.bootstrap.subject.id ||
    spec.image.providerImage !== row.snapshotId ||
    spec.expiresAt !== row.expiresAt.toISOString()
  )
    throw new CloudError('internal_error', 'Image verifier bootstrap ownership is inconsistent.');
  if (input.imageVersion !== spec.image.version)
    throw new CloudError('permission_denied', 'Image verifier image differs from bootstrap.');
  return { row, spec };
}

export function createImageVerifierEnrollment(ports: {
  connection: Connection;
  seal: BootstrapSeal;
  provider: ImageProvider;
  signer: Pick<
    Signer,
    'trust' | 'validateTlsRequest' | 'issueProbeCredential' | 'signHost' | 'signTls'
  >;
  probe: Pick<ReturnType<typeof createGuestProbe>, 'readIdentity'>;
}) {
  const credentials = new Map<ImageBuildId, ProbeCredential>();
  return {
    async enroll(value: ImageVerifierEnrollmentInput): Promise<IssuedGuestIdentity> {
      const input = imageVerifierEnrollmentInputSchema.parse(value);
      await bootstrap(ports.connection.db, ports.seal, input);
      const buildId = input.bootstrap.subject.id;
      const result = await withImageBuildLock({
        pool: ports.connection.pool,
        buildId,
        work: async (db) => {
          const context = await bootstrap(db, ports.seal, input);
          await db.transaction((tx) => requireActiveImageBuild(tx, buildId));
          const [row] = await db
            .select()
            .from(imageVerifierIdentities)
            .where(eq(imageVerifierIdentities.buildId, buildId));
          const identity = row ? guestIdentitySchema.parse(row.identity) : null;
          if (
            identity &&
            (identity.sshHostPublicKey !== input.sshHostPublicKey ||
              identity.tlsCsr !== input.tlsCsr ||
              identity.imageVersion !== input.imageVersion)
          )
            throw new CloudError(
              'permission_denied',
              'Image verifier keys are already claimed by another enrollment.',
            );
          if (identity?.kind === 'issued') return identity;
          if (context.row.consumedAt)
            throw new CloudError(
              'internal_error',
              'Consumed verifier bootstrap has no issued identity.',
            );
          const build = await inspectImageBuild(db, buildId);
          if (
            build.verification.kind === 'waiting' ||
            build.verification.spec.image.providerImage !== context.spec.image.providerImage
          )
            throw new CloudError('permission_denied', 'Image verifier bootstrap is not prepared.');
          const trust = context.spec.image;
          if (
            ports.signer.trust.sshHostCa !== trust.sshHostCa ||
            ports.signer.trust.sshUserCa !== trust.sshUserCa ||
            ports.signer.trust.tlsRoot.trim() !== trust.tlsRoot.trim()
          )
            throw new CloudError(
              'provider_unavailable',
              'Image verifier trust differs from the signer.',
            );
          const observed = await observeImageVerifier(build, ports.provider);
          if (
            observed.snapshotId !== context.spec.image.providerImage ||
            (row && (row.serverId !== observed.server.id || row.effectId !== observed.effectId))
          )
            throw new CloudError(
              'permission_denied',
              'Image verifier ownership differs from its key claim.',
            );
          await ports.signer.validateTlsRequest({
            subject: context.spec.subject,
            csr: input.tlsCsr,
          });
          const credentialTime = (await databaseTime(db)).getTime();
          for (const [id, credential] of credentials)
            if (Date.parse(credential.expiresAt) <= credentialTime + 35_000) credentials.delete(id);
          let credential = credentials.get(buildId);
          if (!credential) {
            if (credentials.size >= 1024)
              throw new CloudError(
                'provider_unavailable',
                'Image verifier credential cache is full.',
                true,
              );
            await reserveImageVerifierSigning(db, buildId, 'probe');
            credential = await ports.signer.issueProbeCredential(context.spec.subject);
            credentials.set(buildId, credential);
          }
          const proof = await ports.probe.readIdentity({
            subject: context.spec.subject,
            address: observed.address,
            trust: { kind: 'pinned_key', publicKey: input.sshHostPublicKey },
            credential,
          });
          if (
            proof.version !== 2 ||
            proof.subject.id !== buildId ||
            proof.sshHostPublicKey !== input.sshHostPublicKey ||
            proof.tlsCsr !== input.tlsCsr ||
            proof.imageVersion !== input.imageVersion ||
            proof.manifestDigest !== context.spec.image.manifestDigest
          )
            throw new CloudError(
              'permission_denied',
              'Image verifier SSH proof differs from its proposal or image.',
            );
          await db.transaction(async (tx) => {
            await requireActiveImageBuild(tx, buildId);
            await bootstrap(tx, ports.seal, input);
            if (!identity)
              await tx.insert(imageVerifierIdentities).values({
                buildId,
                serverId: observed.server.id,
                effectId: observed.effectId,
                identity: {
                  kind: 'claimed',
                  sshHostPublicKey: input.sshHostPublicKey,
                  tlsCsr: input.tlsCsr,
                  imageVersion: input.imageVersion,
                },
              });
          });
          await reserveImageVerifierSigning(db, buildId, 'identity');
          const sshHostCertificate = await ports.signer.signHost({
            subject: context.spec.subject,
            publicKey: input.sshHostPublicKey,
          });
          const tlsCertificate = await ports.signer.signTls({
            subject: context.spec.subject,
            csr: input.tlsCsr,
          });
          const issued = issuedGuestIdentitySchema.parse({
            kind: 'issued',
            sshHostPublicKey: input.sshHostPublicKey,
            tlsCsr: input.tlsCsr,
            imageVersion: input.imageVersion,
            sshHostCertificate,
            tlsCertificate,
            issuedAt: new Date().toISOString(),
          });
          await db.transaction(async (tx) => {
            await requireActiveImageBuild(tx, buildId);
            await bootstrap(tx, ports.seal, input);
            await tx
              .update(imageVerifierIdentities)
              .set({ identity: issued })
              .where(eq(imageVerifierIdentities.buildId, buildId));
            await tx
              .update(imageVerifierBootstraps)
              .set({ consumedAt: new Date(), sealedToken: null })
              .where(eq(imageVerifierBootstraps.buildId, buildId));
          });
          credentials.delete(buildId);
          return issued;
        },
      });
      if (result.kind === 'busy')
        throw new CloudError(
          'resource_busy',
          'Image verification is already being processed.',
          true,
        );
      return result.value;
    },
  };
}
export type ImageVerifierEnrollment = ReturnType<typeof createImageVerifierEnrollment>;

import { createHash, createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { chmod, lstat, mkdtemp, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  guestBootFileSchema,
  guestSubject,
  sameGuestSubject,
  guestManifestSchema,
  guestBootProofSchema,
  issuedGuestIdentitySchema,
  type GuestBootFile,
  type GuestBootProof,
  type GuestBootSpec,
} from '@agent-cloud/contracts';
import { guestName, inspectIssuedSsh, inspectIssuedTls, readCsrKey } from '@agent-cloud/pki';
import {
  atomicWrite,
  ensureDirectory,
  isExisting,
  isMissing,
  readOwnedFile,
  syncDirectory,
} from './files.js';
import { runTool } from './tools.js';
import { certificateDigest, currentCertificates, selectCertificates } from './certificates.js';

export type GuestConfiguration = {
  state: string;
  manifest: string;
  binary: string;
  step: string;
  keygen: string;
};
export async function loadManifest(configuration: GuestConfiguration) {
  const manifest = guestManifestSchema.parse(
    JSON.parse(await readOwnedFile(configuration.manifest, 'public')),
  );
  const digest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  const binary = await readOwnedFile(configuration.binary, 'public', 2 * 1024 * 1024);
  if (createHash('sha256').update(binary).digest('hex') !== manifest.components.guestctlSha256)
    throw new Error('Guest executable does not match the image manifest.');
  return { manifest, digest };
}
export async function verifyImage(configuration: GuestConfiguration, spec: GuestBootSpec) {
  const { manifest, digest } = await loadManifest(configuration);
  if (
    spec.image.manifestDigest !== digest ||
    spec.image.version !== manifest.version ||
    spec.image.architecture !== manifest.architecture ||
    spec.image.customerSsh !== manifest.customerSsh ||
    spec.image.sshHostCa !== manifest.trust.sshHostCa ||
    spec.image.sshUserCa !== manifest.trust.sshUserCa ||
    spec.image.tlsRoot.trim() !== manifest.trust.tlsRoot.trim()
  )
    throw new Error('Guest bootstrap does not match the installed image.');
}
export async function loadBootstrap(configuration: GuestConfiguration): Promise<GuestBootFile> {
  const bootstrap = guestBootFileSchema.parse(
    JSON.parse(await readOwnedFile(join(configuration.state, 'bootstrap.json'), 'private')),
  );
  await verifyImage(configuration, bootstrap.spec);
  return bootstrap;
}
async function storedIdentity(configuration: GuestConfiguration, spec: GuestBootSpec) {
  const directory = join(configuration.state, 'keys');
  await ensureDirectory(directory, 0o700);
  const proof = guestBootProofSchema.parse(
    JSON.parse(await readOwnedFile(join(directory, 'proof.json'), 'private')),
  );
  if (
    !sameGuestSubject(guestSubject(proof), guestSubject(spec)) ||
    proof.imageVersion !== spec.image.version ||
    proof.manifestDigest !== spec.image.manifestDigest
  )
    throw new Error('Existing guest identity belongs to another guest subject or image.');
  const publicKey = (
    await runTool(
      configuration.keygen,
      ['-y', '-f', join(directory, 'ssh_host_ed25519_key')],
      directory,
    )
  ).trim();
  if (publicKey !== proof.sshHostPublicKey)
    throw new Error('Guest SSH private key does not match its identity.');
  if ((await readOwnedFile(join(directory, 'guest.csr'), 'public')) !== proof.tlsCsr)
    throw new Error('Guest TLS request does not match its identity.');
  const requestKey = await readCsrKey(
    (args) => runTool(configuration.step, args, directory),
    join(directory, 'guest.csr'),
    guestName(guestSubject(spec)),
  );
  const privateKey = createPrivateKey(await readOwnedFile(join(directory, 'guest.key'), 'private'));
  if (
    !requestKey
      .export({ type: 'spki', format: 'der' })
      .equals(createPublicKey(privateKey).export({ type: 'spki', format: 'der' }))
  )
    throw new Error('Guest TLS private key does not match its request.');
  return proof;
}

/** Publish the complete key directory once. Concurrent or restarted boot adopts the winner. */
export async function ensureIdentity(
  configuration: GuestConfiguration,
  spec: GuestBootSpec,
): Promise<GuestBootProof> {
  await ensureDirectory(configuration.state, 0o755);
  let existing = false;
  try {
    await lstat(join(configuration.state, 'keys'));
    existing = true;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (existing) return storedIdentity(configuration, spec);
  const temporary = await mkdtemp(join(configuration.state, '.keys-'));
  try {
    const hostKey = join(temporary, 'ssh_host_ed25519_key');
    const name = guestName(guestSubject(spec));
    await runTool(
      configuration.keygen,
      ['-t', 'ed25519', '-N', '', '-C', '', '-f', hostKey],
      temporary,
    );
    await runTool(
      configuration.step,
      [
        'certificate',
        'create',
        name,
        join(temporary, 'guest.csr'),
        join(temporary, 'guest.key'),
        '--csr',
        '--kty',
        'EC',
        '--curve',
        'P-256',
        '--no-password',
        '--insecure',
        '--san',
        name,
      ],
      temporary,
    );
    const proof = guestBootProofSchema.parse({
      ...(spec.version === 1
        ? { version: 1, allocationId: spec.allocationId }
        : { version: 2, subject: spec.subject }),
      imageVersion: spec.image.version,
      manifestDigest: spec.image.manifestDigest,
      sshHostPublicKey: (await readOwnedFile(hostKey + '.pub', 'public')).trim(),
      tlsCsr: await readOwnedFile(join(temporary, 'guest.csr'), 'public'),
    });
    await atomicWrite(join(temporary, 'proof.json'), JSON.stringify(proof) + '\n', 0o600);
    for (const filename of ['ssh_host_ed25519_key', 'guest.key', 'guest.csr']) {
      const file = await open(join(temporary, filename), 'r');
      try {
        await file.sync();
      } finally {
        await file.close();
      }
    }
    try {
      await rename(temporary, join(configuration.state, 'keys'));
    } catch (error) {
      if (!isExisting(error)) throw error;
    }
    await syncDirectory(configuration.state);
    return await storedIdentity(configuration, spec);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Validate every returned identity field and certificate before atomically publishing a bundle. */
export async function installIdentity(
  configuration: GuestConfiguration,
  spec: GuestBootSpec,
  proof: GuestBootProof,
  value: unknown,
) {
  const identity = issuedGuestIdentitySchema.parse(value);
  if (
    identity.sshHostPublicKey !== proof.sshHostPublicKey ||
    identity.tlsCsr !== proof.tlsCsr ||
    identity.imageVersion !== proof.imageVersion
  )
    throw new Error('Enrollment returned a different guest identity.');
  const base = join(configuration.state, 'certificates');
  const stored = await currentCertificates(configuration);
  if (
    stored &&
    JSON.stringify(stored.identity) !== JSON.stringify(identity) &&
    Date.parse(identity.issuedAt) <= Date.parse(stored.identity.issuedAt)
  )
    throw new Error('Certificate renewal must advance the installed identity.');
  await ensureDirectory(base, 0o750);
  const generation = certificateDigest(identity);
  const destination = join(base, generation);
  const temporary = await mkdtemp(join(base, '.generation-'));
  try {
    await atomicWrite(join(temporary, 'host-cert.pub'), identity.sshHostCertificate + '\n', 0o644);
    await atomicWrite(join(temporary, 'guest.crt'), identity.tlsCertificate, 0o644);
    await atomicWrite(join(temporary, 'root.crt'), spec.image.tlsRoot, 0o644);
    await validateCertificates(configuration, proof, spec, identity, temporary);
    await atomicWrite(join(temporary, 'identity.json'), JSON.stringify(identity) + '\n', 0o600);
    await chmod(temporary, 0o755);
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (!isExisting(error)) throw error;
      const stat = await lstat(destination);
      if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o022)
        throw new Error('Existing certificate generation is unsafe.', { cause: error });
      for (const name of ['host-cert.pub', 'guest.crt', 'root.crt', 'identity.json'])
        if (
          (await readOwnedFile(
            join(destination, name),
            name === 'identity.json' ? 'private' : 'public',
          )) !==
          (await readOwnedFile(
            join(temporary, name),
            name === 'identity.json' ? 'private' : 'public',
          ))
        )
          throw new Error('Existing certificate generation disagrees.', { cause: error });
    }
    await syncDirectory(base);
    await selectCertificates(configuration, generation);
    return identity;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function validateCertificates(
  configuration: GuestConfiguration,
  proof: GuestBootProof,
  spec: GuestBootSpec,
  identity: ReturnType<typeof issuedGuestIdentitySchema.parse>,
  directory: string,
) {
  const name = guestName(guestSubject(proof));
  await runTool(
    configuration.step,
    [
      'certificate',
      'verify',
      join(directory, 'guest.crt'),
      '--roots',
      join(directory, 'root.crt'),
      '--host',
      name,
    ],
    directory,
  );
  const privateKey = createPrivateKey(
    await readOwnedFile(join(configuration.state, 'keys', 'guest.key'), 'private'),
  );
  inspectIssuedTls(new X509Certificate(identity.tlsCertificate), {
    name,
    key: createPublicKey(privateKey),
    timing: { kind: 'installed', issuedAt: Date.parse(identity.issuedAt) },
  });
  inspectIssuedSsh(
    JSON.parse(
      await runTool(
        configuration.step,
        ['ssh', 'inspect', join(directory, 'host-cert.pub'), '--format', 'json'],
        directory,
      ),
    ),
    {
      kind: 'host',
      key: proof.sshHostPublicKey,
      ca: spec.image.sshHostCa,
      principal: name,
      timing: { kind: 'installed', issuedAt: Date.parse(identity.issuedAt) },
    },
  );
}

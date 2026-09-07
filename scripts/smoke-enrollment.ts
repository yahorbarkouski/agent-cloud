import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:https';
import { join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import {
  guestImageSchema,
  guestManifestSchema,
  issuedGuestIdentitySchema,
} from '../packages/contracts/dist/index.js';
import {
  guestBootstraps,
  guestIdentities,
  operations,
  guestSigningAttempts,
} from '../packages/db/src/index.js';
import { createSigner, guestName, probePrincipal } from '../packages/pki/dist/index.js';
import { enrollGuest, ensureIdentity } from '../packages/guestctl/dist/index.js';
import { createGuestProbe } from '../packages/remote/dist/index.js';
import { createApp } from '../apps/control/src/app.js';
import { createEnrollmentService } from '../apps/control/src/guest-enrollment.js';
import { readPrivateFile } from '../apps/control/src/private-file.js';
import { testDatabase } from '../tests/database.js';
import { prepareEnrollmentFixture } from './support/enrollment-fixture.js';
import { withSshFixture } from './support/ssh-fixture.js';

const database = await testDatabase();
try {
  await withSshFixture(async ({ scratch, fixture, run, start, installHostCertificate }) => {
    const db = database.connection.db;
    const step = resolve('.local/tools/step-0.30.6');
    const signer = createSigner({
      binary: step,
      caUrl: 'https://localhost:9449',
      tlsRoot: await readFile('.local/pki/public/root_ca.crt', 'utf8'),
      sshHostCa: (await readFile('.local/pki/public/ssh_host_ca_key.pub', 'utf8')).trim(),
      sshUserCa: (await readFile('.local/pki/public/ssh_user_ca_key.pub', 'utf8')).trim(),
      provisioner: 'agent-cloud-control',
      provisionerPassword: await readPrivateFile(resolve('.local/pki/provisioner-password')),
    });
    const configuration = {
      state: join(scratch, 'guest-state'),
      manifest: resolve('.local/guest-build/image.json'),
      binary: resolve('.local/guest-build/guestctl.mjs'),
      step,
      keygen: '/usr/bin/ssh-keygen',
    };
    await mkdir(configuration.state, { mode: 0o755 });
    const manifest = guestManifestSchema.parse(
      JSON.parse(await readFile(configuration.manifest, 'utf8')),
    );
    const image = guestImageSchema.parse({
      providerImage: 'local-ssh-fixture',
      architecture: manifest.architecture,
      version: manifest.version,
      manifestDigest: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
      ...manifest.trust,
    });
    const { provider, seal, limits, catalog, operation, allocation, bootstrap } =
      await prepareEnrollmentFixture({
        connection: database.connection,
        image,
        address: '127.0.0.1',
        enrollmentUrl: 'https://enrollment.example.test/guest/enroll',
      });
    const allocationId = bootstrap.spec.allocationId;
    const name = guestName(allocationId);
    await writeFile(join(configuration.state, 'bootstrap.json'), JSON.stringify(bootstrap), {
      mode: 0o600,
    });
    const proof = await ensureIdentity(configuration, bootstrap.spec);
    const publicKey = proof.sshHostPublicKey;
    await copyFile(
      join(configuration.state, 'keys', 'ssh_host_ed25519_key'),
      join(fixture, 'host_key'),
    );
    await writeFile(join(fixture, 'user_ca.pub'), signer.trust.sshUserCa + '\n', { mode: 0o644 });
    await writeFile(join(fixture, 'principals'), probePrincipal(allocationId) + '\n', {
      mode: 0o644,
    });
    await writeFile(join(fixture, 'proof.json'), JSON.stringify(proof), { mode: 0o644 });
    const port = await start();
    const nativeProbe = createGuestProbe();
    const probe = {
      readIdentity: (input: Parameters<typeof nativeProbe.readIdentity>[0]) => {
        assert.equal(input.address, '127.0.0.1');
        return nativeProbe.readIdentity({ ...input, port });
      },
    };
    const enrollment = createEnrollmentService({
      connection: database.connection,
      seal,
      signer,
      probe,
      provider,
    });
    const app = createApp({
      db,
      provider: provider.kind,
      limits,
      catalog,
      enrollment,
    });
    const proposal = {
      bootstrap: { version: 1, allocationId },
      token: bootstrap.token,
      sshHostPublicKey: publicKey,
      tlsCsr: proof.tlsCsr,
      imageVersion: image.version,
    };
    const post = (input: unknown) =>
      app.request('/guest/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
    assert.equal(
      (await post({ ...proposal, token: randomBytes(32).toString('base64url') })).status,
      401,
    );
    await run('/usr/bin/ssh-keygen', [
      '-t',
      'ed25519',
      '-N',
      '',
      '-C',
      '',
      '-f',
      join(scratch, 'foreign_key'),
    ]);
    const foreignKey = (await readFile(join(scratch, 'foreign_key.pub'), 'utf8')).trim();
    assert.equal((await post({ ...proposal, sshHostPublicKey: foreignKey })).status, 503);
    assert.equal((await db.select().from(guestIdentities)).length, 0);
    const system = {
      prepareSsh: async (input: { proof: typeof proof }) => {
        assert.deepEqual(input.proof, proof);
        await Promise.resolve();
      },
      activate: async () => {
        await copyFile(
          join(configuration.state, 'certificates', 'host-cert.pub'),
          join(fixture, 'host_key-cert.pub'),
        );
        await installHostCertificate();
      },
      eraseBootstrap: () => rm(join(configuration.state, 'bootstrap.json'), { force: true }),
    };
    let loseResponse = true;
    const transport: typeof fetch = async (input, init) => {
      const response = await app.request(new Request(input, init));
      if (response.ok && loseResponse) {
        loseResponse = false;
        throw new Error('Lost enrollment response.');
      }
      return response;
    };
    await assert.rejects(
      enrollGuest({ configuration, system, transport }),
      /Lost enrollment response/,
    );
    assert.deepEqual(await ensureIdentity(configuration, bootstrap.spec), proof);
    await enrollGuest({ configuration, system, transport });
    // Restart after local bootstrap removal must activate the installed identity without networking.
    await enrollGuest({
      configuration,
      system,
      transport: () => Promise.reject(new Error('Unexpected enrollment retry.')),
    });
    const identity = issuedGuestIdentitySchema.parse(
      JSON.parse(
        await readFile(join(configuration.state, 'certificates', 'identity.json'), 'utf8'),
      ),
    );
    assert.deepEqual(await (await post(proposal)).json(), identity);
    assert.equal((await db.select().from(guestBootstraps))[0]?.sealedToken, null);
    assert.deepEqual(
      (await db.select().from(guestSigningAttempts)).map((attempt) => attempt.purpose).sort(),
      ['identity', 'probe'],
    );
    assert.deepEqual(
      (await db.select().from(operations).where(eq(operations.id, operation.id)))[0]?.progress,
      { kind: 'waiting_guest', stage: 'runtime', serverId: allocation.serverId },
    );
    assert.deepEqual(
      await nativeProbe.readIdentity({
        allocationId,
        address: '127.0.0.1',
        port,
        credential: await signer.issueProbeCredential(allocationId),
        trust: { kind: 'host_ca', publicKey: signer.trust.sshHostCa },
      }),
      proof,
    );
    const tls = createServer(
      {
        key: await readFile(join(configuration.state, 'keys', 'guest.key')),
        cert: identity.tlsCertificate,
      },
      (_request, response) => response.end('verified'),
    );
    try {
      await new Promise<void>((resolve) => tls.listen(0, '127.0.0.1', resolve));
      const address = tls.address();
      if (!address || typeof address === 'string') throw new Error('Expected loopback TLS port.');
      await new Promise<void>((resolve, reject) => {
        const check = request(
          {
            host: '127.0.0.1',
            port: address.port,
            servername: name,
            ca: signer.trust.tlsRoot,
            timeout: 5000,
          },
          (response) => {
            response.resume();
            response.once('end', resolve);
          },
        );
        check.once('error', reject);
        check.once('timeout', () => check.destroy(new Error('TLS verification timed out.')));
        check.end();
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        tls.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    }
    process.stdout.write(
      JSON.stringify({
        ok: true,
        enrollment: 'guest library with real Smallstep and pinned OpenSSH',
        guestRetry: 'keys survive lost response and bootstrap removal',
        guestActivation: 'local fixture hooks, not systemd',
        replay: 'same certificates without extra enrollment signing',
        wrongHostKey: 'rejected before key claim',
        issuedHostCertificate: 'verified native SSH connection',
        issuedTlsCertificate: 'verified native TLS connection',
        operation: 'waiting for runtime verification',
        provider: 'local simulated observations',
        cloudResourcesCreated: 0,
      }) + '\n',
    );
  });
} finally {
  await database.close();
}

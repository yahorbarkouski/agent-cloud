import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:https';
import { join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import {
  allocationIdSchema,
  guestImageSchema,
  guestProofSchema,
  issuedGuestIdentitySchema,
  operationResponseSchema,
  operationProgressSchema,
  simulatedCatalog,
  type MachineProvider,
} from '../packages/contracts/dist/index.js';
import {
  allocations,
  guestBootstraps,
  guestIdentities,
  operations,
  guestSigningAttempts,
} from '../packages/db/src/index.js';
import { createSigner, guestName, probePrincipal } from '../packages/pki/dist/index.js';
import { createGuestProbe } from '../packages/remote/dist/index.js';
import { createApp } from '../apps/control/src/app.js';
import { advanceOperation } from '../apps/control/src/advance-operation.js';
import { BootstrapSeal } from '../apps/control/src/bootstrap-seal.js';
import { recoverGuestBootstrap } from '../apps/control/src/guest-bootstrap.js';
import { createEnrollmentService } from '../apps/control/src/guest-enrollment.js';
import { createGuestRenderer } from '../apps/control/src/guest-renderer.js';
import { readPrivateFile } from '../apps/control/src/private-file.js';
import { SimulatedProvider } from '../apps/control/src/simulated-provider.js';
import { seedAccount, testDatabase } from '../tests/database.js';
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
    const image = guestImageSchema.parse({
      providerImage: 'local-ssh-fixture',
      architecture: 'x86',
      version: 'fixture-v1',
      manifestDigest: 'a'.repeat(64),
      ...signer.trust,
    });
    const account = await seedAccount(db);
    const seal = new BootstrapSeal(randomBytes(32).toString('base64'));
    const render = createGuestRenderer(db, seal);
    const limits = { currency: 'EUR', maxMachines: 1, maxHourlyMicros: 20_000 };
    const simulation = new SimulatedProvider({
      db,
      catalog: () => ({ ...simulatedCatalog(), provider: 'hetzner' }),
    });
    // Local provider observations name the disposable loopback SSH fixture. No cloud API is used.
    const provider: MachineProvider = {
      kind: 'hetzner',
      getCatalog: () => simulation.getCatalog(),
      submit: async (input) => {
        if (input.command.kind === 'create_guest')
          await render({ attemptId: input.attemptId, command: input.command });
        return simulation.submit(input);
      },
      getAction: (input) => simulation.getAction(input),
      findServers: (input) => simulation.findServers(input),
      findPrimaryIps: (input) => simulation.findPrimaryIps(input),
      getServer: async (input) => {
        const server = await simulation.getServer(input);
        return server && { ...server, ipv4: '127.0.0.1' };
      },
      getPrimaryIp: async (input) => {
        const ip = await simulation.getPrimaryIp(input);
        return ip && { ...ip, ipv4: '127.0.0.1' };
      },
    };
    const admission = createApp({
      db,
      provider: provider.kind,
      limits,
      catalog: simulation.catalog,
    });
    const response = await admission.request(`/v1/projects/${account.projectId}/machines`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${account.token}`,
        'Idempotency-Key': randomUUID(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'native-enrollment', size: 'small', region: 'nbg1' }),
    });
    assert.equal(response.status, 202);
    const { operation } = operationResponseSchema.parse(await response.json());
    for (let tick = 0; tick < 6; tick++)
      await advanceOperation({
        connection: database.connection,
        operationId: operation.id,
        provider,
        limits,
        guest: {
          kind: 'enabled',
          image,
          seal,
          enrollmentUrl: 'https://enrollment.example.test/guest/enroll',
        },
      });
    const [allocation] = await db
      .select()
      .from(allocations)
      .where(eq(allocations.machineId, operation.machineId));
    if (!allocation) throw new Error('Expected fixture allocation.');
    const state = operationProgressSchema.parse(
      (await db.select().from(operations).where(eq(operations.id, operation.id)))[0]?.progress,
    );
    assert.equal(state.kind, 'waiting_guest');
    const bootstrap = await recoverGuestBootstrap(db, {
      reference: { version: 1, allocationId: allocationIdSchema.parse(allocation.id) },
      seal,
    });
    const allocationId = bootstrap.spec.allocationId;
    const name = guestName(allocationId);
    await run('/usr/bin/ssh-keygen', [
      '-t',
      'ed25519',
      '-N',
      '',
      '-C',
      '',
      '-f',
      join(fixture, 'host_key'),
    ]);
    const publicKey = (await readFile(join(fixture, 'host_key.pub'), 'utf8')).trim();
    await writeFile(join(fixture, 'user_ca.pub'), signer.trust.sshUserCa + '\n', { mode: 0o644 });
    await writeFile(join(fixture, 'principals'), probePrincipal(allocationId) + '\n', {
      mode: 0o644,
    });
    await run(step, [
      'certificate',
      'create',
      name,
      join(scratch, 'guest.csr'),
      join(scratch, 'guest.key'),
      '--csr',
      '--kty',
      'EC',
      '--curve',
      'P-256',
      '--no-password',
      '--insecure',
      '--san',
      name,
    ]);
    const proof = guestProofSchema.parse({
      version: 1,
      allocationId,
      imageVersion: image.version,
      manifestDigest: image.manifestDigest,
      sshHostPublicKey: publicKey,
      tlsCsr: await readFile(join(scratch, 'guest.csr'), 'utf8'),
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
      catalog: simulation.catalog,
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
    const enrolled = await post(proposal);
    assert.equal(enrolled.status, 200);
    const identity = issuedGuestIdentitySchema.parse(await enrolled.json());
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
    await writeFile(join(fixture, 'host_key-cert.pub'), identity.sshHostCertificate + '\n', {
      mode: 0o644,
    });
    await installHostCertificate();
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
      { key: await readFile(join(scratch, 'guest.key')), cert: identity.tlsCertificate },
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
        enrollment: 'real Smallstep and pinned OpenSSH',
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

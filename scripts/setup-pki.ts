import { execFile } from 'node:child_process';
import { randomBytes, X509Certificate } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  writeFile,
  rename,
  rm,
  readdir,
  chmod,
  open,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const root = resolve('.local');
const destination = join(root, 'pki');
const binary = join(root, 'tools/step-0.30.6');
const stateSchema = z.strictObject({
  version: z.literal(1),
  rootFingerprint: z.string(),
  caUrl: z.literal('https://localhost:9449'),
});
await mkdir(root, { recursive: true, mode: 0o700 });
const directory = await lstat(root);
if (!directory.isDirectory() || (directory.mode & 0o077) !== 0)
  throw new Error('.local must be an owner-only real directory.');
try {
  const existing = await lstat(destination);
  if (!existing.isDirectory() || (existing.mode & 0o077) !== 0)
    throw new Error('PKI must be an owner-only real directory.');
  const state = stateSchema.parse(
    JSON.parse(await readFile(join(destination, 'state.json'), 'utf8')),
  );
  const certificate = new X509Certificate(await readFile(join(destination, 'public/root_ca.crt')));
  if (certificate.fingerprint256 !== state.rootFingerprint)
    throw new Error('Existing PKI root disagrees with its recorded identity.');
  const configPath = join(destination, 'issuer/config/ca.json');
  const config = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(await readFile(configPath, 'utf8')));
  if (Object.hasOwn(config, 'logger')) {
    // Step's text/JSON access logger includes signing tokens. Omission disables the middleware.
    delete config['logger'];
    const temporary = configPath + '.' + randomBytes(8).toString('hex') + '.next';
    try {
      await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', {
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temporary, configPath);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  for (const name of ['guest-leaf.tpl', 'guest-ssh.tpl']) {
    const path = join(destination, 'issuer/config', name);
    const intended = await readFile(resolve('infra/pki', name));
    if (!(await readFile(path)).equals(intended)) {
      const temporary = path + '.' + randomBytes(8).toString('hex') + '.next';
      try {
        await writeFile(temporary, intended, { mode: 0o600, flag: 'wx' });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    }
  }
  await prepareGateway(destination, config);
  await publishPrivate(configPath, JSON.stringify(config, null, 2) + '\n');
  // Matching files cannot establish what an already-running CA loaded before a crash.
  process.stdout.write(
    JSON.stringify({
      ...state,
      created: false,
      restartRequired: true,
      gateway: gatewayMetadata(),
    }) + '\n',
  );
} catch (error) {
  if (
    !(
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT' &&
      'path' in error &&
      error.path === destination
    )
  )
    throw error;
  await initialize();
}

async function initialize() {
  const staging = await mkdtemp(join(root, 'pki-init-'));
  try {
    const issuer = join(staging, 'issuer');
    await mkdir(issuer, { mode: 0o700 });
    await writeFile(join(issuer, 'password'), randomBytes(32).toString('base64url') + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    await writeFile(
      join(staging, 'provisioner-password'),
      randomBytes(32).toString('base64url') + '\n',
      { mode: 0o600, flag: 'wx' },
    );
    try {
      await promisify(execFile)(
        binary,
        [
          'ca',
          'init',
          '--deployment-type',
          'standalone',
          '--ssh',
          '--name',
          'agent-cloud-development',
          '--dns',
          'localhost',
          '--dns',
          '127.0.0.1',
          '--address',
          ':9000',
          '--provisioner',
          'agent-cloud-control',
          '--password-file',
          join(issuer, 'password'),
          '--provisioner-password-file',
          join(staging, 'provisioner-password'),
          '--with-ca-url',
          'https://localhost:9449',
        ],
        { env: { ...process.env, STEPPATH: issuer }, timeout: 30_000, maxBuffer: 32 * 1024 },
      );
    } catch {
      throw new Error(
        'Smallstep initialization failed. Verify the pinned CLI is installed with pnpm setup:step.',
      );
    }
    const configPath = join(issuer, 'config/ca.json');
    const config = z
      .looseObject({
        root: z.union([z.string(), z.array(z.string())]),
        crt: z.string(),
        key: z.string(),
        db: z.looseObject({ dataSource: z.string() }),
        ssh: z.looseObject({ hostKey: z.string(), userKey: z.string() }),
        authority: z.looseObject({
          provisioners: z.array(z.looseObject({ name: z.string(), type: z.string() })),
        }),
      })
      .parse(JSON.parse(await readFile(configPath, 'utf8')));
    function containerPath(path: string) {
      if (!path.startsWith(issuer + '/'))
        throw new Error('Generated CA path escaped the dedicated issuer directory.');
      return '/home/step/' + path.slice(issuer.length + 1);
    }
    config.root =
      typeof config.root === 'string' ? containerPath(config.root) : config.root.map(containerPath);
    config.crt = containerPath(config.crt);
    config.key = containerPath(config.key);
    config.db.dataSource = '/home/step/db';
    config.ssh.hostKey = containerPath(config.ssh.hostKey);
    config.ssh.userKey = containerPath(config.ssh.userKey);
    config.authority.provisioners = config.authority.provisioners.filter(
      (provisioner) => provisioner.type === 'JWK' && provisioner.name === 'agent-cloud-control',
    );
    if (config.authority.provisioners.length !== 1)
      throw new Error('Expected one dedicated control provisioner.');
    for (const provisioner of config.authority.provisioners)
      provisioner['options'] = {
        x509: { templateFile: '/home/step/config/guest-leaf.tpl' },
        ssh: { templateFile: '/home/step/config/guest-ssh.tpl' },
      };
    await writeFile(
      join(issuer, 'config/guest-leaf.tpl'),
      await readFile(resolve('infra/pki/guest-leaf.tpl')),
      { mode: 0o600 },
    );
    await writeFile(
      join(issuer, 'config/guest-ssh.tpl'),
      await readFile(resolve('infra/pki/guest-ssh.tpl')),
      { mode: 0o600 },
    );
    delete config['logger'];
    config.authority['claims'] = {
      enableSSHCA: true,
      disableRenewal: true,
      minTLSCertDuration: '5m',
      defaultTLSCertDuration: '1h',
      maxTLSCertDuration: '1h',
      minHostSSHCertDuration: '5m',
      defaultHostSSHCertDuration: '1h',
      maxHostSSHCertDuration: '1h',
      minUserSSHCertDuration: '1m',
      defaultUserSSHCertDuration: '5m',
      maxUserSSHCertDuration: '5m',
    };
    await prepareGateway(staging, config);
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    await mkdir(join(staging, 'offline'), { mode: 0o700 });
    await rename(join(issuer, 'secrets/root_ca_key'), join(staging, 'offline/root_ca_key'));
    await mkdir(join(staging, 'public'), { mode: 0o700 });
    for (const name of ['root_ca.crt', 'ssh_user_ca_key.pub', 'ssh_host_ca_key.pub']) {
      await writeFile(join(staging, 'public', name), await readFile(join(issuer, 'certs', name)), {
        mode: 0o600,
      });
    }
    // step init may use broader file defaults. The root private key stays outside the CA mount.
    await privateTree(staging);
    const certificate = new X509Certificate(await readFile(join(staging, 'public/root_ca.crt')));
    const state = stateSchema.parse({
      version: 1,
      rootFingerprint: certificate.fingerprint256,
      caUrl: 'https://localhost:9449',
    });
    await writeFile(join(staging, 'state.json'), JSON.stringify(state, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    await writeFile(
      join(staging, 'compose.env'),
      `ACLD_UID=${process.getuid?.() ?? 1000}\nACLD_GID=${process.getgid?.() ?? 1000}\n`,
      { mode: 0o600, flag: 'wx' },
    );
    await rename(staging, destination);
    process.stdout.write(
      JSON.stringify({ ...state, created: true, gateway: gatewayMetadata() }) + '\n',
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function gatewayMetadata() {
  return {
    provisioner: 'agent-cloud-gateway',
    provisionerPasswordFile: join(destination, 'gateway-provisioner-password'),
    tlsRootFile: join(destination, 'public/root_ca.crt'),
    templateFile: join(destination, 'issuer/config/gateway-leaf.tpl'),
  };
}

async function publishPrivate(path: string, value: string | Buffer) {
  const temporary = path + '.' + randomBytes(8).toString('hex') + '.next';
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(value);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(resolve(path, '..'), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

/** A separate key and provisioner allow gateway renewal without enabling guest renewal. */
async function prepareGateway(pki: string, config: Record<string, unknown>) {
  const authority = z.record(z.string(), z.unknown()).parse(config['authority']);
  const claims = z.record(z.string(), z.unknown()).parse(authority['claims']);
  if (claims['disableRenewal'] !== true)
    throw new Error('Guest renewal must remain disabled in the CA authority.');
  const provisioners = z.array(z.record(z.string(), z.unknown())).parse(authority['provisioners']);
  const matches = provisioners.filter((entry) => entry['name'] === 'agent-cloud-gateway');
  if (matches.length > 1) throw new Error('Expected at most one gateway provisioner.');
  const existing = matches[0];
  const passwordPath = join(pki, 'gateway-provisioner-password');
  try {
    const info = await lstat(passwordPath);
    if (
      !info.isFile() ||
      info.mode & 0o077 ||
      info.uid !== process.getuid?.() ||
      info.size < 32 ||
      info.size > 512
    )
      throw new Error('Gateway provisioner password must be an owner-only regular file.');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    if (existing)
      throw new Error(
        'Existing gateway provisioner password is missing; restore it without replacing its key.',
        { cause: error },
      );
    await publishPrivate(passwordPath, randomBytes(32).toString('base64url') + '\n');
  }
  let provisioner: Record<string, unknown>;
  if (existing) {
    z.object({
      type: z.literal('JWK'),
      key: z.object({ kty: z.literal('EC'), crv: z.literal('P-256'), kid: z.string() }),
      encryptedKey: z.string().min(1),
    }).parse(existing);
    provisioner = existing;
  } else {
    const directory = await mkdtemp(join(pki, 'gateway-key-'));
    try {
      const publicPath = join(directory, 'public.json');
      const privatePath = join(directory, 'private.jwe');
      try {
        await promisify(execFile)(
          binary,
          [
            'crypto',
            'jwk',
            'create',
            publicPath,
            privatePath,
            '--kty',
            'EC',
            '--curve',
            'P-256',
            '--use',
            'sig',
            '--alg',
            'ES256',
            '--password-file',
            passwordPath,
          ],
          {
            env: { PATH: '/usr/bin:/bin', LANG: 'C', STEPPATH: directory },
            timeout: 20_000,
            killSignal: 'SIGKILL',
            maxBuffer: 16_384,
          },
        );
      } catch {
        throw new Error('Gateway provisioner key generation failed.');
      }
      const key = z
        .strictObject({
          kty: z.literal('EC'),
          crv: z.literal('P-256'),
          kid: z.string(),
          x: z.string(),
          y: z.string(),
          use: z.literal('sig'),
          alg: z.literal('ES256'),
        })
        .parse(JSON.parse(await readFile(publicPath, 'utf8')));
      const encryptedKey = z
        .string()
        .min(1)
        .max(16_384)
        .parse((await readFile(privatePath, 'utf8')).trim());
      provisioner = { type: 'JWK', name: 'agent-cloud-gateway', key, encryptedKey };
      provisioners.push(provisioner);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  provisioner['claims'] = {
    enableSSHCA: false,
    disableRenewal: false,
    allowRenewalAfterExpiry: false,
    minTLSCertDuration: '5m',
    defaultTLSCertDuration: '1h',
    maxTLSCertDuration: '1h',
  };
  provisioner['options'] = { x509: { templateFile: '/home/step/config/gateway-leaf.tpl' } };
  await publishPrivate(
    join(pki, 'issuer/config/gateway-leaf.tpl'),
    await readFile(resolve('infra/pki/gateway-leaf.tpl')),
  );
  authority['provisioners'] = provisioners;
  config['authority'] = authority;
}

async function privateTree(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isDirectory()) {
    await chmod(path, 0o700);
    for (const name of await readdir(path)) await privateTree(join(path, name));
  } else if (info.isFile()) await chmod(path, 0o600);
  else throw new Error('Generated PKI contains an unexpected file type.');
}

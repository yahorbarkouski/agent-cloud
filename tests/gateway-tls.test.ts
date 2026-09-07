import { execFile } from 'node:child_process';
import { createPublicKey, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  gatewayTlsName,
  generateGatewayTlsKey,
  inspectGatewayTls,
  issueGatewayTls,
  renewGatewayTls,
  validateGatewayTls,
  type GatewayTlsIdentity,
} from '../packages/pki/src/gateway-tls.js';
import { inspectIssuedTls } from '../packages/pki/src/tls-certificate.js';

let directory: string;
let binary: string;
let tlsRoot: string;
let identity: GatewayTlsIdentity;
const name = gatewayTlsName('public');
const configuration = () => ({ binary, tlsRoot, caUrl: 'https://ca.example.test' });

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'acld-gateway-tls-test-'));
  const rootKey = join(directory, 'root.key');
  const rootPath = join(directory, 'root.crt');
  await writeFile(rootKey, generateGatewayTlsKey(), { mode: 0o600 });
  const config = join(directory, 'root.cnf');
  await writeFile(
    config,
    '[req]\ndistinguished_name=dn\nx509_extensions=root\n[dn]\n[root]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\n',
  );
  await promisify(execFile)(
    '/usr/bin/openssl',
    [
      'req',
      '-x509',
      '-new',
      '-key',
      rootKey,
      '-out',
      rootPath,
      '-days',
      '2',
      '-subj',
      '/CN=Gateway test root',
      '-config',
      config,
    ],
    { timeout: 5000 },
  );
  tlsRoot = await readFile(rootPath, 'utf8');
  await writeFile(join(directory, 'index'), '');
  await writeFile(join(directory, 'index.attr'), 'unique_subject = no\n');
  await writeFile(join(directory, 'serial'), '1000\n');
  await writeFile(join(directory, 'settings.json'), '{}');
  binary = join(directory, 'step-fixture');
  // Exercise real child-process/file delivery and OpenSSL signing/path validation. Only the
  // remote Smallstep command protocol is substituted; no running CA or issuer secrets are used.
  await writeFile(
    binary,
    `#!${process.execPath}
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { join } from 'node:path';
const fixture = ${JSON.stringify(directory)};
const args = process.argv.slice(2);
appendFileSync(join(fixture, 'commands.jsonl'), JSON.stringify({args, env: Object.keys(process.env), files: readdirSync(process.cwd())}) + '\\n');
const settings = JSON.parse(readFileSync(join(fixture, 'settings.json'), 'utf8'));
const flag = (name) => args[args.indexOf(name) + 1];
const run = (args) => {
  try { return execFileSync('/usr/bin/openssl', args, {stdio: 'pipe'}); }
  catch (error) { writeFileSync(join(fixture, 'fixture-error'), String(error.stderr)); process.exit(1); }
};
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, '').replace(/\\.\\d{3}Z$/, 'Z').slice(2);
const sign = (csr, output) => {
  const extension = join(process.cwd(), 'leaf.cnf');
  writeFileSync(extension, '[ca]\\ndefault_ca=issuer\\n[issuer]\\ndatabase='+join(fixture,'index')+'\\nserial='+join(fixture,'serial')+'\\nnew_certs_dir='+fixture+'\\ncertificate='+join(fixture,'root.crt')+'\\nprivate_key='+join(fixture,'root.key')+'\\ndefault_md=sha256\\npolicy=policy\\nx509_extensions=leaf\\n[policy]\\ncommonName=supplied\\n[leaf]\\nbasicConstraints=critical,CA:FALSE\\nkeyUsage=critical,digitalSignature\\nextendedKeyUsage='+(settings.eku ?? 'clientAuth')+'\\nsubjectAltName=DNS:'+(settings.name ?? ${JSON.stringify(name)})+(settings.extraSan ? ',DNS:other.gateway.agent-cloud.internal' : '')+'\\n');
  run(['ca','-batch','-notext','-config',extension,'-in',csr,'-out',output,'-startdate',stamp(Date.now()-30000),'-enddate',stamp(Date.now()+(settings.duration ?? 3600000))]);
};
if (args[0] === 'certificate' && args[1] === 'create') {
  run(['req','-new','-key',flag('--key'),'-out',args[3],'-subj','/CN='+args[2],'-config',join(fixture,'root.cnf')]);
} else if (args[0] === 'certificate' && args[1] === 'verify') {
  run(['verify','-purpose','any','-CAfile',flag('--roots'),args[2]]);
} else if (args[0] === 'ca' && args[1] === 'sign') {
  sign(args[2],args[3]);
} else if (args[0] === 'ca' && args[1] === 'renew') {
  if (settings.failRenew) { process.stderr.write('fixture issuer secret must never escape'); process.exit(1); }
  const csr = join(process.cwd(),'renew.csr');
  const subject = new X509Certificate(readFileSync(args[2])).subject.slice(3);
  run(['req','-new','-key',args[3],'-out',csr,'-subj','/CN='+subject,'-config',join(fixture,'root.cnf')]);
  sign(csr,flag('--out'));
} else { process.exit(1); }
`,
    { mode: 0o700 },
  );
  const privateKey = generateGatewayTlsKey();
  const issued = await issueGatewayTls(
    {
      ...configuration(),
      provisioner: 'agent-cloud-gateway',
      provisionerPassword: 'operator-only-fixture-password',
    },
    { name, privateKey },
  ).catch(async (error: unknown) => {
    throw new Error(
      await readFile(join(directory, 'fixture-error'), 'utf8').catch(() => 'Fixture failed'),
      { cause: error },
    );
  });
  identity = { name, privateKey, certificate: issued.certificate, issuedAt: issued.issuedAt };
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('issues a short exact client identity and refuses it as a guest server identity', async () => {
  const leaf = new X509Certificate(identity.certificate);
  expect(leaf.subjectAltName).toBe(`DNS:${name}`);
  expect(leaf.keyUsage).toEqual(['1.3.6.1.5.5.7.3.2']);
  expect(leaf.publicKey.export({ type: 'spki', format: 'der' })).toEqual(
    createPublicKey(identity.privateKey).export({ type: 'spki', format: 'der' }),
  );
  await expect(validateGatewayTls(configuration(), identity)).resolves.toEqual({
    expiresAt: leaf.validToDate.toISOString(),
  });
  expect(() => {
    inspectIssuedTls(leaf, {
      name,
      key: createPublicKey(identity.privateKey),
      timing: { kind: 'installed', issuedAt: Date.parse(identity.issuedAt) },
    });
  }).toThrow('incompatible guest');
  const commands = await readFile(join(directory, 'commands.jsonl'), 'utf8');
  expect(commands).toContain('--not-after');
  expect(commands).not.toContain('operator-only-fixture-password');
});

it('renews the same key through mTLS without provisioner material or inherited secrets', async () => {
  await writeFile(join(directory, 'commands.jsonl'), '');
  const renewed = await renewGatewayTls(configuration(), identity);
  const leaf = new X509Certificate(renewed.certificate);
  expect(leaf.serialNumber).not.toBe(new X509Certificate(identity.certificate).serialNumber);
  expect(leaf.publicKey.export({ type: 'spki', format: 'der' })).toEqual(
    createPublicKey(identity.privateKey).export({ type: 'spki', format: 'der' }),
  );
  const commands = await readFile(join(directory, 'commands.jsonl'), 'utf8');
  expect(commands).toContain('--mtls=true');
  expect(commands).toContain('--out');
  expect(commands).not.toContain('provisioner');
  expect(commands).not.toContain('PASSWORD');
});

it('rejects changed keys, extra names, server permission and excessive lifetime', async () => {
  const timing = {
    kind: 'installed',
    issuedAt: Date.parse(identity.issuedAt),
  } satisfies Parameters<typeof inspectGatewayTls>[0]['timing'];
  expect(() =>
    inspectGatewayTls({ ...identity, privateKey: generateGatewayTlsKey(), timing }),
  ).toThrow('incompatible');
  expect(() => inspectGatewayTls({ ...identity, name: gatewayTlsName('foreign'), timing })).toThrow(
    'incompatible',
  );
  for (const settings of [
    { extraSan: true },
    { eku: 'serverAuth' },
    { eku: 'serverAuth,clientAuth' },
    { duration: 7_200_000 },
  ]) {
    await writeFile(join(directory, 'settings.json'), JSON.stringify(settings));
    await expect(renewGatewayTls(configuration(), identity)).rejects.toThrow('incompatible');
  }
  await writeFile(join(directory, 'settings.json'), '{}');
});

it('rejects an untrusted chain before renewal and sanitizes tool failure without changing the old credential', async () => {
  const otherKey = join(directory, 'other-root.key');
  const otherCert = join(directory, 'other-root.crt');
  await writeFile(otherKey, generateGatewayTlsKey(), { mode: 0o600 });
  await promisify(execFile)(
    '/usr/bin/openssl',
    [
      'req',
      '-x509',
      '-new',
      '-key',
      otherKey,
      '-out',
      otherCert,
      '-days',
      '2',
      '-subj',
      '/CN=Other test root',
      '-config',
      join(directory, 'root.cnf'),
    ],
    { timeout: 5000 },
  );
  await writeFile(join(directory, 'commands.jsonl'), '');
  await expect(
    renewGatewayTls({ ...configuration(), tlsRoot: await readFile(otherCert, 'utf8') }, identity),
  ).rejects.toThrow('tooling failed');
  expect(await readFile(join(directory, 'commands.jsonl'), 'utf8')).not.toContain('"renew"');
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ failRenew: true }));
  const before = JSON.stringify(identity);
  await expect(renewGatewayTls(configuration(), identity)).rejects.toThrow(
    'Gateway certificate tooling failed.',
  );
  expect(JSON.stringify(identity)).toBe(before);
  await writeFile(join(directory, 'settings.json'), '{}');
});

it('rejects guest, wildcard and malformed gateway names before executing certificate tools', async () => {
  for (const id of ['', '*', 'UPPER', 'a.b', '-prefix', 'suffix-', 'a'.repeat(64)])
    expect(() => gatewayTlsName(id)).toThrow();
  await expect(
    issueGatewayTls(
      { ...configuration(), provisioner: 'agent-cloud-control', provisionerPassword: 'unused' },
      { name, privateKey: identity.privateKey },
    ),
  ).rejects.toThrow();
  await expect(
    issueGatewayTls(
      { ...configuration(), provisioner: 'agent-cloud-gateway', provisionerPassword: 'unused' },
      { name: 'alloc-123.guest.agent-cloud.internal', privateKey: identity.privateKey },
    ),
  ).rejects.toThrow();
});

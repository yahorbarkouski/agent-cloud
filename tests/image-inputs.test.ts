import { imageFixture } from './image-fixture.js';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { imageInputsSchema, imageSourcePaths } from '../packages/contracts/dist/index.js';
import {
  createImageManifest,
  digestInputs,
  digestManifest,
  inspectInputs,
  verifyImageInputs,
  imageInstallCommand,
  imageTransferCheck,
} from '../packages/images/dist/index.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agent-cloud-inputs-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

async function checksums() {
  const inputs = imageInputsSchema.parse(
    JSON.parse(await readFile(join(directory, 'image-inputs.json'), 'utf8')),
  );
  const lines = inputs.files.map((file) => `${file.sha256}  ${file.path}`);
  for (const path of ['image-inputs.json', 'image.json'])
    lines.push(`${hash(await readFile(join(directory, path), 'utf8'))}  ${path}`);
  await writeFile(join(directory, 'SHA256SUMS'), lines.join('\n') + '\n');
}

async function stage() {
  const fixture = imageFixture(undefined, 1);
  await mkdir(join(directory, 'artifacts'));
  await mkdir(join(directory, 'systemd'));
  for (const [path, value] of fixture.files) await writeFile(join(directory, path), value);
  const { inputs, manifest, pins, trust } = fixture;
  await writeFile(join(directory, 'image-inputs.json'), JSON.stringify(inputs));
  await writeFile(join(directory, 'image.json'), JSON.stringify(manifest));
  await checksums();
  return { inputs, manifest, digest: digestManifest(manifest), pins, trust };
}

it('reproduces identity independently of directory enumeration and JSON field order', async () => {
  const fixture = await stage();
  expect(await verifyImageInputs(directory, fixture.digest)).toMatchObject({
    manifest: fixture.manifest,
  });
  const manifest = Object.fromEntries(Object.entries(fixture.manifest).reverse());
  await writeFile(join(directory, 'image.json'), JSON.stringify(manifest, null, 2));
  await checksums();
  expect((await verifyImageInputs(directory, fixture.digest)).manifestDigest).toBe(fixture.digest);
  expect(digestInputs(await inspectInputs(directory))).toBe(fixture.manifest.publicInputsDigest);
});

it.each([
  ...imageSourcePaths,
  'guestctl.mjs',
  'trust.json',
  'artifacts.json',
  'artifacts/node.tar.xz',
])('rejects changed %s and gives changed inputs a different identity', async (path) => {
  const fixture = await stage();
  await writeFile(join(directory, path), (await readFile(join(directory, path), 'utf8')) + '\n');
  await expect(verifyImageInputs(directory, fixture.digest)).rejects.toThrow('inventory');
  const changed = await inspectInputs(directory);
  expect(digestInputs(changed)).not.toBe(fixture.manifest.publicInputsDigest);
  if (path === 'artifacts.json' || path === 'trust.json') {
    expect(() => createImageManifest({ ...fixture, inputs: changed })).toThrow('canonical input');
  } else if (path === 'guest-customer.sudoers' || path === 'guest-backup.sudoers') {
    expect(() => createImageManifest({ ...fixture, inputs: changed })).toThrow('sudo policy');
  } else if (!path.startsWith('artifacts/')) {
    const manifest = createImageManifest({ ...fixture, inputs: changed });
    expect(manifest.version).not.toBe(fixture.manifest.version);
    expect(digestManifest(manifest)).not.toBe(fixture.digest);
  } else
    expect(() => createImageManifest({ ...fixture, inputs: changed })).toThrow('pinned checksum');
});

it('rejects a forged self-consistent inventory against the independently admitted digest', async () => {
  const fixture = await stage();
  await writeFile(join(directory, 'install.sh'), 'replaced installer');
  const inputs = await inspectInputs(directory);
  const manifest = createImageManifest({ ...fixture, inputs });
  await writeFile(join(directory, 'image-inputs.json'), JSON.stringify(inputs));
  await writeFile(join(directory, 'image.json'), JSON.stringify(manifest));
  await expect(verifyImageInputs(directory, fixture.digest)).rejects.toThrow('admitted digest');
});

it.each(['missing', 'extra', 'symlink', 'directory-symlink', 'writable', 'empty-directory'])(
  'refuses a %s input tree',
  async (change) => {
    const fixture = await stage();
    const path = join(directory, 'install.sh');
    if (change === 'missing') await rm(path);
    if (change === 'extra')
      await writeFile(join(directory, 'unexpected.key'), 'not an image input');
    if (change === 'symlink') {
      await rm(path);
      await symlink('/etc/passwd', path);
    }
    if (change === 'directory-symlink') {
      await rm(join(directory, 'systemd'), { recursive: true });
      await symlink('/tmp', join(directory, 'systemd'));
    }
    if (change === 'writable') await chmod(path, 0o666);
    if (change === 'empty-directory') await mkdir(join(directory, 'unexpected'));
    await expect(verifyImageInputs(directory, fixture.digest)).rejects.toThrow();
  },
);

it.each([
  '../secret',
  '/etc/passwd',
  'a/../secret',
  'a\\secret',
  'image.json',
  'image-inputs.json',
  'SHA256SUMS',
])('rejects unsafe or self-referential inventory path %s', (path) => {
  expect(
    imageInputsSchema.safeParse({ format: 1, files: [{ path, sha256: hash(path), bytes: 1 }] })
      .success,
  ).toBe(false);
});

it('rejects duplicated or reordered inventory entries and incomplete required inputs', async () => {
  const fixture = await stage();
  expect(
    imageInputsSchema.safeParse({ ...fixture.inputs, files: [...fixture.inputs.files].reverse() })
      .success,
  ).toBe(false);
  expect(
    imageInputsSchema.safeParse({
      ...fixture.inputs,
      files: [...fixture.inputs.files, ...fixture.inputs.files],
    }).success,
  ).toBe(false);
  const inputs = imageInputsSchema.parse({
    ...fixture.inputs,
    files: fixture.inputs.files.filter((file) => file.path !== 'install.sh'),
  });
  expect(() => createImageManifest({ ...fixture, inputs })).toThrow('complete input');
});

it('rejects missing or rewritten transfer checksums even when the manifest still matches', async () => {
  const fixture = await stage();
  await writeFile(join(directory, 'SHA256SUMS'), 'forged transfer inventory\n');
  await expect(verifyImageInputs(directory, fixture.digest)).rejects.toThrow('transfer checksums');
  await rm(join(directory, 'SHA256SUMS'));
  await expect(verifyImageInputs(directory, fixture.digest)).rejects.toThrow();
});

it('binds changed trust and artifact metadata to a new image version', async () => {
  const fixture = await stage();
  const trust = { ...fixture.trust, tlsRoot: 'new-public-root' };
  const pins = { ...fixture.pins, dockerVersion: '2.0.0' };
  await writeFile(join(directory, 'trust.json'), JSON.stringify(trust) + '\n');
  await writeFile(join(directory, 'artifacts.json'), JSON.stringify(pins) + '\n');
  const inputs = await inspectInputs(directory);
  const manifest = createImageManifest({ inputs, pins, trust });
  expect(manifest.version).not.toBe(fixture.manifest.version);
  expect(manifest.components.docker).toBe('2.0.0');
  expect(manifest.trust.tlsRoot).toBe('new-public-root');
  expect(() => createImageManifest({ inputs, pins: fixture.pins, trust })).toThrow(
    'canonical input',
  );
});

it('checks the independently pinned transfer digest with base-system tools before any uploaded code', async () => {
  const fixture = await stage();
  const admitted = await verifyImageInputs(directory, fixture.digest);
  const run = promisify(execFile);
  await run('/bin/sh', [
    '-c',
    imageTransferCheck,
    'verify-transfer',
    directory,
    admitted.checksumDigest,
  ]);
  await writeFile(
    join(directory, 'install.sh'),
    'printf attacker-code-ran > "$1/attacker-marker"\n',
  );
  await writeFile(join(directory, 'guestctl.mjs'), 'process.exit(0);');
  await writeFile(join(directory, 'artifacts/node.tar.xz'), 'substituted runtime');
  await writeFile(
    join(directory, 'image-inputs.json'),
    JSON.stringify(await inspectInputs(directory)),
  );
  await writeFile(join(directory, 'image.json'), JSON.stringify({ forged: true }));
  await checksums();
  await expect(
    run(
      '/bin/sh',
      imageInstallCommand({
        directory,
        builderId: '00000000-0000-0000-0000-000000000000',
        manifestDigest: admitted.manifestDigest,
        checksumDigest: admitted.checksumDigest,
      }).slice(1),
    ),
  ).rejects.toThrow();
  await expect(readFile(join(directory, 'attacker-marker'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('rejects an unlisted extra file before executing the pinned installer', async () => {
  const fixture = await stage();
  const admitted = await verifyImageInputs(directory, fixture.digest);
  await writeFile(join(directory, 'artifacts/unlisted.deb'), 'not admitted');
  await expect(
    promisify(execFile)('/bin/sh', [
      '-c',
      imageTransferCheck,
      'verify-transfer',
      directory,
      admitted.checksumDigest,
    ]),
  ).rejects.toThrow();
});

it('preserves historical enrollment-only image identity and rejects a partial renewal unit set', () => {
  const fixture = imageFixture();
  const inputs = {
    ...fixture.inputs,
    files: fixture.inputs.files.filter(
      (file) => !file.path.startsWith('systemd/agent-cloud-renew.'),
    ),
  };
  const old = createImageManifest({ ...fixture, inputs });
  expect(old.publicInputsDigest).toBe(digestInputs(inputs));
  expect(old.version).not.toBe(fixture.manifest.version);
  const partial = {
    ...fixture.inputs,
    files: fixture.inputs.files.filter((file) => file.path !== 'systemd/agent-cloud-renew.timer'),
  };
  expect(() => createImageManifest({ ...fixture, inputs: partial })).toThrow('complete input set');
});

it('authenticates the customer capability and preserves absent markers in historical manifests', () => {
  const historical = imageFixture();
  expect(historical.manifest).not.toHaveProperty('customerSsh');
  const customer = imageFixture(undefined, 1);
  expect(customer.manifest.customerSsh).toBe(1);
  expect(digestManifest(customer.manifest)).not.toBe(digestManifest(historical.manifest));
  expect(() =>
    createImageManifest({
      ...customer,
      inputs: {
        ...customer.inputs,
        files: customer.inputs.files.filter(
          (file) => file.path !== 'systemd/agent-cloud-renew.timer',
        ),
      },
    }),
  ).toThrow('complete input');
});

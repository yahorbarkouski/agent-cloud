import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';
import { promisify } from 'node:util';
import { packageCli } from './support/packaged-cli.mjs';

const directory = await mkdtemp(join(tmpdir(), 'agent-cloud-instructions-'));
try {
  const canonical = await readFile(
    new URL('../skills/agent-cloud/SKILL.md', import.meta.url),
    'utf8',
  );
  const cli = await packageCli(directory);
  const run = (args) =>
    promisify(execFile)(process.execPath, [cli, 'agent', ...args], {
      cwd: directory,
      env: { ACLD_CREDENTIALS: join(directory, 'no-credential') },
      timeout: 10_000,
      maxBuffer: 131_072,
    });
  const instructions = JSON.parse((await run(['instructions'])).stdout);
  assert.equal(instructions.markdown, canonical);
  assert.equal(instructions.sha256, createHash('sha256').update(canonical).digest('hex'));
  assert.equal(instructions.version, '0.1.0');
  assert.match(instructions.markdown, /^---\nname: agent-cloud\n/);
  assert.doesNotMatch(
    instructions.markdown,
    /\]\(\.\.\//,
    'Installed instructions must not link outside their package.',
  );
  const target = join(directory, 'agent-cloud');
  const receipt = JSON.parse((await run(['install', '--directory', target])).stdout);
  assert.equal(receipt.path, join(target, 'SKILL.md'));
  assert.equal(receipt.sha256, instructions.sha256);
  assert.equal(await readFile(receipt.path, 'utf8'), canonical);
  assert.equal((await stat(target)).mode & 0o777, 0o700);
  assert.equal((await stat(receipt.path)).mode & 0o777, 0o600);
  const edited = canonical + '\nCustomer-specific operating rules.\n';
  await writeFile(receipt.path, edited);
  await assert.rejects(run(['install', '--directory', target]));
  assert.equal(await readFile(receipt.path, 'utf8'), edited);
  const linked = join(directory, 'linked');
  await symlink(target, linked);
  await assert.rejects(run(['install', '--directory', linked]));
  assert.equal(await readFile(receipt.path, 'utf8'), edited);
  process.stdout.write(
    JSON.stringify({
      result: 'passed',
      verified: [
        'production CLI outside checkout without credentials',
        'canonical bundled instructions and digest',
        'private skill installation',
        'existing edits and symlink targets preserved',
      ],
    }) + '\n',
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
await assert.rejects(stat(directory), { code: 'ENOENT' });
process.stdout.write('{"fixtureCleanupVerified":true}\n');

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { SignerConfiguration } from '../../packages/pki/src/index.js';

/** A fresh local authority with its own keys, database and bounded container. */
export async function withCaFixture<T>(
  work: (input: {
    configuration: SignerConfiguration;
    scratch: string;
    run: (binary: string, args: string[]) => Promise<string>;
  }) => Promise<T>,
) {
  const scratch = await mkdtemp(resolve('.local/customer-pki-'));
  const name = `agent-cloud-customer-pki-${randomUUID()}`;
  const local = join(scratch, '.local');
  const pki = join(local, 'pki');
  const binary = join(local, 'tools/step-0.30.6');
  const run = async (command: string, args: string[]) => {
    try {
      return (
        await promisify(execFile)(command, args, {
          cwd: scratch,
          env: { ...process.env, STEPPATH: join(scratch, 'client'), LANG: 'C' },
          timeout: 30_000,
          maxBuffer: 64 * 1024,
        })
      ).stdout;
    } catch {
      throw new Error('Disposable CA subprocess failed.');
    }
  };
  let started = false;
  try {
    await mkdir(join(local, 'tools'), { recursive: true, mode: 0o700 });
    await cp(resolve('.local/tools/step-0.30.6'), binary);
    await cp(resolve('infra/pki'), join(scratch, 'infra/pki'), { recursive: true });
    await run(process.execPath, [resolve('scripts/setup-pki.ts')]);
    // Set before submission so an ambiguous Docker response still requires exact-name cleanup.
    started = true;
    await run('docker', [
      'run',
      '--detach',
      '--name',
      name,
      '--label',
      'agent-cloud.test=customer-pki',
      '--memory',
      '256m',
      '--cpus',
      '0.5',
      '--cap-drop',
      'ALL',
      '--cap-add',
      'NET_BIND_SERVICE',
      '--security-opt',
      'no-new-privileges:true',
      '--user',
      `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      '--publish',
      '127.0.0.1::9000',
      '--mount',
      `type=bind,source=${join(pki, 'issuer')},target=/home/step`,
      '--entrypoint',
      'step-ca',
      'smallstep/step-ca:0.30.2@sha256:a2b17872915c193259b75a5474c398326f41bd199f0842093e52cf4182bc8270',
      '/home/step/config/ca.json',
      '--password-file',
      '/home/step/password',
    ]);
    const published = (await run('docker', ['port', name, '9000/tcp'])).trim();
    const port = /^127\.0\.0\.1:(\d+)$/.exec(published)?.[1];
    assert.ok(port, 'Expected a loopback-only CA port.');
    const caUrl = `https://localhost:${port}`;
    let healthy = false;
    const healthDeadline = Date.now() + 20_000;
    for (let attempt = 0; attempt < 40 && Date.now() < healthDeadline; attempt++) {
      try {
        await run(binary, [
          'ca',
          'health',
          '--ca-url',
          caUrl,
          '--root',
          join(pki, 'public/root_ca.crt'),
        ]);
        healthy = true;
        break;
      } catch {
        await setTimeout(250);
      }
    }
    assert.ok(healthy, 'Disposable CA did not become healthy.');
    return await work({
      scratch,
      run,
      configuration: {
        binary,
        caUrl,
        tlsRoot: await readFile(join(pki, 'public/root_ca.crt'), 'utf8'),
        sshHostCa: (await readFile(join(pki, 'public/ssh_host_ca_key.pub'), 'utf8')).trim(),
        sshUserCa: (await readFile(join(pki, 'public/ssh_user_ca_key.pub'), 'utf8')).trim(),
        provisioner: 'agent-cloud-control',
        provisionerPassword: await readFile(join(pki, 'provisioner-password'), 'utf8'),
      },
    });
  } finally {
    if (started) {
      const retained = (
        await run('docker', ['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'])
      ).trim();
      if (retained) {
        assert.equal(retained, name);
        let tokensAbsent: boolean;
        try {
          const logs = await promisify(execFile)('docker', ['logs', name], {
            timeout: 5000,
            maxBuffer: 256 * 1024,
          }).catch(() => {
            throw new Error('Could not verify disposable CA logging.');
          });
          tokensAbsent = !/(?:ott[=:]|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.test(
            logs.stdout + logs.stderr,
          );
        } finally {
          await run('docker', ['rm', '--force', name]);
          await rm(scratch, { recursive: true, force: true });
        }
        assert.ok(tokensAbsent, 'Disposable CA service output exposed a signing token.');
      } else await rm(scratch, { recursive: true, force: true });
    } else await rm(scratch, { recursive: true, force: true });
  }
}

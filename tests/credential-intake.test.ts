import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import { request } from 'node:http';
import { z } from 'zod';
import { expect, it } from 'vitest';

const helper = resolve('scripts/receive-hetzner-token.ts');
const fakeToken = 'fake-test-credential-never-valid-at-a-provider';

async function start(directory: string) {
  const child = spawn(process.execPath, [helper], {
    cwd: directory,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  const lines = createInterface({ input: child.stdout });
  const [line] = z.tuple([z.string()]).parse(await once(lines, 'line'));
  const { setupUrl } = z.object({ setupUrl: z.url() }).parse(JSON.parse(z.string().parse(line)));
  lines.close();
  return { child, exited, setupUrl, output: () => output };
}

it('saves one owner-only credential through a real loopback form without printing it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-cloud-intake-'));
  const intake = await start(directory);
  try {
    const page = await fetch(intake.setupUrl);
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(await page.text()).toContain('type="password"');
    expect(
      (await fetch(intake.setupUrl, { method: 'POST', body: `token=${fakeToken}` })).status,
    ).toBe(403);
    expect(
      (
        await fetch(intake.setupUrl, {
          method: 'POST',
          headers: { Origin: 'https://attacker.example' },
          body: `token=${fakeToken}`,
        })
      ).status,
    ).toBe(403);
    const headers = { Origin: new URL(intake.setupUrl).origin };
    expect(
      (await fetch(intake.setupUrl, { method: 'POST', headers, body: 'token=short' })).status,
    ).toBe(400);
    expect(
      (await fetch(intake.setupUrl, { method: 'POST', headers, body: `token=${'x'.repeat(2050)}` }))
        .status,
    ).toBe(413);
    const wrongHost = await new Promise<number | undefined>((resolveResponse, reject) => {
      const outgoing = request(
        intake.setupUrl,
        { headers: { Host: 'attacker.example' } },
        (response) => {
          response.resume();
          resolveResponse(response.statusCode);
        },
      );
      outgoing.once('error', reject);
      outgoing.end();
    });
    expect(wrongHost).toBe(404);
    // Two in-flight POSTs can pass the initial consumed check before either body ends.
    const slow = request(intake.setupUrl, {
      method: 'POST',
      headers: { ...headers, Expect: '100-continue' },
    });
    const slowStatus = new Promise<number | undefined>((resolveResponse, reject) => {
      slow.once('response', (response) => {
        response.resume();
        resolveResponse(response.statusCode);
      });
      slow.once('error', reject);
    });
    const ready = once(slow, 'continue');
    slow.flushHeaders();
    await ready;
    slow.write('token=');
    const saved = await fetch(intake.setupUrl, {
      method: 'POST',
      headers,
      body: `token=${fakeToken}`,
    });
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain(fakeToken);
    slow.end('another-fake-credential-that-must-not-be-stored');
    expect(await slowStatus).toBe(409);
    const file = join(directory, '.local/hcloud-token');
    expect(await readFile(file, 'utf8')).toBe(`${fakeToken}\n`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await intake.exited)[0]).toBe(0);
    expect(intake.output()).not.toContain(fakeToken);
  } finally {
    intake.child.kill();
    await rm(directory, { recursive: true, force: true });
  }
});

it('refuses to overwrite an existing credential before opening a listener', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-cloud-intake-existing-'));
  try {
    await mkdir(join(directory, '.local'), { mode: 0o700 });
    const file = join(directory, '.local/hcloud-token');
    await writeFile(file, fakeToken, { mode: 0o600 });
    const child = spawn(process.execPath, [helper], {
      cwd: directory,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    expect((await once(child, 'exit'))[0]).toBe(1);
    expect(output).toContain('refusing to replace');
    expect(output).not.toContain(fakeToken);
    expect(output).not.toContain('setupUrl');
    expect(await readFile(file, 'utf8')).toBe(fakeToken);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('rejects a .local symlink before accepting or writing a token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-cloud-intake-link-'));
  const outside = await mkdtemp(join(tmpdir(), 'agent-cloud-intake-outside-'));
  try {
    await symlink(outside, join(directory, '.local'));
    const child = spawn(process.execPath, [helper], {
      cwd: directory,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    expect((await once(child, 'exit'))[0]).toBe(1);
    expect(output).toContain('real owner-only directory');
    expect(output).not.toContain('setupUrl');
    await expect(stat(join(outside, 'hcloud-token'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { z } from 'zod';

it.each(['container', 'volume', 'network', 'image'])(
  'refuses a pre-existing %s without invoking mutation or cleanup',
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), 'acld-collision-'));
    const log = join(directory, 'commands.jsonl');
    try {
      // A protocol fixture reports an existing object. No Docker daemon or real resource is touched.
      await writeFile(
        join(directory, 'docker'),
        `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(args) + '\\n');\nif (args[0] === process.env.FIXTURE_KIND && args[1] === 'ls') process.stdout.write('pre-existing-resource\\n');\n`,
        { mode: 0o700 },
      );
      await expect(
        promisify(execFile)(process.execPath, [resolve('scripts/self-host-smoke.mjs')], {
          env: { PATH: directory, FIXTURE_KIND: kind, FIXTURE_LOG: log },
          timeout: 10_000,
        }),
      ).rejects.toMatchObject({ code: 1 });
      const commands = (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => z.array(z.string()).parse(JSON.parse(line)));
      expect(commands.length).toBeGreaterThan(0);
      for (const command of commands) expect(command[1]).toBe('ls');
      expect(commands.at(-1)?.[0]).toBe(kind);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

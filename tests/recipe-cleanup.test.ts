import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';

it.each(['ps', 'network', 'volume'])(
  'refuses a pre-existing recipe %s before Compose or cleanup',
  async (kind) => {
    const scratch = await mkdtemp(join(tmpdir(), 'acld-recipe-collision-'));
    try {
      const log = join(scratch, 'calls');
      await writeFile(
        join(scratch, 'docker'),
        `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === ${JSON.stringify(kind)}) process.stdout.write('pre-existing-fixture\\n');
`,
        { mode: 0o700 },
      );
      const result = await new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
        execFile(
          process.execPath,
          ['--import', 'tsx', 'recipes/smoke.mjs', 'postgres'],
          {
            // This subprocess needs only executables, not inherited worker hooks or credentials.
            env: { PATH: `${scratch}:${process.env.PATH ?? ''}` },
            timeout: 30_000,
            maxBuffer: 65_536,
          },
          (error, stdout, stderr) => {
            done({ code: error ? 1 : 0, stdout, stderr });
          },
        );
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('project ownership');
      const calls: unknown = (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map((line): unknown => JSON.parse(line));
      expect(calls).toEqual([
        [
          'ps',
          '-aq',
          '--no-trunc',
          '--filter',
          expect.stringMatching(/^label=com\.docker\.compose\.project=acld-recipe-[a-f0-9-]{36}$/),
        ],
        ...(kind !== 'ps'
          ? [['network', 'ls', '-q', '--no-trunc', '--filter', expect.any(String)]]
          : []),
        ...(kind === 'volume' ? [['volume', 'ls', '-q', '--filter', expect.any(String)]] : []),
      ]);
      expect(result.stdout).toContain('"temporaryFilesRemoved":true');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);

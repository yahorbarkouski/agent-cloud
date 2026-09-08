import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { z } from 'zod';

it.each(['container', 'network', 'volume'])(
  'refuses a pre-existing gateway %s without starting or deleting resources',
  async (kind) => {
    const result = await promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
import { verifyPackagedGateway } from './scripts/support/packaged-gateway.mjs';
const calls = [];
let refused = false;
try {
  await verifyPackagedGateway({ image: 'unused-fixture', docker: async (args) => {
    calls.push(args);
    return args[0] === ${JSON.stringify(kind)} ? 'pre-existing' : '';
  } });
} catch { refused = true; }
process.stdout.write(JSON.stringify({ refused, calls }));
`,
      ],
      { timeout: 5000, env: {}, maxBuffer: 16_384 },
    );
    const checked = z
      .object({ refused: z.boolean(), calls: z.array(z.array(z.string())) })
      .parse(JSON.parse(result.stdout));
    expect(checked.refused).toBe(true);
    expect(checked.calls.length).toBeGreaterThan(0);
    for (const call of checked.calls) {
      expect(call[1]).toBe('ls');
      expect(call.at(-1)).toMatch(
        /^label=com\.docker\.compose\.project=acld-gateway-[a-f0-9-]{36}$/,
      );
    }
    expect(checked.calls.at(-1)?.[0]).toBe(kind);
    expect(result.stderr).toBe('');
  },
);

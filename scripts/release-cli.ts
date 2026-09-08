import { parseArgs } from 'node:util';
import { buildCliRelease } from './support/cli-release.js';

try {
  const { values } = parseArgs({
    options: { output: { type: 'string' } },
    allowPositionals: false,
  });
  if (!values.output) throw new Error('Use --output with a new release directory.');
  process.stdout.write(JSON.stringify(await buildCliRelease(values.output)) + '\n');
} catch {
  process.stderr.write(
    'CLI release failed. Use a new output directory and a built checkout; inspect any partial output before retrying.\n',
  );
  process.exitCode = 1;
}

import { resolve } from 'node:path';
import { initializeRuntimeIdentity } from '../apps/control/dist/runtime-identity.js';

try {
  const [directory, ...extra] = process.argv.slice(2);
  if (!directory || extra.length) throw new Error('A single identity directory is required.');
  process.stdout.write(JSON.stringify(await initializeRuntimeIdentity(resolve(directory))) + '\n');
} catch {
  process.stderr.write(
    JSON.stringify({
      error:
        'Runtime identity setup failed. Supply one directory; existing or partial identities are never replaced.',
    }) + '\n',
  );
  process.exitCode = 1;
}

#!/usr/bin/env node
import { guestBootProofSchema, referenceCommandSchema } from '@agent-cloud/contracts';
import { createReferenceDeployment, referenceSystem } from './reference.js';
import { startReferenceApp } from './reference-app.js';
import { renewGuest } from './renewal.js';
import { enrollGuest } from './enrollment.js';
import { readOwnedFile } from './files.js';
import { guestSystem } from './system.js';
import { inspectRuntime } from './inspect.js';
import { prepareImage } from './image.js';
import { verifyImageInputs } from '@agent-cloud/images';

const configuration = {
  state: '/var/lib/agent-cloud',
  manifest: '/usr/lib/agent-cloud/image.json',
  binary: '/usr/lib/agent-cloud/guestctl.mjs',
  step: '/usr/local/bin/step',
  keygen: '/usr/bin/ssh-keygen',
};
try {
  if (process.argv[2] === 'reference-app' && process.argv.length === 3) {
    await startReferenceApp();
  } else if (['reference', 'reference-work'].includes(process.argv[2] ?? '')) {
    if (process.getuid?.() !== 0 || process.argv[3] !== '--json' || process.argv.length !== 4)
      throw new Error('Reference administration requires its fixed root command.');
    const deployment = createReferenceDeployment({
      directory: '/var/lib/agent-cloud/reference',
      binary: configuration.binary,
      system: referenceSystem,
    });
    if (process.argv[2] === 'reference-work') await deployment.work();
    else {
      let body = '';
      for await (const chunk of process.stdin) {
        body += String(chunk);
        if (Buffer.byteLength(body) > 4096) throw new Error('Reference request too large.');
      }
      const result = await deployment.command(referenceCommandSchema.parse(JSON.parse(body)));
      process.stdout.write(JSON.stringify(result) + '\n');
    }
  } else {
    if (process.argv[2] === 'verify-inputs') {
      const [, directory, digest, format, ...extra] = process.argv.slice(2);
      if (!directory || !digest || format !== '--json' || extra.length)
        throw new Error('Input verification requires a directory and admitted digest.');
      const { manifestDigest } = await verifyImageInputs(directory, digest);
      process.stdout.write(JSON.stringify({ kind: 'verified', manifestDigest }) + '\n');
      process.exit(0);
    }
    const [command, format, ...extra] = process.argv.slice(2);
    if (
      format !== '--json' ||
      extra.length ||
      !['identity', 'enroll', 'renew', 'inspect', 'prepare-image'].includes(command ?? '')
    )
      throw new Error('Unsupported guest command.');
    if (command === 'identity') {
      const proof = guestBootProofSchema.parse(
        JSON.parse(await readOwnedFile('/var/lib/agent-cloud/proof.json', 'public', 65_536, 0)),
      );
      process.stdout.write(JSON.stringify(proof) + '\n');
    } else {
      if (process.getuid?.() !== 0) throw new Error('Guest administration requires root.');
      const result =
        command === 'prepare-image'
          ? await prepareImage(configuration)
          : command === 'renew'
            ? await renewGuest({ configuration, system: guestSystem(configuration) })
            : command === 'inspect'
              ? await inspectRuntime(configuration)
              : await enrollGuest({ configuration, system: guestSystem(configuration) });
      process.stdout.write(JSON.stringify(result) + '\n');
    }
  }
} catch {
  process.stderr.write(
    JSON.stringify({
      error: 'guest_command_failed',
      statusFile: '/var/lib/agent-cloud/enrollment-status.json',
    }) + '\n',
  );
  process.exitCode = 1;
}

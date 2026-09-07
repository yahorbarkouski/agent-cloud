#!/usr/bin/env node
import {
  guestBootProofSchema,
  referenceCommandSchema,
  runCommandSchema,
  runIdSchema,
  CloudError,
  composeCommandSchema,
  composeAppSchema,
} from '@agent-cloud/contracts';
import { createComposeDeployments } from './compose.js';
import { composeSystem } from './compose-system.js';
import { readJsonInput } from './input.js';
import { createGuestRuns, runSystem } from './runs.js';
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
  if (['compose', 'compose-work', 'compose-wait'].includes(process.argv[2] ?? '')) {
    if (process.getuid?.() !== 0) throw new Error('Compose administration requires root.');
    const deployment = createComposeDeployments({
      directory: '/var/lib/agent-cloud/compose',
      system: composeSystem,
    });
    if (process.argv[2] === 'compose-wait') {
      if (process.argv[4] !== '--json' || process.argv.length !== 5)
        throw new Error('Invalid wait arguments.');
      process.stdout.write(
        JSON.stringify(await deployment.wait(composeAppSchema.parse(process.argv[3]))) + '\n',
      );
    } else {
      if (process.argv[3] !== '--json' || process.argv.length !== 4)
        throw new Error('Invalid Compose arguments.');
      if (process.argv[2] === 'compose-work') await deployment.work();
      else {
        process.stdout.write(
          JSON.stringify(
            await deployment.command(
              composeCommandSchema.parse(await readJsonInput(process.stdin, 16_777_216)),
            ),
          ) + '\n',
        );
      }
    }
  } else if (process.argv[2] === 'run' || process.argv[2] === 'run-work') {
    if (process.getuid?.() !== 0) throw new Error('Durable commands require root.');
    const runs = createGuestRuns({ directory: '/var/lib/agent-cloud/runs', system: runSystem });
    if (process.argv[2] === 'run-work') {
      if (process.argv[4] !== '--json' || process.argv.length !== 5)
        throw new Error('Invalid worker arguments.');
      await runs.work(runIdSchema.parse(process.argv[3]));
    } else {
      if (process.argv[3] !== '--json' || process.argv.length !== 4)
        throw new Error('Invalid command arguments.');
      const result = await runs.command(
        runCommandSchema.parse(await readJsonInput(process.stdin, 262_144)),
      );
      process.stdout.write(JSON.stringify(result) + '\n');
    }
  } else if (process.argv[2] === 'reference-app' && process.argv.length === 3) {
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
      const result = await deployment.command(
        referenceCommandSchema.parse(await readJsonInput(process.stdin, 4096)),
      );
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
} catch (error) {
  if (
    ['run', 'compose', 'compose-wait'].includes(process.argv[2] ?? '') &&
    error instanceof CloudError
  ) {
    // Expected command outcomes belong to the reply channel. SSH may add its own
    // diagnostics to stderr, so it cannot carry an unambiguous application reply.
    process.stdout.write(JSON.stringify({ error: error.failure }) + '\n');
  } else {
    process.stderr.write(
      JSON.stringify({
        error: 'guest_command_failed',
        statusFile: '/var/lib/agent-cloud/enrollment-status.json',
      }) + '\n',
    );
    process.exitCode = 1;
  }
}

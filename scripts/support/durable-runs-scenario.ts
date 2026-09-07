import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { runResponseSchema } from '../../packages/contracts/dist/index.js';

export async function exerciseDurableRuns(input: {
  machine: string;
  credentials: string;
  ownerCredentials: string;
  scratch: string;
  cli: (
    args: string[],
    credentials: string,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  vm: (args: string[], timeout?: number) => Promise<string>;
  reboot: () => Promise<void>;
}) {
  const requestFile = join(input.scratch, 'run-request.json');
  async function invoke(args: string[], credentials = input.credentials) {
    const result = await input.cli(['run', ...args], credentials);
    assert.equal(result.code, 0, result.stderr.slice(0, 2000));
    return runResponseSchema.parse(JSON.parse(result.stdout));
  }
  async function submit(
    id: string,
    code: string,
    timeoutSeconds = 30,
    credentials = input.credentials,
  ) {
    await writeFile(
      requestFile,
      JSON.stringify({
        argv: ['/usr/local/bin/node', '-e', code],
        timeoutSeconds,
      }),
      { mode: 0o600 },
    );
    return invoke(['submit', input.machine, '--id', id, '--request', requestFile], credentials);
  }
  const id = randomUUID();
  const effect = `/var/lib/agent-customer/run-${id}.txt`;
  const code = `setTimeout(() => { require('node:fs').appendFileSync(${JSON.stringify(effect)}, 'once\\n'); process.stdout.write('durable output\\n'); }, 3000)`;
  await submit(id, code);
  // The actual CLI process exited while the admitted service is still running.
  await input.vm(['systemctl', 'is-active', '--quiet', `agent-cloud-run@${id}.service`]);
  await submit(id, code);
  await setTimeout(3200);
  assert.deepEqual((await invoke(['inspect', input.machine, id])).run.state.kind, 'exited');
  const logs = await invoke(['logs', input.machine, id]);
  assert.equal(logs.logs.map((entry) => entry.text).join(''), 'durable output\n');
  assert.equal(await input.vm(['cat', effect]), 'once\n');
  await writeFile(requestFile, JSON.stringify({ argv: ['/bin/false'] }), { mode: 0o600 });
  const conflict = await input.cli(
    ['run', 'submit', input.machine, '--id', id, '--request', requestFile],
    input.credentials,
  );
  assert.notEqual(conflict.code, 0);
  assert.ok(conflict.stderr.includes('idempotency_conflict'));

  const cancelled = randomUUID();
  await submit(cancelled, 'setInterval(() => {}, 1000)');
  assert.equal((await invoke(['cancel', input.machine, cancelled])).run.state.kind, 'terminated');
  assert.partialDeepStrictEqual((await invoke(['inspect', input.machine, cancelled])).run.state, {
    kind: 'terminated',
    reason: 'cancelled',
  });

  const timeout = randomUUID();
  const pidFile = `/var/lib/agent-customer/helper-${timeout}.pid`;
  await submit(
    timeout,
    `const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: ['ignore', 1, 2] }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); setInterval(() => {}, 1000)`,
    1,
    input.ownerCredentials,
  );
  await setTimeout(5000);
  assert.partialDeepStrictEqual(
    (await invoke(['inspect', input.machine, timeout], input.ownerCredentials)).run.state,
    { kind: 'terminated', reason: 'timeout' },
  );
  const helperPid = (await input.vm(['cat', pidFile])).trim();
  assert.match(helperPid, /^[1-9][0-9]*$/);
  await input.vm(['test', '!', '-e', `/proc/${helperPid}`]);

  const interrupted = randomUUID();
  await submit(interrupted, 'setInterval(() => {}, 1000)', 60, input.ownerCredentials);
  await input.vm(['systemctl', 'is-active', '--quiet', `agent-cloud-run@${interrupted}.service`]);
  await input.reboot();
  for (let attempt = 0; attempt < 30; attempt++) {
    if (
      (await input.vm(['/bin/sh', '-c', 'systemctl is-active ssh.service || true'])).trim() ===
      'active'
    )
      break;
    assert.ok(attempt < 29, 'Guest SSH did not restart before the fixture deadline.');
    await setTimeout(1000);
  }
  const before = await invoke(['inspect', input.machine, interrupted], input.ownerCredentials);
  assert.partialDeepStrictEqual(before.run.state, { kind: 'terminated', reason: 'interrupted' });
  // Replay after reboot returns the durable terminal state rather than executing again.
  const replay = await submit(
    interrupted,
    'setInterval(() => {}, 1000)',
    60,
    input.ownerCredentials,
  );
  assert.deepEqual(replay.run.state, before.run.state);
  process.stdout.write(
    JSON.stringify({
      result: 'durable-runs-locally-verified',
      provider: 'simulated',
      vm: 'native Ubuntu',
      cliDisconnectedBeforeCompletion: true,
      duplicateExecutedOnce: true,
      outputRecovered: true,
      conflictDenied: true,
      cancellation: true,
      timeoutReapedDetachedHelper: true,
      rebootInterruptedWithoutReplay: true,
    }) + '\n',
  );
}

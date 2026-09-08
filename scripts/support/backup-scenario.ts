import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request } from 'node:https';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import {
  backupResponseSchema,
  backupScheduleResponseSchema,
  restoreResponseSchema,
  machineResponseSchema,
  operationResponseSchema,
  usageResponseSchema,
  routeResponseSchema,
  composeResponseSchema,
} from '../../packages/contracts/dist/index.js';
import { exerciseCompose } from './compose-scenario.js';
import type { prepareBackupStoreFixture } from './backup-store-fixture.js';

/** CLI/API/Graphile → verified source SSH → encrypted protected S3 → newly provisioned isolated guest. */
export async function exerciseBackups(input: {
  machine: string;
  credentials: string;
  ownerCredentials: string;
  scratch: string;
  address: string;
  vm: (args: string[], timeout?: number) => Promise<string>;
  cli: (
    args: string[],
    credentials: string,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  rotateWrappingKey: () => Promise<void>;
  keyRecovery: Awaited<ReturnType<typeof prepareBackupStoreFixture>>['keyRecovery'];
  hosting?: { gatewayState: string; httpsPort: number };
}) {
  const progress = (phase: string) =>
    process.stdout.write(JSON.stringify({ phase, cloudResourcesCreated: 0 }) + '\n');
  const cli = async (args: string[], credentials = input.credentials) => {
    const result = await input.cli(args, credentials);
    assert.equal(result.code, 0, result.stderr.slice(0, 1500) + result.stdout.slice(0, 2000));
    return result.stdout;
  };
  const route = input.hosting
    ? routeResponseSchema.parse(
        JSON.parse(
          await cli([
            'route',
            'publish',
            input.machine,
            '--name',
            'recovery',
            '--port',
            '30080',
            '--key',
            randomUUID(),
          ]),
        ),
      ).route
    : undefined;
  if (route) await cli(['route', 'wait', route.hostname]);
  const hostname = route?.hostname ?? 'customer.localhost';
  progress('deploying source reference application through customer Compose CLI');
  const source = await exerciseCompose({
    ...input,
    initialOnly: true,
    hostname,
    serveHttp: Boolean(route),
  });
  const publicRequest = async (method = 'GET') => {
    const hosting = input.hosting;
    assert.ok(hosting && route);
    let ca = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        ca = await readFile(
          join(hosting.gatewayState, 'certificates/pki/authorities/local/root.crt'),
          'utf8',
        );
        break;
      } catch (error) {
        if (attempt === 19) throw error;
        await setTimeout(500);
      }
    }
    return new Promise<unknown>((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: hosting.httpsPort,
          servername: hostname,
          ca,
          path: '/api/visits',
          method,
          headers: { Host: hostname, Origin: `https://${hostname}` },
          timeout: 10000,
        },
        (response) => {
          let body = '';
          response.on('data', (chunk: Buffer) => {
            body += chunk.toString();
            if (body.length > 65536)
              response.destroy(new Error('Oversized restored application reply.'));
          });
          response.once('error', reject);
          response.once('end', () => {
            try {
              assert.equal(response.statusCode, 200);
              resolve(JSON.parse(body));
            } catch (error) {
              reject(
                error instanceof Error ? error : new Error('Invalid restored application reply.'),
              );
            }
          });
        },
      );
      req.once('error', reject);
      req.once('timeout', () => req.destroy(new Error('Restored public application timed out.')));
      req.end();
    });
  };
  if (route) assert.deepEqual(await publicRequest(), { revision: '1', count: '1' });
  const declared = join(input.scratch, 'declared.txt');
  const content = `declared backup data ${randomUUID()}\n`;
  await writeFile(declared, content, { mode: 0o600 });
  await cli(['file', 'put', input.machine, declared, '/var/lib/agent-customer/declared.txt']);
  const scheduled = process.env.AGENT_CLOUD_BACKUP_SCHEDULE_SCENARIO === '1';
  let backupId: string = randomUUID();
  const scheduleId = backupId;
  progress('capturing PostgreSQL and declared files into protected encrypted S3');
  const captureArguments = [
    'backup',
    scheduled ? 'schedule' : 'capture',
    input.machine,
    'sample',
    '--id',
    backupId,
    '--release',
    source.releaseId,
    '--service',
    'database',
    '--database',
    'reference',
    '--user',
    'reference',
    '--files',
    'declared.txt',
  ];
  const admission: unknown = JSON.parse(await cli(captureArguments));
  if (scheduled) {
    let schedule = backupScheduleResponseSchema.parse(admission).schedule;
    assert.equal(schedule.id, scheduleId);
    progress('CLI exited; waiting for the real worker cron to admit its first daily capture');
    const deadline = Date.now() + 90_000;
    while (schedule.lastAttempt.kind === 'none' && Date.now() < deadline) {
      await setTimeout(1000);
      schedule = backupScheduleResponseSchema.parse(
        JSON.parse(await cli(['backup', 'schedule-inspect', scheduleId])),
      ).schedule;
    }
    assert.equal(schedule.lastAttempt.kind, 'admitted');
    backupId = schedule.lastAttempt.backup.id;
  } else assert.equal(backupResponseSchema.parse(admission).backup.id, backupId);
  // The admission CLI exits; the worker performs capture independently of that process.
  const captured = backupResponseSchema.parse(
    JSON.parse(await cli(['backup', 'wait', backupId, '--timeout', '900'])),
  );
  assert.equal(captured.backup.state.kind, 'captured');
  if (scheduled) {
    const replay = backupScheduleResponseSchema.parse(
      JSON.parse(await cli(captureArguments)),
    ).schedule;
    assert.equal(replay.lastSuccessfulBackup?.id, backupId);
    assert.equal(replay.lastAttempt.kind, 'admitted');
    const disabled = backupScheduleResponseSchema.parse(
      JSON.parse(await cli(['backup', 'schedule-disable', scheduleId])),
    ).schedule;
    assert.equal(disabled.state.kind, 'disabled');
    assert.equal(disabled.lastSuccessfulBackup?.id, backupId);
  } else
    assert.equal(
      backupResponseSchema.parse(JSON.parse(await cli(captureArguments))).backup.id,
      backupId,
    );
  assert.deepEqual(JSON.parse(await source.application('/api/visits')), {
    revision: '1',
    count: '1',
  });
  assert.equal(await input.vm(['cat', '/var/lib/agent-customer/declared.txt']), content);
  // Reading an older versioned key must survive rotation before the isolated restore starts.
  await input.rotateWrappingKey();
  await input.keyRecovery.loseActive();
  const restoreId = randomUUID();
  progress('admitting a separate isolated restore VM through customer backup CLI');
  const restoreArguments = [
    'backup',
    'restore',
    backupId,
    'recovered',
    '--id',
    restoreId,
    '--name',
    'native-recovered',
    '--size',
    'small',
    '--region',
    'nbg1',
  ];
  const restore = restoreResponseSchema.parse(JSON.parse(await cli(restoreArguments))).restore;
  assert.notEqual(restore.machineId, input.machine);
  assert.notEqual(
    (await input.cli(['ssh', restore.machineId, '--', 'true'], input.credentials)).code,
    0,
    'An unfinished restore accepted customer SSH.',
  );
  progress(
    'missing wrapping key keeps the same native restore pending without guest backup access',
  );
  const missingKeyRefusals = await input.keyRecovery.verifyUnavailable(restoreId);
  assert.deepEqual(
    restoreResponseSchema.parse(JSON.parse(await cli(['backup', 'restore-inspect', restoreId])))
      .restore.state,
    { kind: 'pending', waitingFor: 'backup_key' },
  );
  await input.keyRecovery.installWrong();
  progress('wrong bytes under the original key version preserve zero restore preparation attempts');
  const wrongKeyRefusals = await input.keyRecovery.verifyUnavailable(restoreId);
  assert.deepEqual(
    restoreResponseSchema.parse(JSON.parse(await cli(['backup', 'restore-inspect', restoreId])))
      .restore.state,
    { kind: 'pending', waitingFor: 'backup_key' },
  );
  await input.keyRecovery.recover();
  progress('recovering the independent private keyring resumes the same admitted restore');
  const restored = restoreResponseSchema.parse(
    JSON.parse(await cli(['backup', 'restore-wait', restoreId, '--timeout', '900'])),
  ).restore;
  assert.equal(restored.state.kind, 'restored');
  assert.equal(
    restoreResponseSchema.parse(JSON.parse(await cli(restoreArguments))).restore.machineId,
    restore.machineId,
  );
  const frontendAddress = z
    .ipv4()
    .parse(
      (
        await cli([
          'ssh',
          restore.machineId,
          '--',
          '/usr/bin/sudo',
          '-n',
          '--',
          'docker',
          'inspect',
          '--format',
          "'{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'",
          'acld-recovered-frontend-1',
        ])
      ).trim(),
    );
  const check = [
    'ssh',
    restore.machineId,
    '--',
    'curl',
    '--fail',
    '--silent',
    '--insecure',
    '--resolve',
    `${hostname}:443:${frontendAddress}`,
    `https://${hostname}/api/visits`,
  ];
  // The restored private Caddy uses a fresh local CA. Public trusted HTTPS is verified separately by routing.
  assert.deepEqual(JSON.parse(await cli(check)), { revision: '1', count: '1' });
  const restoredFile = join(input.scratch, 'restored-file.txt');
  await cli([
    'file',
    'get',
    restore.machineId,
    `/var/lib/agent-customer/restores/${restoreId}/declared.txt`,
    restoredFile,
  ]);
  assert.equal(await readFile(restoredFile, 'utf8'), content);
  assert.deepEqual(JSON.parse(await source.application('/api/visits')), {
    revision: '1',
    count: '1',
  });
  assert.equal(await input.vm(['cat', '/var/lib/agent-customer/declared.txt']), content);
  const inspected = backupResponseSchema.parse(
    JSON.parse(await cli(['backup', 'inspect', backupId])),
  ).backup;
  assert.equal(inspected.state.kind, 'captured');
  assert.equal(inspected.state.validation, 'restore_verified');
  if (route) {
    progress(
      'fencing source writes, promoting verified restore and moving its existing HTTPS route',
    );
    await cli([
      'ssh',
      input.machine,
      '--',
      '/usr/bin/sudo',
      '-n',
      '--',
      'docker',
      'compose',
      '--project-name',
      'acld-sample',
      '--file',
      `/var/lib/agent-cloud/compose/sample/releases/${source.releaseId}/runtime.json`,
      'stop',
      '--timeout',
      '10',
    ]);
    const stopped = composeResponseSchema.parse(
      JSON.parse(await cli(['compose', 'inspect', input.machine, 'sample'])),
    );
    assert.ok(
      stopped.containers.length === 3 &&
        stopped.containers.every((container) => container.state === 'exited'),
    );
    const promotionId = randomUUID();
    const promote = [
      'compose',
      'promote',
      restore.machineId,
      'recovered',
      '--release',
      promotionId,
      '--expected-release',
      restoreId,
    ];
    await cli(promote);
    assert.equal(
      composeResponseSchema.parse(
        JSON.parse(await cli(['compose', 'wait', restore.machineId, 'recovered'])),
      ).release?.phase,
      'succeeded',
    );
    assert.equal(
      composeResponseSchema.parse(JSON.parse(await cli(promote))).release?.id,
      promotionId,
    );
    const move = [
      'route',
      'move',
      hostname,
      restore.machineId,
      '--port',
      '30080',
      '--expected-version',
      '1',
      '--key',
      randomUUID(),
    ];
    await cli(move);
    await cli(['route', 'wait', hostname]);
    assert.equal(
      routeResponseSchema.parse(JSON.parse(await cli(move))).route.machineId,
      restore.machineId,
    );
    assert.deepEqual(await publicRequest(), { revision: '1', count: '1' });
    assert.deepEqual(await publicRequest('POST'), { revision: '1', count: '2' });
    assert.deepEqual(await publicRequest(), { revision: '1', count: '2' });
    await cli(['route', 'remove', hostname, '--expected-version', '2', '--key', randomUUID()]);
    await cli(['route', 'wait', hostname]);
    await assert.rejects(publicRequest);
  }
  progress(
    'destroying product-owned source and restore allocations while retaining the protected backup',
  );
  for (const machineId of [input.machine, restore.machineId]) {
    const machine = machineResponseSchema.parse(
      JSON.parse(await cli(['machine', 'inspect', machineId], input.ownerCredentials)),
    ).machine;
    const operation = operationResponseSchema.parse(
      JSON.parse(
        await cli(
          [
            'machine',
            'destroy',
            machineId,
            '--expected-version',
            String(machine.version),
            '--key',
            randomUUID(),
            '--allow-data-loss',
          ],
          input.ownerCredentials,
        ),
      ),
    ).operation;
    const result = operationResponseSchema.parse(
      JSON.parse(await cli(['operation', 'wait', operation.id], input.ownerCredentials)),
    );
    assert.equal(result.operation.progress.kind, 'succeeded');
  }
  const usage = usageResponseSchema.parse(JSON.parse(await cli(['usage'], input.ownerCredentials)));
  assert.equal(usage.usage.activeReservations, 0);
  assert.equal(
    backupResponseSchema.parse(JSON.parse(await cli(['backup', 'inspect', backupId]))).backup.state
      .kind,
    'captured',
  );
  process.stdout.write(
    JSON.stringify({
      result: 'backup-restore-native-verified',
      sourceAndTargetSeparateVms: true,
      customerCli: true,
      worker: true,
      postgres: true,
      declaredFiles: true,
      offVmEncryptedObject: true,
      objectLock: 'COMPLIANCE on local MinIO',
      wrappingKeyRotation: true,
      wrappingKeyRecovery: {
        independentPrivateCopy: true,
        missingKeyRefusals,
        wrongKeyRefusals,
        preparationAttemptsDuringKeyLoss: 0,
        backupCredentialsIssuedDuringKeyLoss: 0,
        sameRestoreIdRecovered: true,
      },
      sourceUnchanged: true,
      restoredCount: '1',
      quarantine: true,
      duplicateAdmissionOneTarget: true,
      reservationsAfterDestroy: 0,
      backupSurvivesSourceDestroy: true,
      networkPromotion: Boolean(route),
      dailyCaptureAfterCliExit: scheduled,
      publicHttpsCutover: Boolean(route),
      sourceWritesFenced: Boolean(route),
      restoredWritesVerified: Boolean(route),
      providerProof: false,
    }) + '\n',
  );
}

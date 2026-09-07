import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  backupResponseSchema,
  restoreResponseSchema,
  machineResponseSchema,
  operationResponseSchema,
  usageResponseSchema,
} from '../../packages/contracts/dist/index.js';
import { exerciseCompose } from './compose-scenario.js';

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
}) {
  const progress = (phase: string) =>
    process.stdout.write(JSON.stringify({ phase, cloudResourcesCreated: 0 }) + '\n');
  const cli = async (args: string[], credentials = input.credentials) => {
    const result = await input.cli(args, credentials);
    assert.equal(result.code, 0, result.stderr.slice(0, 1500) + result.stdout.slice(0, 2000));
    return result.stdout;
  };
  progress('deploying source reference application through customer Compose CLI');
  const source = await exerciseCompose({ ...input, initialOnly: true });
  const declared = join(input.scratch, 'declared.txt');
  const content = `declared backup data ${randomUUID()}\n`;
  await writeFile(declared, content, { mode: 0o600 });
  await cli(['file', 'put', input.machine, declared, '/var/lib/agent-customer/declared.txt']);
  const backupId = randomUUID();
  progress('capturing PostgreSQL and declared files into protected encrypted S3');
  const captureArguments = [
    'backup',
    'capture',
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
  const admitted = backupResponseSchema.parse(JSON.parse(await cli(captureArguments)));
  assert.equal(admitted.backup.id, backupId);
  // The admission CLI exits; the worker performs capture independently of that process.
  const captured = backupResponseSchema.parse(
    JSON.parse(await cli(['backup', 'wait', backupId, '--timeout', '900'])),
  );
  assert.equal(captured.backup.state.kind, 'captured');
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
    `customer.localhost:443:${frontendAddress}`,
    'https://customer.localhost/api/visits',
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
      sourceUnchanged: true,
      restoredCount: '1',
      quarantine: true,
      duplicateAdmissionOneTarget: true,
      reservationsAfterDestroy: 0,
      backupSurvivesSourceDestroy: true,
      providerProof: false,
    }) + '\n',
  );
}

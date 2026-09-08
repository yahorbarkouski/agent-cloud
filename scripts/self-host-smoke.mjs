import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdtemp, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Buffer } from 'node:buffer';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const flags = process.argv.slice(2);
if (
  new Set(flags).size !== flags.length ||
  flags.some((flag) => !['--restore', '--wal'].includes(flag))
)
  throw new Error('Usage: node scripts/self-host-smoke.mjs [--restore] [--wal]');
const restoreScenario = flags.includes('--restore');
const walScenario = flags.includes('--wal');
const startedAt = new Date().toISOString();
const project = `acld-self-host-${randomUUID()}`;
const restoreProject = restoreScenario ? `acld-self-host-restore-${randomUUID()}` : undefined;
const walProject = walScenario ? `acld-self-host-wal-${randomUUID()}` : undefined;
const ownedProjects = [project, restoreProject, walProject].filter(Boolean);
const tag = `agent-cloud-self-host:${project}`;
const walTag = walScenario ? `agent-cloud-control-postgres:${randomUUID()}` : undefined;
let image;
let walImage;
let walDirectory;
let walComposeFile;
let walEvidence;
let snapshotDirectory;
let snapshotDigest;
let ownsProject = false;
let cleanupFailed = false;
let stage = 'build';
let passed = false;
const environment = { ...process.env, ACLD_SELF_HOST_PORT: '0' };
async function docker(args, timeout = 60_000) {
  try {
    return (
      await promisify(execFile)('docker', args, {
        cwd: root,
        env: environment,
        timeout,
        killSignal: 'SIGKILL',
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout.trim();
  } catch (error) {
    throw Object.assign(new Error('Self-host fixture command failed.', { cause: error }), {
      fixtureFailure: {
        exitCode: Number.isInteger(error.code) ? error.code : undefined,
        pgBackRestCode: /ERROR:\s+\[([0-9]{3})\]/u.exec(error.stderr ?? '')?.[1],
      },
    });
  }
}
const composeArguments = (args, selectedProject = project) => [
  'compose',
  '--project-name',
  selectedProject,
  '-f',
  selectedProject === walProject && walComposeFile
    ? walComposeFile
    : 'infra/compose/self-host.yaml',
  ...(walScenario && selectedProject === project ? ['-f', 'infra/compose/self-host-wal.yaml'] : []),
  ...args,
];
const compose = (args, selectedProject = project) =>
  docker(composeArguments(args, selectedProject));
async function cli(args, selectedProject = project) {
  return JSON.parse(
    await compose(['run', '--rm', '--no-deps', '-T', 'cli', 'cli', ...args], selectedProject),
  );
}
function requireFact(condition) {
  if (!condition) throw new Error('Self-host fixture assertion failed.');
}
async function owned(kind, selectedProject = project) {
  return docker([
    kind,
    'ls',
    ...(kind === 'container' ? ['--all'] : []),
    '--filter',
    `label=com.docker.compose.project=${selectedProject}`,
    '--format',
    kind === 'volume' ? '{{.Name}}' : '{{.ID}}',
  ]);
}

// Only fixture bytes pass through these bounded pipes; child output is never logged.
async function pipeCompose(args, selectedProject = project, input) {
  try {
    const pending = promisify(execFile)('docker', composeArguments(args, selectedProject), {
      cwd: root,
      env: environment,
      timeout: 60_000,
      killSignal: 'SIGKILL',
      encoding: 'buffer',
      maxBuffer: 32 * 1024 * 1024,
    });
    pending.child.stdin.on('error', () => {});
    pending.child.stdin.end(input);
    return (await pending).stdout;
  } catch {
    throw new Error('Self-host private transfer failed.');
  }
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function syncDirectory(path) {
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function writePrivate(path, bytes, exclusive = true) {
  const file = await open(path, exclusive ? 'wx' : 'w', 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}
async function readPrivate(path, maximum) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    requireFact(info.isFile() && (info.mode & 0o077) === 0 && info.uid === process.getuid());
    requireFact(info.size > 0 && info.size <= maximum);
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    requireFact(length === info.size);
    return bytes.subarray(0, length);
  } finally {
    await file.close();
  }
}
const snapshotFiles = [
  { name: 'control.dump', maximum: 32 * 1024 * 1024 },
  {
    name: 'postgres-password',
    maximum: 16_384,
    service: 'initialize',
    path: '/run/agent-cloud/postgres-password',
  },
  {
    name: 'operator.env',
    maximum: 16_384,
    service: 'initialize',
    path: '/run/agent-cloud/operator.env',
  },
  {
    name: 'admin.credentials.json',
    maximum: 16_384,
    service: 'bootstrap',
    path: '/work/.local/admin.credentials.json',
  },
];
const readVolumeFile = `
const fs=require('node:fs'),path=process.argv[1];
const file=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
try {
  const info=fs.fstatSync(file);
  if(!info.isFile()||(info.mode&63)!==0||info.uid!==process.getuid()||info.size>16384)process.exit(1);
  const bytes=Buffer.alloc(info.size+1),length=fs.readSync(file,bytes,0,bytes.length,null);
  if(length!==info.size)process.exit(1);
  process.stdout.write(bytes.subarray(0,length));
}finally{fs.closeSync(file)}
`;
const writeVolumeFile = `
const fs=require('node:fs'),path=require('node:path'),destination=process.argv[1];
const chunks=[];let length=0;
process.stdin.on('data',chunk=>{length+=chunk.length;if(length>16384)process.exit(1);chunks.push(chunk)});
process.stdin.on('end',()=>{
 const file=fs.openSync(destination,'wx',384);
 try{fs.writeFileSync(file,Buffer.concat(chunks));fs.fsyncSync(file)}finally{fs.closeSync(file)}
 const directory=fs.openSync(path.dirname(destination),'r');
 try{fs.fsyncSync(directory)}finally{fs.closeSync(directory)}
});
`;
const migrationQuery =
  "SELECT coalesce(json_agg(json_build_object('hash',hash,'createdAt',created_at::text) ORDER BY id),'[]'::json)::text FROM drizzle.__drizzle_migrations";
async function migrationState(selectedProject) {
  return JSON.parse(
    await compose(
      [
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        'agentcloud',
        '-d',
        'agentcloud',
        '-At',
        '-c',
        migrationQuery,
      ],
      selectedProject,
    ),
  );
}
async function verifySnapshot(expectedImage) {
  const receiptBytes = await readPrivate(join(snapshotDirectory, 'receipt.json'), 16_384);
  requireFact(digest(receiptBytes) === snapshotDigest);
  const receipt = JSON.parse(receiptBytes);
  requireFact(receipt.version === 1 && receipt.image === expectedImage);
  requireFact(receipt.provider === 'simulated' && receipt.files.length === snapshotFiles.length);
  for (const file of snapshotFiles) {
    const recorded = receipt.files.find((entry) => entry.name === file.name);
    const bytes = await readPrivate(join(snapshotDirectory, file.name), file.maximum);
    requireFact(recorded?.size === bytes.length && recorded.sha256 === digest(bytes));
  }
  return receipt;
}

async function verifyRestore(machine, identity) {
  stage = 'restore source observation';
  const usage = await cli(['usage']);
  const history = await cli(['usage', 'history']);
  requireFact(usage.usage.activeReservations === 1 && history.history.length > 0);
  await compose(['stop', 'api', 'worker']);
  stage = 'quiesced private snapshot';
  snapshotDirectory = await mkdtemp(join(tmpdir(), 'self-host-restore-'));
  const migrations = await migrationState(project);
  const files = [];
  for (const file of snapshotFiles) {
    const bytes =
      file.name === 'control.dump'
        ? await pipeCompose([
            'exec',
            '-T',
            'postgres',
            'pg_dump',
            '-U',
            'agentcloud',
            '-d',
            'agentcloud',
            '--format=custom',
          ])
        : await pipeCompose([
            'run',
            '--rm',
            '--no-deps',
            '-T',
            '--entrypoint',
            'node',
            file.service,
            '-e',
            readVolumeFile,
            file.path,
          ]);
    requireFact(bytes.length > 0 && bytes.length <= file.maximum);
    await writePrivate(join(snapshotDirectory, file.name), bytes);
    files.push({ name: file.name, size: bytes.length, sha256: digest(bytes) });
  }
  const receipt = Buffer.from(
    JSON.stringify({ version: 1, image, provider: 'simulated', migrations, files }) + '\n',
  );
  await writePrivate(join(snapshotDirectory, 'receipt.json'), receipt);
  await syncDirectory(snapshotDirectory);
  await syncDirectory(dirname(snapshotDirectory));
  snapshotDigest = digest(receipt);
  stage = 'reject corrupt incomplete or mismatched restore';
  const dumpPath = join(snapshotDirectory, 'control.dump');
  const original = await readPrivate(dumpPath, snapshotFiles[0].maximum);
  const corrupt = Buffer.from(original);
  corrupt[0] ^= 1;
  await writePrivate(dumpPath, corrupt, false);
  await verifySnapshot(image).then(
    () => {
      throw new Error('Corruption accepted.');
    },
    () => {},
  );
  await writePrivate(dumpPath, original, false);
  const credentialPath = join(snapshotDirectory, 'admin.credentials.json');
  await rename(credentialPath, credentialPath + '.held');
  await verifySnapshot(image).then(
    () => {
      throw new Error('Incomplete backup accepted.');
    },
    () => {},
  );
  await rename(credentialPath + '.held', credentialPath);
  await syncDirectory(snapshotDirectory);
  await verifySnapshot('sha256:' + '0'.repeat(64)).then(
    () => {
      throw new Error('Image mismatch accepted.');
    },
    () => {},
  );
  for (const kind of ['container', 'volume', 'network'])
    requireFact((await owned(kind, restoreProject)) === '');
  await compose(['up', '--detach', '--wait', 'api']);
  requireFact(
    JSON.stringify((await cli(['machine', 'inspect', machine.id])).machine) ===
      JSON.stringify(machine),
  );
  await compose(['stop', 'api']);
  const verified = await verifySnapshot(image);
  stage = 'restore matching private configuration';
  for (const file of snapshotFiles.filter((entry) => entry.service)) {
    const bytes = await readPrivate(join(snapshotDirectory, file.name), file.maximum);
    await pipeCompose(
      [
        'run',
        '--rm',
        '--no-deps',
        '-T',
        '--entrypoint',
        'node',
        file.service,
        '-e',
        writeVolumeFile,
        file.path,
      ],
      restoreProject,
      bytes,
    );
    const published = await pipeCompose(
      [
        'run',
        '--rm',
        '--no-deps',
        '-T',
        '--entrypoint',
        'node',
        file.service,
        '-e',
        readVolumeFile,
        file.path,
      ],
      restoreProject,
    );
    requireFact(digest(published) === digest(bytes));
  }
  // Neither initialize-local nor bootstrap runs on the target: only the saved identity is installed.
  stage = 'restore database transaction';
  await compose(['up', '--detach', '--wait', 'postgres'], restoreProject);
  await pipeCompose(
    [
      'exec',
      '-T',
      'postgres',
      'pg_restore',
      '-U',
      'agentcloud',
      '-d',
      'agentcloud',
      '--exit-on-error',
      '--single-transaction',
      '--no-owner',
      '--no-privileges',
    ],
    restoreProject,
    original,
  );
  requireFact(
    JSON.stringify(await migrationState(restoreProject)) === JSON.stringify(verified.migrations),
  );
  stage = 'restored api without worker';
  await compose(['up', '--detach', '--wait', 'api'], restoreProject);
  requireFact(
    JSON.stringify((await cli(['whoami'], restoreProject)).principal) ===
      JSON.stringify(identity.principal),
  );
  requireFact(
    JSON.stringify((await cli(['machine', 'inspect', machine.id], restoreProject)).machine) ===
      JSON.stringify(machine),
  );
  requireFact(JSON.stringify(await cli(['usage'], restoreProject)) === JSON.stringify(usage));
  requireFact(
    JSON.stringify(await cli(['usage', 'history'], restoreProject)) === JSON.stringify(history),
  );
  stage = 'new operation in isolated restore';
  await compose(['up', '--detach', '--wait', 'worker'], restoreProject);
  const action = await cli(
    [
      'machine',
      'power-off',
      machine.id,
      '--expected-version',
      String(machine.version),
      '--key',
      randomUUID(),
    ],
    restoreProject,
  );
  const finished = await cli(
    ['operation', 'wait', action.operation.id, '--timeout', '30'],
    restoreProject,
  );
  requireFact(finished.operation.progress.kind === 'succeeded');
  const changed = await cli(['machine', 'inspect', machine.id], restoreProject);
  requireFact(
    changed.machine.version > machine.version &&
      changed.machine.state.kind === 'allocated' &&
      changed.machine.state.power === 'off',
  );
  stage = 'source preserved after isolated restore';
  await compose(['up', '--detach', '--wait', 'api', 'worker']);
  requireFact(
    JSON.stringify((await cli(['machine', 'inspect', machine.id])).machine) ===
      JSON.stringify(machine),
  );
  requireFact(JSON.stringify(await cli(['usage', 'history'])) === JSON.stringify(history));
  requireFact(
    JSON.stringify((await cli(['whoami'])).principal) === JSON.stringify(identity.principal),
  );
}

async function sql(query, selectedProject = project) {
  return compose(
    ['exec', '-T', 'postgres', 'psql', '-U', 'agentcloud', '-d', 'agentcloud', '-At', '-c', query],
    selectedProject,
  );
}
async function pgbackrest(args) {
  return compose([
    'exec',
    '-T',
    '--user',
    'postgres',
    'postgres',
    'pgbackrest',
    '--stanza=agentcloud',
    ...args,
  ]);
}
const walConfigPath = '/run/agent-cloud-wal/pgbackrest.conf';
const projectsQuery = "SELECT coalesce(json_agg(id ORDER BY id),'[]'::json)::text FROM projects";
async function walConfiguration(selectedProject, program, bytes) {
  return pipeCompose(
    [
      'run',
      '--rm',
      '--no-deps',
      '-T',
      '--entrypoint',
      'node',
      'initialize-wal',
      '-e',
      program,
      walConfigPath,
    ],
    selectedProject,
    bytes,
  );
}
async function verifyWal(configuration) {
  stage = 'WAL full backup';
  await pgbackrest(['check']);
  await pgbackrest(['--type=full', 'backup']);
  const info = JSON.parse(await pgbackrest(['--output=json', 'info']));
  requireFact(info.length === 1 && info[0].name === 'agentcloud' && info[0].status.code === 0);
  const backups = info[0].backup.filter((backup) => backup.type === 'full');
  requireFact(backups.length === 1 && /^[0-9]{8}-[0-9]{6}F$/.test(backups[0].label));
  const fullBackup = backups[0].label;

  stage = 'WAL actual CLI writes around recovery target';
  const earlier = (await cli(['project', 'create', `wal-before-${randomUUID()}`])).project;
  requireFact(typeof earlier?.id === 'string');
  const targetTime = await sql(
    `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  );
  requireFact(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(targetTime));
  const later = (await cli(['project', 'create', `wal-after-${randomUUID()}`])).project;
  requireFact(typeof later?.id === 'string' && earlier.id !== later.id);
  await compose(['stop', 'api', 'worker']);
  const sourceProjects = JSON.parse(await sql(projectsQuery));
  requireFact(sourceProjects.includes(earlier.id) && sourceProjects.includes(later.id));
  const migrations = await migrationState(project);
  await sql('SELECT pg_switch_wal()');
  await pgbackrest(['check']);
  await compose(['stop', 'postgres']);

  stage = 'WAL independent private configuration snapshot';
  const privateConfig = await walConfiguration(project, readVolumeFile);
  await writePrivate(join(walDirectory, 'pgbackrest.conf'), privateConfig);
  await syncDirectory(walDirectory);
  await syncDirectory(dirname(walDirectory));
  const savedConfig = await readPrivate(join(walDirectory, 'pgbackrest.conf'), 16_384);
  requireFact(digest(savedConfig) === digest(privateConfig));
  const repository = configuration.volumes['wal-repository'].name;
  const repoHash = () =>
    compose([
      'run',
      '--rm',
      '--no-deps',
      '-T',
      '--entrypoint',
      'sh',
      'postgres',
      '-ec',
      'find /var/lib/pgbackrest -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum',
    ]);
  const originalRepositoryHash = await repoHash();
  requireFact(/^[a-f0-9]{64}\s+-$/u.test(originalRepositoryHash));
  walComposeFile = join(walDirectory, 'compose.json');
  await writePrivate(
    walComposeFile,
    JSON.stringify({
      services: {
        'initialize-wal': {
          image,
          pull_policy: 'never',
          profiles: ['setup'],
          read_only: true,
          cap_drop: ['ALL'],
          security_opt: ['no-new-privileges:true'],
          volumes: ['wal-configuration:/run/agent-cloud-wal'],
        },
        postgres: {
          image: walImage,
          pull_policy: 'never',
          command: ['postgres', '-c', 'archive_mode=off', '-c', 'log_min_error_statement=panic'],
          volumes: [
            'database:/var/lib/postgresql/data',
            'wal-configuration:/run/agent-cloud-wal:ro',
            'wal-repository:/var/lib/pgbackrest:ro',
          ],
          healthcheck: {
            test: ['CMD-SHELL', 'pg_isready -U agentcloud -d agentcloud'],
            interval: '2s',
            timeout: '3s',
            retries: 30,
          },
          mem_limit: '512m',
          cpus: 1,
          pids_limit: 128,
          logging: { driver: 'local', options: { 'max-size': '5m', 'max-file': '2' } },
        },
      },
      volumes: {
        database: {},
        'wal-configuration': {},
        'wal-repository': { external: true, name: repository },
      },
      networks: { default: { internal: true } },
    }),
  );
  const target = JSON.parse(await compose(['config', '--format', 'json'], walProject));
  requireFact(
    !target.services.postgres.ports && !target.services.worker && target.networks.default.internal,
  );
  requireFact(
    target.services.postgres.volumes.some(
      (volume) =>
        volume.target === '/var/lib/pgbackrest' &&
        volume.read_only === true &&
        target.volumes[volume.source].external === true &&
        target.volumes[volume.source].name === repository,
    ),
  );
  const restore = () =>
    compose(
      ['run', '--rm', '--no-deps', '-T', 'postgres', 'restore', targetTime, fullBackup],
      walProject,
    );
  const expectEmpty = () =>
    compose(
      [
        'run',
        '--rm',
        '--no-deps',
        '-T',
        '--entrypoint',
        'sh',
        'postgres',
        '-ec',
        'test -z "$(find /var/lib/postgresql/data -mindepth 1 -maxdepth 1 -print -quit)"',
      ],
      walProject,
    );
  stage = 'WAL missing key rejected before target data';
  await restore().then(
    () => {
      throw new Error('Missing WAL key accepted.');
    },
    () => {},
  );
  await expectEmpty();
  const wrongConfig = Buffer.from(
    savedConfig
      .toString()
      .replace(
        /^repo1-cipher-pass=[a-f0-9]{64}$/m,
        'repo1-cipher-pass=' + createHash('sha256').update(randomUUID()).digest('hex'),
      ),
  );
  requireFact(digest(wrongConfig) !== digest(savedConfig));
  await walConfiguration(walProject, writeVolumeFile, wrongConfig);
  stage = 'WAL wrong key rejected before target data';
  await restore().then(
    () => {
      throw new Error('Wrong WAL key accepted.');
    },
    () => {},
  );
  await expectEmpty();
  await walConfiguration(walProject, "require('node:fs').unlinkSync(process.argv[1])");
  stage = 'WAL malformed or modified private configuration rejected';
  for (const invalid of [
    Buffer.from('invalid configuration\n'),
    Buffer.from(savedConfig.toString().replace('archive-async=n', 'archive-async=y')),
  ]) {
    requireFact(digest(invalid) !== digest(savedConfig));
    await walConfiguration(walProject, writeVolumeFile, invalid);
    await restore().then(
      () => {
        throw new Error('Invalid WAL configuration accepted.');
      },
      () => {},
    );
    await expectEmpty();
    await walConfiguration(walProject, "require('node:fs').unlinkSync(process.argv[1])");
  }
  await walConfiguration(walProject, writeVolumeFile, savedConfig);
  requireFact(digest(await walConfiguration(walProject, readVolumeFile)) === digest(savedConfig));
  stage = 'WAL competing restore directory lock rejected';
  const holderName = `acld-wal-lock-${randomUUID()}`;
  requireFact(
    (await docker([
      'container',
      'ls',
      '--all',
      '--filter',
      `name=^/${holderName}$`,
      '--format',
      '{{.ID}}',
    ])) === '',
  );
  let holder;
  try {
    holder = await compose(
      [
        'run',
        '--detach',
        '--no-deps',
        '--name',
        holderName,
        '--entrypoint',
        'sh',
        'postgres',
        '-ec',
        'exec 9</var/lib/postgresql/data; flock --exclusive --nonblock 9; : > /tmp/lock-ready; sleep 120',
      ],
      walProject,
    );
    requireFact(/^[a-f0-9]{64}$/.test(holder));
    requireFact(
      (await docker([
        'container',
        'inspect',
        holder,
        '--format',
        '{{index .Config.Labels "com.docker.compose.project"}}',
      ])) === walProject,
    );
    let ready = false;
    for (let attempt = 0; attempt < 30 && !ready; attempt++) {
      ready = await docker(['exec', holder, 'test', '-f', '/tmp/lock-ready']).then(
        () => true,
        () => false,
      );
      if (!ready) await delay(100);
    }
    requireFact(ready);
    await restore().then(
      () => {
        throw new Error('Competing WAL restore accepted.');
      },
      () => {},
    );
    await expectEmpty();
  } finally {
    if (holder) {
      requireFact(
        (await docker([
          'container',
          'inspect',
          holder,
          '--format',
          '{{index .Config.Labels "com.docker.compose.project"}}',
        ])) === walProject,
      );
      await docker(['container', 'rm', '--force', holder]);
      requireFact(
        (await docker([
          'container',
          'ls',
          '--all',
          '--filter',
          `name=^/${holderName}$`,
          '--format',
          '{{.ID}}',
        ])) === '',
      );
    }
  }
  stage = 'WAL restore explicit full backup to timestamp';
  await restore();
  stage = 'WAL nonempty target retry rejected without changes';
  const dataHash = () =>
    compose(
      [
        'run',
        '--rm',
        '--no-deps',
        '-T',
        '--entrypoint',
        'sh',
        'postgres',
        '-ec',
        'find /var/lib/postgresql/data -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum',
      ],
      walProject,
    );
  const restoredDataHash = await dataHash();
  requireFact(/^[a-f0-9]{64}\s+-$/u.test(restoredDataHash));
  await restore().then(
    () => {
      throw new Error('Nonempty WAL restore accepted.');
    },
    () => {},
  );
  requireFact((await dataHash()) === restoredDataHash);
  stage = 'WAL target PostgreSQL startup';
  try {
    await compose(['up', '--detach', '--wait', 'postgres'], walProject);
  } catch (error) {
    // PostgreSQL logs may contain data: expose only these fixed diagnostic categories.
    const output = await compose(
      ['logs', '--no-color', '--tail', '60', 'postgres'],
      walProject,
    ).catch(() => '');
    error.fixtureFailure = {
      ...error.fixtureFailure,
      postgres: {
        fatal: output.includes('FATAL:'),
        permissionDenied: /permission denied/iu.test(output),
        readOnlyFilesystem: /read-only file system/iu.test(output),
        targetUnreached: output.includes(
          'recovery ended before configured recovery target was reached',
        ),
        missingPassword: output.includes('superuser password is not specified'),
        incompatibleData: output.includes('database files are incompatible'),
        invalidConfiguration:
          /unrecognized configuration parameter|invalid value for parameter/iu.test(output),
        pgBackRestCodes: [
          ...new Set([...output.matchAll(/ERROR:\s+\[([0-9]{3})\]/gu)].map((match) => match[1])),
        ],
      },
    };
    throw error;
  }
  stage = 'WAL target recovery promotion';
  const targetContainer = await compose(['ps', '--quiet', 'postgres'], walProject);
  const mounts = JSON.parse(
    await docker(['container', 'inspect', targetContainer, '--format', '{{json .Mounts}}']),
  );
  requireFact(
    mounts.some(
      (mount) =>
        mount.Destination === '/var/lib/pgbackrest' &&
        mount.Name === repository &&
        mount.RW === false,
    ),
  );
  for (let attempt = 0; attempt < 30; attempt++) {
    if ((await sql('SELECT NOT pg_is_in_recovery()', walProject)) === 't') break;
    await delay(500);
  }
  requireFact((await sql('SELECT NOT pg_is_in_recovery()', walProject)) === 't');
  requireFact((await sql('SHOW archive_mode', walProject)) === 'off');
  stage = 'WAL recovered project cutoff and migration hashes';
  const recoveredProjects = JSON.parse(await sql(projectsQuery, walProject));
  requireFact(
    JSON.stringify(recoveredProjects) ===
      JSON.stringify(sourceProjects.filter((id) => id !== later.id)),
  );
  requireFact(recoveredProjects.includes(earlier.id) && !recoveredProjects.includes(later.id));
  requireFact(JSON.stringify(await migrationState(walProject)) === JSON.stringify(migrations));
  stage = 'WAL repository and source key unchanged';
  requireFact((await repoHash()) === originalRepositoryHash);
  requireFact(digest(await walConfiguration(project, readVolumeFile)) === digest(savedConfig));
  stage = 'WAL source preserved';
  await compose(['up', '--detach', '--wait', 'postgres', 'api', 'worker']);
  requireFact(
    JSON.stringify(JSON.parse(await sql(projectsQuery))) === JSON.stringify(sourceProjects),
  );
  const visibleProjects = (await cli(['project', 'list'])).projects.map((entry) => entry.id);
  requireFact(visibleProjects.includes(earlier.id) && visibleProjects.includes(later.id));
  walEvidence = {
    walProject,
    walImage,
    fullBackup,
    targetTime,
    earlierProject: earlier.id,
    laterProject: later.id,
    missingAndWrongKeyRejected: true,
    alteredConfigurationRejected: true,
    competingRestoreRejected: true,
    nonemptyRestoreRetryRejected: true,
    targetRepositoryReadOnly: true,
    repositoryAndKeyUnchanged: true,
    recoveredAfterFullBackup: true,
    laterTransactionExcluded: true,
    migrationHashesMatched: true,
    sourcePreserved: true,
  };
}
try {
  for (const selectedProject of ownedProjects)
    for (const kind of ['container', 'volume', 'network'])
      requireFact((await owned(kind, selectedProject)) === '');
  for (const ownedTag of [tag, walTag].filter(Boolean))
    requireFact(
      (await docker([
        'image',
        'ls',
        '--filter',
        `reference=${ownedTag}`,
        '--format',
        '{{.ID}}',
      ])) === '',
    );
  ownsProject = true;
  image = await docker(
    ['build', '--quiet', '-f', 'infra/container/Dockerfile', '-t', tag, '.'],
    300_000,
  );
  requireFact(/^sha256:[a-f0-9]{64}$/.test(image));
  environment.ACLD_SELF_HOST_IMAGE = image;
  if (walScenario) {
    stage = 'WAL PostgreSQL image build';
    walImage = await docker(
      ['build', '--quiet', '-f', 'infra/container/postgres/Dockerfile', '-t', walTag, '.'],
      300_000,
    );
    requireFact(/^sha256:[a-f0-9]{64}$/.test(walImage));
    environment.ACLD_CONTROL_POSTGRES_IMAGE = walImage;
    walDirectory = await mkdtemp(join(tmpdir(), 'self-host-wal-'));
  }
  stage = 'configuration';
  await compose(['config', '--quiet']);
  const configuration = JSON.parse(await compose(['config', '--format', 'json']));
  requireFact(configuration.services.api.ports.every((port) => port.host_ip === '127.0.0.1'));
  requireFact(!configuration.services.postgres.ports);
  requireFact(configuration.networks.default.internal === true);
  if (walScenario)
    requireFact(
      configuration.services.postgres.volumes.some(
        (volume) =>
          volume.target === '/var/lib/postgresql/data' && volume.source === 'database-wal',
      ),
    );
  stage = 'initialize private volumes';
  await compose(['run', '--rm', '--no-deps', '-T', 'initialize']);
  await compose(['run', '--rm', '--no-deps', '-T', 'initialize']);
  if (walScenario) {
    await compose(['run', '--rm', '--no-deps', '-T', 'initialize-wal']);
    await compose(['run', '--rm', '--no-deps', '-T', 'initialize-wal']);
  }
  stage = 'database';
  await compose(['up', '--detach', '--wait', 'postgres']);
  if (walScenario) await pgbackrest(['stanza-create']);
  stage = 'migration';
  await compose(['run', '--rm', '--no-deps', '-T', 'migrate']);
  stage = 'explicit internal bootstrap';
  for (const args of [
    ['bootstrap', 'bootstrap-internal'],
    ['-e', 'PUBLIC_URL=https://public.example', 'bootstrap'],
    ['-e', 'ACLD_LOCAL_QUICKSTART=0', 'bootstrap'],
  ]) {
    let refused = false;
    try {
      await compose(['run', '--rm', '--no-deps', '-T', ...args]);
    } catch {
      refused = true;
    }
    requireFact(refused);
  }
  await compose(['run', '--rm', '--no-deps', '-T', 'bootstrap']);
  await compose([
    'run',
    '--rm',
    '--no-deps',
    '-T',
    '--entrypoint',
    'node',
    'initialize',
    '-e',
    'require("node:fs").writeFileSync("/run/agent-cloud/operator.env","PROVIDER=simulated\\n",{mode:0o600,flag:"wx"})',
  ]);
  await compose([
    'run',
    '--rm',
    '--no-deps',
    '-T',
    '-e',
    'ACLD_CONTAINER_ENV_FILE=/run/agent-cloud/operator.env',
    'bootstrap',
  ]);
  stage = 'api and worker';
  await compose(['up', '--detach', '--wait', 'api', 'worker']);
  await compose([
    'exec',
    '-T',
    'api',
    'node',
    '-e',
    'fetch("http://127.0.0.1:4319/v1/projects").then(r=>process.exit(r.status===401?0:1))',
  ]);
  stage = 'packaged cli authentication';
  const identity = await cli(['whoami']);
  requireFact(typeof identity.principal?.grantId === 'string');
  const offers = await cli(['catalog']);
  requireFact(offers.provider === 'simulated');
  const { projects } = await cli(['project', 'list']);
  requireFact(projects.length === 1 && typeof projects[0].id === 'string');
  stage = 'create simulated machine';
  const { operation } = await cli([
    'machine',
    'create',
    project,
    '--project',
    projects[0].id,
    '--key',
    randomUUID(),
  ]);
  const created = await cli(['operation', 'wait', operation.id, '--timeout', '30']);
  requireFact(created.operation.progress.kind === 'succeeded');
  const { machine } = await cli(['machine', 'inspect', operation.machineId]);
  requireFact(machine.state.kind === 'allocated' && machine.state.guest.kind === 'simulated');
  if (restoreScenario) await verifyRestore(machine, identity);
  if (walScenario) await verifyWal(configuration);
  stage = 'database and service restart';
  await compose(['stop', 'api', 'worker']);
  await compose([
    'exec',
    '-T',
    'postgres',
    'sh',
    '-c',
    'umask 077; trap "rm -f /tmp/self-host-check.dump" EXIT; pg_dump -U agentcloud -d agentcloud --format=custom --file=/tmp/self-host-check.dump && pg_restore --list /tmp/self-host-check.dump >/dev/null',
  ]);
  await compose(['restart', 'postgres']);
  await compose(['up', '--detach', '--wait', 'postgres']);
  await compose(['up', '--detach', '--wait', 'api', 'worker']);
  const persisted = await cli(['machine', 'inspect', machine.id]);
  requireFact(persisted.machine.id === machine.id && persisted.machine.state.kind === 'allocated');
  requireFact((await cli(['whoami'])).principal.grantId === identity.principal.grantId);
  stage = 'destroy simulated machine';
  const removed = await cli([
    'machine',
    'destroy',
    machine.id,
    '--expected-version',
    String(persisted.machine.version),
    '--allow-data-loss',
    '--key',
    randomUUID(),
  ]);
  const finished = await cli(['operation', 'wait', removed.operation.id, '--timeout', '30']);
  requireFact(finished.operation.progress.kind === 'succeeded');
  requireFact((await cli(['machine', 'inspect', machine.id])).machine.state.kind === 'destroyed');
  passed = true;
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      error: 'Self-host packaging smoke failed.',
      stage,
      project,
      restoreProject,
      walProject,
      failure: error.fixtureFailure,
    }) + '\n',
  );
  process.exitCode = 1;
} finally {
  if (ownsProject && image) {
    for (const selectedProject of ownedProjects.toReversed()) {
      try {
        await compose(
          ['--profile', 'setup', '--profile', 'tools', 'down', '--volumes', '--remove-orphans'],
          selectedProject,
        );
        for (const kind of ['container', 'volume', 'network'])
          requireFact((await owned(kind, selectedProject)) === '');
      } catch {
        cleanupFailed = true;
      }
    }
  }
  for (const directory of [snapshotDirectory, walDirectory].filter(Boolean))
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      cleanupFailed = true;
    }
  try {
    if (image) await docker(['image', 'rm', tag]);
  } catch {
    cleanupFailed = true;
  }
  try {
    if (walImage) await docker(['image', 'rm', walTag]);
  } catch {
    cleanupFailed = true;
  }
}
if (cleanupFailed) {
  process.stderr.write(
    JSON.stringify({
      error: 'Self-host fixture cleanup is incomplete.',
      project,
      restoreProject,
      walProject,
    }) + '\n',
  );
  process.exitCode = 1;
  passed = false;
}
if (passed)
  process.stdout.write(
    JSON.stringify({
      passed: true,
      project,
      ...(restoreScenario
        ? {
            restoreProject,
            restoredIdentityAndHistory: true,
            sourcePreserved: true,
            corruptRestoreRejected: true,
            snapshotDigest,
          }
        : {}),
      startedAt,
      finishedAt: new Date().toISOString(),
      image,
      ...(walEvidence ? { wal: walEvidence } : {}),
      provider: 'simulated',
      packagedCli: true,
      persistedAcrossRestart: true,
      machineDestroyed: true,
      cleanup: true,
      providerProof: false,
    }) + '\n',
  );

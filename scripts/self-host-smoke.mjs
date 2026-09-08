import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const project = `acld-self-host-${randomUUID()}`;
const tag = `agent-cloud-self-host:${project}`;
let image;
let ownsProject = false;
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
  } catch {
    throw new Error('Self-host fixture command failed.');
  }
}
const compose = (args) =>
  docker(['compose', '--project-name', project, '-f', 'infra/compose/self-host.yaml', ...args]);
async function cli(args) {
  return JSON.parse(await compose(['run', '--rm', '--no-deps', '-T', 'cli', 'cli', ...args]));
}
function requireFact(condition) {
  if (!condition) throw new Error('Self-host fixture assertion failed.');
}
async function owned(kind) {
  return docker([
    kind,
    'ls',
    ...(kind === 'container' ? ['--all'] : []),
    '--filter',
    `label=com.docker.compose.project=${project}`,
    '--format',
    kind === 'volume' ? '{{.Name}}' : '{{.ID}}',
  ]);
}
try {
  for (const kind of ['container', 'volume', 'network']) requireFact((await owned(kind)) === '');
  requireFact(
    (await docker(['image', 'ls', '--filter', `reference=${tag}`, '--format', '{{.ID}}'])) === '',
  );
  ownsProject = true;
  image = await docker(
    ['build', '--quiet', '-f', 'infra/container/Dockerfile', '-t', tag, '.'],
    300_000,
  );
  requireFact(/^sha256:[a-f0-9]{64}$/.test(image));
  environment.ACLD_SELF_HOST_IMAGE = image;
  stage = 'configuration';
  await compose(['config', '--quiet']);
  const configuration = JSON.parse(await compose(['config', '--format', 'json']));
  requireFact(configuration.services.api.ports.every((port) => port.host_ip === '127.0.0.1'));
  requireFact(!configuration.services.postgres.ports);
  requireFact(configuration.networks.default.internal === true);
  stage = 'initialize private volumes';
  await compose(['run', '--rm', '--no-deps', '-T', 'initialize']);
  await compose(['run', '--rm', '--no-deps', '-T', 'initialize']);
  stage = 'database';
  await compose(['up', '--detach', '--wait', 'postgres']);
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
} catch {
  process.stderr.write(
    JSON.stringify({ error: 'Self-host packaging smoke failed.', stage }) + '\n',
  );
  process.exitCode = 1;
} finally {
  if (ownsProject && image) {
    await compose([
      '--profile',
      'setup',
      '--profile',
      'tools',
      'down',
      '--volumes',
      '--remove-orphans',
    ]);
    for (const kind of ['container', 'volume', 'network']) requireFact((await owned(kind)) === '');
  }
  if (image) await docker(['image', 'rm', tag]);
}
if (passed)
  process.stdout.write(
    JSON.stringify({
      passed: true,
      project,
      provider: 'simulated',
      packagedCli: true,
      persistedAcrossRestart: true,
      machineDestroyed: true,
      cleanup: true,
      providerProof: false,
    }) + '\n',
  );

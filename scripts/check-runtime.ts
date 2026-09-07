import { imageEnrollmentUrl, readRuntimeConfig } from '../apps/control/dist/runtime-config.js';
import { readConfig } from '../apps/control/dist/config.js';
import { connect } from '../packages/db/dist/index.js';
import { createCustomerRuntime } from '../apps/control/dist/customer-runtime.js';

try {
  const config = readConfig();
  const runtime =
    config.provider === 'hetzner' ? await readRuntimeConfig(config.runtimeConfigFile) : undefined;
  const mode = runtime?.mode ?? 'image_factory';
  if (config.provider === 'hetzner' && runtime?.mode === 'customer') {
    const connection = connect(config.databaseUrl);
    try {
      await (await createCustomerRuntime({ connection, config, runtime })).checkConfiguration();
    } finally {
      await connection.pool.end();
    }
  }
  const origin = new URL(imageEnrollmentUrl(process.env.PUBLIC_URL ?? '')).origin;
  const checks = [];
  for (const check of [
    { path: '/healthz', method: 'GET', expected: 200 },
    { path: '/v1/projects', method: 'GET', expected: mode === 'customer' ? 401 : 403 },
    { path: '/image/enroll', method: 'POST', expected: mode === 'customer' ? 404 : 400 },
    { path: '/guest/enroll', method: 'POST', expected: mode === 'customer' ? 400 : 404 },
    { path: '/guest/renew', method: 'POST', expected: mode === 'customer' ? 400 : 404 },
  ]) {
    const response = await fetch(origin + check.path, {
      method: check.method,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      ...(check.method === 'POST'
        ? { headers: { 'Content-Type': 'application/json' }, body: '{}' }
        : {}),
    });
    await response.body?.cancel();
    if (response.status !== check.expected) throw new Error('Unexpected runtime response.');
    checks.push({ ...check, status: response.status });
  }
  process.stdout.write(
    JSON.stringify({ observedAt: new Date().toISOString(), origin, mode, checks }) + '\n',
  );
} catch {
  process.stderr.write(
    JSON.stringify({
      error:
        'Runtime readiness failed. Check PUBLIC_URL, HTTPS reachability and the configured API mode.',
    }) + '\n',
  );
  process.exitCode = 1;
}

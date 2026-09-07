import { imageEnrollmentUrl } from '../apps/control/dist/runtime-config.js';

try {
  const origin = new URL(imageEnrollmentUrl(process.env.PUBLIC_URL ?? '')).origin;
  const checks = [];
  for (const check of [
    { path: '/healthz', method: 'GET', expected: 200 },
    { path: '/v1/projects', method: 'GET', expected: 403 },
    { path: '/image/enroll', method: 'POST', expected: 400 },
    { path: '/guest/enroll', method: 'POST', expected: 404 },
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
    if (response.status !== check.expected) throw new Error('Unexpected image factory response.');
    checks.push({ ...check, status: response.status });
  }
  process.stdout.write(
    JSON.stringify({ observedAt: new Date().toISOString(), origin, checks }) + '\n',
  );
} catch {
  process.stderr.write(
    JSON.stringify({
      error:
        'Image factory readiness failed. Check PUBLIC_URL, HTTPS reachability and the configured API mode.',
    }) + '\n',
  );
  process.exitCode = 1;
}

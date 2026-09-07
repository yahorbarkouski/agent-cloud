import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { ZodError } from 'zod';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  referenceInputSchema,
  CloudError,
  errorStatus,
  type CatalogSource,
  projectIdSchema,
  machineIdSchema,
  operationIdSchema,
  grantIdSchema,
  machineSpecSchema,
  machineActionSchema,
  idempotencyKeySchema,
  projectInputSchema,
  grantInputSchema,
  guestEnrollmentInputSchema,
  guestRenewalInputSchema,
  imageVerifierEnrollmentInputSchema,
  newId,
  type Principal,
  type MachineProvider,
} from '@agent-cloud/contracts';
import {
  projects,
  machines,
  operations,
  allocations,
  operationRecord,
  machineRecord,
  projectRecord,
  type Database,
} from '@agent-cloud/db';
import type { InternalReference } from './internal-reference.js';
import { authenticate, authorize, issueGrant, loadPrincipal, revokeGrant } from './auth.js';
import { admit, lockAccount } from './lifecycle.js';
import type { ImageReleaseSelection } from './allocation-image.js';
import type { Config } from './config.js';
import type { GuestRenewalService } from './guest-renewal.js';
import type { EnrollmentService } from './guest-enrollment.js';
import type { ImageVerifierEnrollment } from './image-verifier-enrollment.js';

export function createApp(input: {
  db: Database;
  provider: MachineProvider['kind'];
  catalog: CatalogSource;
  limits: Config['limits'];
  enrollment?: EnrollmentService;
  renewal?: GuestRenewalService;
  imageEnrollment?: ImageVerifierEnrollment;
  imageRelease?: ImageReleaseSelection;
  customerAccess?: 'enabled' | 'disabled';
  internalReference?: InternalReference;
}) {
  const app = new Hono<{ Variables: { principal: Principal; requestId: string } }>();
  app.use('*', async (c, next) => {
    c.set('requestId', randomUUID());
    c.header('X-Request-Id', c.get('requestId'));
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.use('*', secureHeaders());
  app.use(
    '*',
    bodyLimit({
      maxSize: 64 * 1024,
      onError: () => {
        throw new CloudError('invalid_input', 'Request body exceeds 64 KiB.');
      },
    }),
  );
  app.onError((error, c) => {
    const failure =
      error instanceof CloudError
        ? error.failure
        : error instanceof ZodError || error instanceof SyntaxError
          ? new CloudError('invalid_input', 'Request does not match the API schema.').failure
          : new CloudError(
              'internal_error',
              'An internal error occurred. Use the request ID for investigation.',
            ).failure;
    if (failure.code === 'internal_error') {
      process.stderr.write(
        JSON.stringify({
          event: 'request.failed',
          requestId: c.get('requestId'),
          errorType: error.name,
        }) + '\n',
      );
    }
    return c.json({ error: failure, requestId: c.get('requestId') }, errorStatus(failure.code));
  });
  app.notFound((c) =>
    c.json(
      {
        error: { code: 'not_found', message: 'Endpoint not found.', retryable: false },
        requestId: c.get('requestId'),
      },
      404,
    ),
  );
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  const enrollment = input.enrollment;
  if (enrollment)
    app.post('/guest/enroll', async (c) =>
      c.json(
        await enrollment.enroll(guestEnrollmentInputSchema.parse(await c.req.json<unknown>())),
      ),
    );
  const renewal = input.renewal;
  if (renewal)
    app.post('/guest/renew', async (c) =>
      c.json(await renewal.renew(guestRenewalInputSchema.parse(await c.req.json<unknown>()))),
    );
  const imageEnrollment = input.imageEnrollment;
  if (imageEnrollment)
    app.post('/image/enroll', async (c) =>
      c.json(
        await imageEnrollment.enroll(
          imageVerifierEnrollmentInputSchema.parse(await c.req.json<unknown>()),
        ),
      ),
    );
  if (input.internalReference) {
    const reference = input.internalReference;
    app.post('/internal/v1/machines/:id/reference', async (c) => {
      const principal = await authenticate(input.db, c.req.header('Authorization'));
      return c.json(
        await reference(
          principal,
          machineIdSchema.parse(c.req.param('id')),
          referenceInputSchema.parse(await c.req.json<unknown>()),
        ),
      );
    });
  }
  app.use('/v1/*', async (c, next) => {
    if (input.customerAccess === 'disabled')
      throw new CloudError('permission_denied', 'Customer API is disabled in image factory mode.');
    c.set('principal', await authenticate(input.db, c.req.header('Authorization')));
    await next();
  });
  app.get('/v1/whoami', (c) => c.json({ principal: c.get('principal') }));
  app.get('/v1/catalog', (c) => c.json(input.catalog()));
  app.get('/v1/projects', async (c) => {
    const principal = c.get('principal');
    authorize(principal, 'project:read');
    const rows = await input.db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.accountId, principal.accountId),
          principal.policy.projects.kind === 'selected'
            ? inArray(projects.id, principal.policy.projects.ids)
            : undefined,
        ),
      )
      .orderBy(desc(projects.createdAt))
      .limit(100);
    return c.json({ projects: rows.map(projectRecord) });
  });
  app.post('/v1/projects', async (c) => {
    const principal = c.get('principal');
    const body = projectInputSchema.parse(await c.req.json<unknown>());
    const project = await input.db.transaction(async (tx) => {
      await lockAccount(tx, principal);
      const current = await loadPrincipal(tx, principal.grantId);
      authorize(current, 'project:create');
      if (current.policy.projects.kind !== 'all')
        throw new CloudError(
          'permission_denied',
          'Project creation requires account-wide project scope.',
        );
      const [existing] = await tx
        .select()
        .from(projects)
        .where(and(eq(projects.accountId, principal.accountId), eq(projects.name, body.name)));
      if (existing) return projectRecord(existing);
      const [created] = await tx
        .insert(projects)
        .values({ id: newId.project(), accountId: principal.accountId, name: body.name })
        .returning();
      if (!created) throw new CloudError('internal_error', 'Project creation returned no record.');
      return projectRecord(created);
    });
    return c.json({ project }, 201);
  });
  app.get('/v1/projects/:projectId/machines', async (c) => {
    const principal = c.get('principal');
    const projectId = projectIdSchema.parse(c.req.param('projectId'));
    authorize(principal, 'machine:read', projectId);
    const [project] = await input.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.accountId, principal.accountId)));
    if (!project) throw new CloudError('not_found', 'Project not found.');
    const rows = await input.db
      .select()
      .from(machines)
      .where(and(eq(machines.projectId, projectId), eq(machines.accountId, principal.accountId)))
      .orderBy(desc(machines.createdAt))
      .limit(100);
    return c.json({ machines: rows.map(machineRecord) });
  });
  app.post('/v1/projects/:projectId/machines', async (c) => {
    const projectId = projectIdSchema.parse(c.req.param('projectId'));
    const spec = machineSpecSchema.parse(await c.req.json<unknown>());
    const key = idempotencyKeySchema.parse(c.req.header('Idempotency-Key'));
    const operation = await admit({
      ...input,
      principal: c.get('principal'),
      key,
      request: { kind: 'create', projectId, spec },
    });
    return c.json({ operation }, 202);
  });
  app.get('/v1/machines/:machineId', async (c) => {
    const principal = c.get('principal');
    const machineId = machineIdSchema.parse(c.req.param('machineId'));
    const [row] = await input.db
      .select()
      .from(machines)
      .where(and(eq(machines.id, machineId), eq(machines.accountId, principal.accountId)));
    if (!row) throw new CloudError('not_found', 'Machine not found.');
    const machine = machineRecord(row);
    authorize(principal, 'machine:read', machine.projectId);
    return c.json({ machine });
  });
  app.post('/v1/machines/:machineId/actions', async (c) => {
    const machineId = machineIdSchema.parse(c.req.param('machineId'));
    const command = machineActionSchema.parse(await c.req.json<unknown>());
    const key = idempotencyKeySchema.parse(c.req.header('Idempotency-Key'));
    const operation = await admit({
      ...input,
      principal: c.get('principal'),
      key,
      request: { kind: 'action', machineId, command },
    });
    return c.json({ operation }, 202);
  });
  app.get('/v1/operations/:operationId', async (c) => {
    const principal = c.get('principal');
    const operationId = operationIdSchema.parse(c.req.param('operationId'));
    const [row] = await input.db
      .select()
      .from(operations)
      .where(and(eq(operations.id, operationId), eq(operations.accountId, principal.accountId)));
    if (!row) throw new CloudError('not_found', 'Operation not found.');
    const operation = operationRecord(row);
    authorize(principal, 'machine:read', operation.projectId);
    return c.json({ operation });
  });
  app.post('/v1/grants', async (c) => {
    const principal = c.get('principal');
    const body = grantInputSchema.parse(await c.req.json<unknown>());
    const grant = await input.db.transaction(async (tx) => {
      await lockAccount(tx, principal);
      return issueGrant(tx, { principal, ...body, expiresAt: new Date(body.expiresAt) });
    });
    return c.json({ grant }, 201);
  });
  app.delete('/v1/grants/:grantId', async (c) => {
    const principal = c.get('principal');
    const grantId = grantIdSchema.parse(c.req.param('grantId'));
    await input.db.transaction(async (tx) => {
      await lockAccount(tx, principal);
      await revokeGrant(tx, { principal: await loadPrincipal(tx, principal.grantId), grantId });
    });
    return c.json({ revoked: true });
  });
  app.get('/v1/usage', async (c) => {
    const principal = c.get('principal');
    authorize(principal, 'usage:read');
    const rows = await input.db
      .select()
      .from(allocations)
      .where(and(eq(allocations.accountId, principal.accountId), isNull(allocations.retiredAt)));
    if (rows.some((row) => row.currency !== principal.policy.currency))
      throw new CloudError(
        'internal_error',
        'Stored reservations do not match the credential currency.',
      );
    return c.json({
      usage: {
        activeReservations: rows.length,
        hourlyMicros: rows.reduce((sum, row) => sum + row.hourlyMicros, 0),
        currency: principal.policy.currency,
        pricing: 'reservation',
        poweredOffMachinesRemainBillable: true,
      },
    });
  });
  return app;
}

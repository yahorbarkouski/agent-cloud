import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { ZodError, z } from 'zod';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  referenceInputSchema,
  type CapabilitiesResponse,
  accessSessionIdSchema,
  accessSessionRequestSchema,
  gatewayClaimSchema,
  gatewayCheckSchema,
  gatewayCloseSchema,
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
  githubTokenSchema,
  loginRequestSchema,
  routePublishSchema,
  routeRemoveSchema,
  hostnameSchema,
  domainCreateSchema,
  backupCaptureRequestSchema,
  backupPurgeRequestSchema,
  backupPurgeIdSchema,
  backupScheduleRequestSchema,
  backupScheduleIdSchema,
  backupIdSchema,
  reservationCursorSchema,
  restoreRequestSchema,
  restoreIdSchema,
} from '@agent-cloud/contracts';
import {
  projects,
  machines,
  operations,
  operationRecord,
  machineRecord,
  projectRecord,
  type Database,
} from '@agent-cloud/db';
import type { InternalReference } from './internal-reference.js';
import type { HostingService } from './hosting.js';
import type { BackupService } from './backups.js';
import type { CustomerLogin } from './customer-login.js';
import type { AccessService } from './access-sessions.js';
import {
  authenticate,
  authorize,
  issueGrant,
  listGrants,
  loadPrincipal,
  revokeGrant,
} from './auth.js';
import { recipes, findRecipe } from '@agent-cloud/recipes/catalog';
import { readUsage, readReservationHistory } from './usage.js';
import { admit, lockAccount } from './lifecycle.js';
import type { ImageReleaseSelection } from './allocation-image.js';
import type { Config } from './config.js';
import type { GuestRenewalService } from './guest-renewal.js';
import type { EnrollmentService } from './guest-enrollment.js';
import type { ImageVerifierEnrollment } from './image-verifier-enrollment.js';
import { customerApiDescription, customerLlmsText } from './customer-api-description.js';

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
  access?: AccessService;
  login?: CustomerLogin;
  hosting?: { service: HostingService; gatewayToken: string };
  backups?: BackupService;
  checkControl?: () => Promise<void>;
}) {
  const app = new Hono<{ Variables: { principal: Principal; requestId: string } }>();
  app.use('*', async (c, next) => {
    c.set('requestId', randomUUID());
    c.header('X-Request-Id', c.get('requestId'));
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.use('*', secureHeaders());
  app.use('*', async (_c, next) => {
    await input.checkControl?.();
    await next();
  });
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
  if (input.customerAccess !== 'disabled') {
    const description = customerApiDescription({
      login: Boolean(input.login),
      access: Boolean(input.access),
      routing: Boolean(input.hosting),
      protectedBackups: Boolean(input.backups),
    });
    app.get('/openapi.json', (c) => c.json(description));
    app.get('/llms.txt', (c) => c.text(customerLlmsText));
  }
  if (input.login && input.customerAccess !== 'disabled') {
    const login = input.login;
    app.get('/auth/config', (c) => c.json(login.config));
    app.post('/auth/github', async (c) => {
      const authorization = c.req.header('Authorization');
      if (!authorization?.startsWith('Bearer '))
        throw new CloudError('unauthenticated', 'GitHub sign-in is required.');
      return c.json(
        await login.login(
          githubTokenSchema.parse(authorization.slice(7)),
          loginRequestSchema.parse(await c.req.json<unknown>()),
        ),
      );
    });
  }
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
  app.get('/v1/capabilities', (c) =>
    c.json({
      protocolVersion: 1,
      provider: input.provider,
      configured: {
        machineLifecycle: true,
        ssh: Boolean(input.access),
        files: Boolean(input.access),
        durableCommands: Boolean(input.access),
        compose: Boolean(input.access),
        routing: Boolean(input.hosting),
        protectedBackups: Boolean(input.backups),
        recipes: true,
      },
    } satisfies CapabilitiesResponse),
  );
  if (input.access && input.customerAccess !== 'disabled') {
    const access = input.access;
    app.post('/v1/machines/:machineId/access-sessions', async (c) =>
      c.json(
        await access.admit(
          c.get('principal'),
          machineIdSchema.parse(c.req.param('machineId')),
          accessSessionRequestSchema.parse(await c.req.json<unknown>()),
          idempotencyKeySchema.parse(c.req.header('Idempotency-Key')),
        ),
        202,
      ),
    );
    app.get('/v1/access-sessions/:id', async (c) =>
      c.json(
        await access.inspect(c.get('principal'), accessSessionIdSchema.parse(c.req.param('id'))),
      ),
    );
    app.use('/gateway/v1/*', async (c, next) => {
      access.authenticateGateway(c.req.header('Authorization'));
      await next();
    });
    app.post('/gateway/v1/claim', async (c) =>
      c.json(await access.claim(gatewayClaimSchema.parse(await c.req.json<unknown>()))),
    );
    app.post('/gateway/v1/check', async (c) =>
      c.json(await access.check(gatewayCheckSchema.parse(await c.req.json<unknown>()).connections)),
    );
    app.post('/gateway/v1/close', async (c) =>
      c.json(await access.close(gatewayCloseSchema.parse(await c.req.json<unknown>()))),
    );
  }
  if (input.hosting && input.customerAccess !== 'disabled') {
    const hosting = input.hosting.service;
    const token = z
      .string()
      .regex(/^acld_hosting_[A-Za-z0-9_-]{43}$/)
      .parse(input.hosting.gatewayToken);
    const expected = createHash('sha256').update(`Bearer ${token}`).digest();
    app.use('/hosting/v1/*', async (c, next) => {
      if (
        !timingSafeEqual(
          expected,
          createHash('sha256')
            .update(c.req.header('Authorization') ?? '')
            .digest(),
        )
      )
        throw new CloudError('unauthenticated', 'Public gateway authentication is required.');
      await next();
    });
    app.get('/hosting/v1/snapshot', async (c) => c.json(await hosting.snapshot()));
    app.post('/hosting/v1/ack', async (c) =>
      c.json(
        await hosting.acknowledge(
          z
            .strictObject({ revision: z.string().regex(/^[a-f0-9]{64}$/) })
            .parse(await c.req.json<unknown>()).revision,
        ),
      ),
    );
    app.get('/v1/routes', async (c) => c.json({ routes: await hosting.list(c.get('principal')) }));
    app.get('/v1/routes/:hostname', async (c) =>
      c.json({
        route: await hosting.inspect(
          c.get('principal'),
          hostnameSchema.parse(c.req.param('hostname')),
        ),
      }),
    );
    app.post('/v1/routes', async (c) =>
      c.json(
        {
          route: await hosting.publish(
            c.get('principal'),
            routePublishSchema.parse(await c.req.json<unknown>()),
          ),
        },
        202,
      ),
    );
    app.post('/v1/routes/:hostname/remove', async (c) =>
      c.json(
        {
          route: await hosting.remove(
            c.get('principal'),
            hostnameSchema.parse(c.req.param('hostname')),
            routeRemoveSchema.parse(await c.req.json<unknown>()),
          ),
        },
        202,
      ),
    );
    app.post('/v1/domains', async (c) =>
      c.json(
        {
          domain: await hosting.domains.create(
            c.get('principal'),
            domainCreateSchema.parse(await c.req.json<unknown>()).hostname,
          ),
        },
        201,
      ),
    );
    app.post('/v1/domains/:id/verify', async (c) =>
      c.json({
        domain: await hosting.domains.verify(
          c.get('principal'),
          z.uuidv4().parse(c.req.param('id')),
        ),
      }),
    );
  }
  app.get('/v1/recipes', (c) => c.json({ recipes }));
  app.get('/v1/recipes/:id', (c) =>
    c.json({ recipe: findRecipe(c.req.param('id'), c.req.query('version')) }),
  );
  app.get('/v1/catalog', (c) => c.json(input.catalog()));
  if (input.backups && input.customerAccess !== 'disabled') {
    const backups = input.backups;
    app.post('/v1/backups/:id/purge', async (c) =>
      c.json(
        {
          purge: await backups.purges.request(
            c.get('principal'),
            backupIdSchema.parse(c.req.param('id')),
            backupPurgeRequestSchema.parse(await c.req.json<unknown>()),
          ),
        },
        202,
      ),
    );
    app.get('/v1/backup-purges/:id', async (c) =>
      c.json({
        purge: await backups.purges.inspect(
          c.get('principal'),
          backupPurgeIdSchema.parse(c.req.param('id')),
        ),
      }),
    );
    app.post('/v1/machines/:machineId/backup-schedules', async (c) =>
      c.json(
        {
          schedule: await backups.schedules.create(
            c.get('principal'),
            machineIdSchema.parse(c.req.param('machineId')),
            backupScheduleRequestSchema.parse(await c.req.json<unknown>()),
          ),
        },
        202,
      ),
    );
    app.get('/v1/machines/:machineId/backup-schedules', async (c) =>
      c.json({
        schedules: await backups.schedules.list(
          c.get('principal'),
          machineIdSchema.parse(c.req.param('machineId')),
        ),
      }),
    );
    app.get('/v1/backup-schedules/:id', async (c) =>
      c.json({
        schedule: await backups.schedules.inspect(
          c.get('principal'),
          backupScheduleIdSchema.parse(c.req.param('id')),
        ),
      }),
    );
    app.delete('/v1/backup-schedules/:id', async (c) =>
      c.json({
        schedule: await backups.schedules.disable(
          c.get('principal'),
          backupScheduleIdSchema.parse(c.req.param('id')),
        ),
      }),
    );
    app.post('/v1/machines/:machineId/backups', async (c) =>
      c.json(
        {
          backup: await backups.capture(
            c.get('principal'),
            machineIdSchema.parse(c.req.param('machineId')),
            backupCaptureRequestSchema.parse(await c.req.json<unknown>()),
          ),
        },
        202,
      ),
    );
    app.get('/v1/machines/:machineId/backups', async (c) =>
      c.json({
        backups: await backups.list(
          c.get('principal'),
          machineIdSchema.parse(c.req.param('machineId')),
        ),
      }),
    );
    app.get('/v1/backups/:id', async (c) =>
      c.json({
        backup: await backups.inspect(c.get('principal'), backupIdSchema.parse(c.req.param('id'))),
      }),
    );
    app.post('/v1/restores', async (c) =>
      c.json(
        {
          restore: await backups.restore(
            c.get('principal'),
            restoreRequestSchema.parse(await c.req.json<unknown>()),
            input,
          ),
        },
        202,
      ),
    );
    app.get('/v1/restores/:id', async (c) =>
      c.json({
        restore: await backups.inspectRestore(
          c.get('principal'),
          restoreIdSchema.parse(c.req.param('id')),
        ),
      }),
    );
  }
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
  app.get('/v1/grants', async (c) => {
    const after = grantIdSchema.optional().parse(c.req.query('after'));
    return c.json(
      await listGrants(input.db, {
        principal: c.get('principal'),
        ...(after === undefined ? {} : { after }),
      }),
    );
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
  app.get('/v1/usage', async (c) =>
    c.json(
      await readUsage({
        db: input.db,
        principal: c.get('principal'),
        ...(input.backups ? { backupLimits: input.backups.limits } : {}),
      }),
    ),
  );
  app.get('/v1/usage/history', async (c) => {
    const before = reservationCursorSchema.optional().parse(c.req.query('before'));
    return c.json(
      await readReservationHistory({
        db: input.db,
        principal: c.get('principal'),
        ...(before === undefined ? {} : { before }),
      }),
    );
  });
  return app;
}

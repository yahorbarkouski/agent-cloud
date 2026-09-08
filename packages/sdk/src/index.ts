import { setTimeout } from 'node:timers/promises';
export { loginConfiguration, exchangeGithubLogin, readLoginJson } from './login.js';
import { z } from 'zod';
import {
  backupCaptureRequestSchema,
  backupPurgeIdSchema,
  backupPurgeRequestSchema,
  backupPurgeResponseSchema,
  backupScheduleIdSchema,
  backupScheduleRequestSchema,
  backupScheduleResponseSchema,
  backupSchedulesResponseSchema,
  backupIdSchema,
  backupResponseSchema,
  backupsResponseSchema,
  machineIdSchema,
  restoreIdSchema,
  restoreRequestSchema,
  restoreResponseSchema,
  referenceInputSchema,
  routePublishSchema,
  routeRemoveSchema,
  routeResponseSchema,
  routesResponseSchema,
  domainCreateSchema,
  domainResponseSchema,
  hostnameSchema,
  type RoutePublish,
  type RouteRemove,
  accessSessionResponseSchema,
  accessSessionRequestSchema,
  type AccessSessionRequest,
  type AccessSessionId,
  referenceResponseSchema,
  type ReferenceInput,
  credentialsSchema,
  errorResponseSchema,
  CloudError,
  catalogResponseSchema,
  whoamiResponseSchema,
  projectsResponseSchema,
  projectInputSchema,
  projectResponseSchema,
  machinesResponseSchema,
  machineResponseSchema,
  machineSpecSchema,
  machineActionSchema,
  operationResponseSchema,
  usageResponseSchema,
  reservationCursorSchema,
  reservationHistoryResponseSchema,
  grantInputSchema,
  grantsResponseSchema,
  issuedGrantResponseSchema,
  revokedResponseSchema,
  isOperationTerminal,
  idempotencyKeySchema,
  type ProjectId,
  type MachineId,
  type MachineSpec,
  type MachineAction,
  type OperationId,
  type GrantId,
} from '@agent-cloud/contracts';

export class CloudClient {
  readonly credentials: z.infer<typeof credentialsSchema>;
  readonly transport: typeof fetch;

  constructor(input: z.infer<typeof credentialsSchema> & { transport?: typeof fetch }) {
    this.credentials = credentialsSchema.parse(input);
    this.transport = input.transport ?? fetch;
  }

  private async request<T>(input: {
    path: string;
    schema: z.ZodType<T>;
    method?: 'POST' | 'DELETE';
    body?: unknown;
    key?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.credentials.token}`,
      Accept: 'application/json',
    };
    if (input.body !== undefined) headers['Content-Type'] = 'application/json';
    if (input.key !== undefined) headers['Idempotency-Key'] = idempotencyKeySchema.parse(input.key);
    const url = `${this.credentials.server.replace(/\/$/, '')}${input.path}`;
    const response = await this.transport(url, {
      method: input.method ?? 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.any([
        AbortSignal.timeout(input.timeoutMs ?? 15_000),
        ...(input.signal ? [input.signal] : []),
      ]),
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      const result = errorResponseSchema.safeParse(body);
      if (!result.success)
        throw new CloudError(
          'provider_unavailable',
          `API returned HTTP ${response.status} with an invalid error response.`,
          true,
        );
      throw new CloudError(
        result.data.error.code,
        result.data.error.message,
        result.data.error.retryable,
      );
    }
    return input.schema.parse(body);
  }

  internalReference(machineId: MachineId, command: ReferenceInput) {
    return this.request({
      path: `/internal/v1/machines/${machineId}/reference`,
      method: 'POST',
      body: referenceInputSchema.parse(command),
      schema: referenceResponseSchema,
      timeoutMs: 60_000,
    });
  }

  publishRoute(request: RoutePublish) {
    return this.request({
      path: '/v1/routes',
      method: 'POST',
      body: routePublishSchema.parse(request),
      schema: routeResponseSchema,
    });
  }
  removeRoute(hostname: string, request: RouteRemove) {
    return this.request({
      path: `/v1/routes/${hostnameSchema.parse(hostname)}/remove`,
      method: 'POST',
      body: routeRemoveSchema.parse(request),
      schema: routeResponseSchema,
    });
  }
  routes() {
    return this.request({ path: '/v1/routes', schema: routesResponseSchema });
  }
  route(hostname: string) {
    return this.request({
      path: `/v1/routes/${hostnameSchema.parse(hostname)}`,
      schema: routeResponseSchema,
    });
  }
  createDomain(hostname: string) {
    return this.request({
      path: '/v1/domains',
      method: 'POST',
      body: domainCreateSchema.parse({ hostname }),
      schema: domainResponseSchema,
    });
  }
  verifyDomain(id: string) {
    return this.request({
      path: `/v1/domains/${encodeURIComponent(id)}/verify`,
      method: 'POST',
      schema: domainResponseSchema,
    });
  }
  whoami() {
    return this.request({ path: '/v1/whoami', schema: whoamiResponseSchema });
  }
  captureBackup(input: {
    machineId: MachineId;
    request: z.input<typeof backupCaptureRequestSchema>;
  }) {
    return this.request({
      path: `/v1/machines/${machineIdSchema.parse(input.machineId)}/backups`,
      method: 'POST',
      body: backupCaptureRequestSchema.parse(input.request),
      schema: backupResponseSchema,
    });
  }
  createBackupSchedule(input: {
    machineId: MachineId;
    request: z.input<typeof backupScheduleRequestSchema>;
  }) {
    return this.request({
      path: `/v1/machines/${machineIdSchema.parse(input.machineId)}/backup-schedules`,
      method: 'POST',
      body: backupScheduleRequestSchema.parse(input.request),
      schema: backupScheduleResponseSchema,
    });
  }
  backupSchedule(id: string) {
    return this.request({
      path: `/v1/backup-schedules/${backupScheduleIdSchema.parse(id)}`,
      schema: backupScheduleResponseSchema,
    });
  }
  backupSchedules(machineId: MachineId) {
    return this.request({
      path: `/v1/machines/${machineIdSchema.parse(machineId)}/backup-schedules`,
      schema: backupSchedulesResponseSchema,
    });
  }
  disableBackupSchedule(id: string) {
    return this.request({
      path: `/v1/backup-schedules/${backupScheduleIdSchema.parse(id)}`,
      method: 'DELETE',
      schema: backupScheduleResponseSchema,
    });
  }
  backups(machineId: MachineId) {
    return this.request({
      path: `/v1/machines/${machineIdSchema.parse(machineId)}/backups`,
      schema: backupsResponseSchema,
    });
  }
  backup(id: string) {
    return this.request({
      path: `/v1/backups/${backupIdSchema.parse(id)}`,
      schema: backupResponseSchema,
    });
  }
  purgeBackup(input: { backupId: string; request: z.input<typeof backupPurgeRequestSchema> }) {
    return this.request({
      path: `/v1/backups/${backupIdSchema.parse(input.backupId)}/purge`,
      method: 'POST',
      body: backupPurgeRequestSchema.parse(input.request),
      schema: backupPurgeResponseSchema,
    });
  }
  backupPurge(id: string) {
    return this.request({
      path: `/v1/backup-purges/${backupPurgeIdSchema.parse(id)}`,
      schema: backupPurgeResponseSchema,
    });
  }
  restoreBackup(request: z.input<typeof restoreRequestSchema>) {
    return this.request({
      path: '/v1/restores',
      method: 'POST',
      body: restoreRequestSchema.parse(request),
      schema: restoreResponseSchema,
    });
  }
  restore(id: string) {
    return this.request({
      path: `/v1/restores/${restoreIdSchema.parse(id)}`,
      schema: restoreResponseSchema,
    });
  }
  async waitBackup(input: { backupId: string; timeoutMs?: number; signal?: AbortSignal }) {
    const id = backupIdSchema.parse(input.backupId);
    const timeout = z
      .number()
      .int()
      .min(1)
      .max(3_600_000)
      .parse(input.timeoutMs ?? 900_000);
    const deadline = performance.now() + timeout;
    for (;;) {
      input.signal?.throwIfAborted();
      const remaining = Math.ceil(deadline - performance.now());
      if (remaining <= 0)
        throw new CloudError(
          'provider_unavailable',
          `Backup wait timed out. Inspect backup ${id}; the admitted capture continues.`,
          true,
        );
      const result = await this.request({
        path: `/v1/backups/${id}`,
        schema: backupResponseSchema,
        timeoutMs: Math.min(remaining, 15_000),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (result.backup.state.kind !== 'pending') return result;
      await setTimeout(Math.min(1000, Math.max(0, deadline - performance.now())), undefined, {
        signal: input.signal,
      });
    }
  }
  async waitRestore(input: { restoreId: string; timeoutMs?: number; signal?: AbortSignal }) {
    const id = restoreIdSchema.parse(input.restoreId);
    const timeout = z
      .number()
      .int()
      .min(1)
      .max(3_600_000)
      .parse(input.timeoutMs ?? 900_000);
    const deadline = performance.now() + timeout;
    for (;;) {
      input.signal?.throwIfAborted();
      const remaining = Math.ceil(deadline - performance.now());
      if (remaining <= 0)
        throw new CloudError(
          'provider_unavailable',
          `Restore wait timed out. Inspect restore ${id}; the isolated machine operation continues.`,
          true,
        );
      const result = await this.request({
        path: `/v1/restores/${id}`,
        schema: restoreResponseSchema,
        timeoutMs: Math.min(remaining, 15_000),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (result.restore.state.kind !== 'pending') return result;
      await setTimeout(Math.min(1000, Math.max(0, deadline - performance.now())), undefined, {
        signal: input.signal,
      });
    }
  }
  createAccessSession(input: { machineId: MachineId; request: AccessSessionRequest; key: string }) {
    return this.request({
      path: `/v1/machines/${input.machineId}/access-sessions`,
      method: 'POST',
      body: accessSessionRequestSchema.parse(input.request),
      key: input.key,
      schema: accessSessionResponseSchema,
    });
  }
  accessSession(id: AccessSessionId) {
    return this.request({ path: `/v1/access-sessions/${id}`, schema: accessSessionResponseSchema });
  }
  async waitAccessSession(id: AccessSessionId, signal?: AbortSignal) {
    const started = performance.now();
    for (;;) {
      signal?.throwIfAborted();
      const result = await this.accessSession(id);
      if (result.session.connection.kind !== 'unclaimed')
        throw new CloudError('permission_denied', 'Access session was consumed or closed.');
      if (result.session.issuance.kind === 'issued') return result;
      if (result.session.issuance.kind === 'unavailable')
        throw new CloudError(
          'guest_unreachable',
          `Access unavailable: ${result.session.issuance.reason}.`,
        );
      if (performance.now() - started > 90_000)
        throw new CloudError(
          'provider_unavailable',
          'Access issuance timed out; inspect this session before retrying.',
          true,
        );
      await setTimeout(500, undefined, { signal });
    }
  }
  catalog() {
    return this.request({ path: '/v1/catalog', schema: catalogResponseSchema });
  }
  projects() {
    return this.request({ path: '/v1/projects', schema: projectsResponseSchema });
  }
  createProject(name: string) {
    return this.request({
      path: '/v1/projects',
      method: 'POST',
      body: projectInputSchema.parse({ name }),
      schema: projectResponseSchema,
    });
  }
  machines(projectId: ProjectId) {
    return this.request({
      path: `/v1/projects/${projectId}/machines`,
      schema: machinesResponseSchema,
    });
  }
  machine(machineId: MachineId) {
    return this.request({ path: `/v1/machines/${machineId}`, schema: machineResponseSchema });
  }
  createMachine(input: { projectId: ProjectId; spec: MachineSpec; idempotencyKey: string }) {
    return this.request({
      path: `/v1/projects/${input.projectId}/machines`,
      method: 'POST',
      body: machineSpecSchema.parse(input.spec),
      key: input.idempotencyKey,
      schema: operationResponseSchema,
    });
  }
  act(input: { machineId: MachineId; command: MachineAction; idempotencyKey: string }) {
    return this.request({
      path: `/v1/machines/${input.machineId}/actions`,
      method: 'POST',
      body: machineActionSchema.parse(input.command),
      key: input.idempotencyKey,
      schema: operationResponseSchema,
    });
  }
  operation(operationId: OperationId) {
    return this.request({ path: `/v1/operations/${operationId}`, schema: operationResponseSchema });
  }
  reservationHistory(before?: string) {
    const query = before === undefined ? '' : `?before=${reservationCursorSchema.parse(before)}`;
    return this.request({
      path: `/v1/usage/history${query}`,
      schema: reservationHistoryResponseSchema,
    });
  }
  usage() {
    return this.request({ path: '/v1/usage', schema: usageResponseSchema });
  }
  issueGrant(input: z.infer<typeof grantInputSchema>) {
    return this.request({
      path: '/v1/grants',
      method: 'POST',
      body: grantInputSchema.parse(input),
      schema: issuedGrantResponseSchema,
    });
  }
  grants(after?: GrantId) {
    return this.request({
      path: `/v1/grants${after === undefined ? '' : `?after=${encodeURIComponent(after)}`}`,
      schema: grantsResponseSchema,
    });
  }
  revokeGrant(grantId: GrantId) {
    return this.request({
      path: `/v1/grants/${grantId}`,
      method: 'DELETE',
      schema: revokedResponseSchema,
    });
  }
  async waitOperation(input: {
    operationId: OperationId;
    timeoutMs?: number;
    signal?: AbortSignal;
  }) {
    const deadline = Date.now() + (input.timeoutMs ?? 300_000);
    for (;;) {
      input.signal?.throwIfAborted();
      const result = await this.operation(input.operationId);
      if (isOperationTerminal(result.operation) || result.operation.progress.kind === 'blocked')
        return result;
      if (Date.now() >= deadline)
        throw new CloudError(
          'provider_unavailable',
          'Wait timed out; the operation continues. Inspect its ID before retrying.',
          true,
        );
      await setTimeout(1_000, undefined, { signal: input.signal });
    }
  }
}

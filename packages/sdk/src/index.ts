import { setTimeout } from 'node:timers/promises';
export { loginConfiguration, exchangeGithubLogin, readLoginJson } from './login.js';
import type { z } from 'zod';
import {
  referenceInputSchema,
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
      signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
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

  whoami() {
    return this.request({ path: '/v1/whoami', schema: whoamiResponseSchema });
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

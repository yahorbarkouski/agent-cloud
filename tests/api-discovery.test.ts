import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { simulatedCatalog } from '../packages/contracts/src/index.js';
import { createApp } from '../apps/control/src/app.js';
import { createHosting } from '../apps/control/src/hosting.js';
import { createBackups } from '../apps/control/src/backups.js';
import { backupControlConfigSchema } from '../apps/control/src/backup-records.js';
import { seedAccount, testDatabase } from './database.js';

type AppInput = Parameters<typeof createApp>[0];
let database: Awaited<ReturnType<typeof testDatabase>>;
let owner: Awaited<ReturnType<typeof seedAccount>>;
let app: ReturnType<typeof createApp>;
let server: ReturnType<typeof serve>;
let endpoint: string;
const noIo = vi.fn((): never => {
  throw new Error('Discovery must not call a service.');
});
const object = z.record(z.string(), z.unknown());
const reference = z.object({ $ref: z.string() });
const content = z.object({ 'application/json': z.object({ schema: reference }) });
const response = z.union([reference, z.object({ description: z.string(), content })]);
const parameter = z.object({
  name: z.string(),
  in: z.enum(['path', 'query', 'header']),
  required: z.boolean(),
  schema: object,
});
const operation = z.object({
  operationId: z.string(),
  summary: z.string(),
  description: z.string(),
  security: z.array(z.record(z.string(), z.array(z.string()))),
  parameters: z.array(parameter).optional(),
  requestBody: z.object({ required: z.literal(true), content }).optional(),
  responses: z.record(z.string(), response),
});
const documentSchema = z.object({
  openapi: z.literal('3.1.0'),
  jsonSchemaDialect: z.literal('https://json-schema.org/draft/2020-12/schema'),
  info: z.object({ title: z.string(), version: z.literal('1'), description: z.string() }),
  servers: z.tuple([z.object({ url: z.literal('/') })]),
  paths: z.record(z.string(), z.record(z.string().regex(/^(get|post|delete)$/), operation)),
  components: z.object({
    schemas: z.record(z.string(), object),
    securitySchemes: object,
    headers: object,
    responses: object,
  }),
});
type Document = z.infer<typeof documentSchema>;

function makeApp(extra: Partial<AppInput> = {}) {
  return createApp({
    db: database.connection.db,
    provider: 'simulated',
    catalog: simulatedCatalog,
    limits: { currency: 'EUR', maxMachines: 10, maxHourlyMicros: 1_000_000 },
    ...extra,
  });
}
function configuredServices() {
  const access = {
    admit: noIo,
    inspect: noIo,
    issue: noIo,
    enqueue: noIo,
    authenticateGateway: noIo,
    claim: noIo,
    check: noIo,
    close: noIo,
  } satisfies NonNullable<AppInput['access']>;
  const hosting = {
    service: createHosting({
      db: database.connection.db,
      config: {
        version: 1,
        applicationDomain: 'apps.private.example',
        gatewayTokenFile: '/private/gateway-token',
        gatewayAddresses: ['192.0.2.10'],
        gatewayOrigin: 'https://private-gateway.example',
      },
      resolve: noIo,
      applyGuest: noIo,
    }),
    gatewayToken: 'acld_hosting_' + 'a'.repeat(43),
  };
  const backups = createBackups({
    db: database.connection.db,
    advance: noIo,
    config: backupControlConfigSchema.parse({
      version: 1,
      directory: '/private/backup-scratch',
      store: {
        endpoint: 'https://private-store.example',
        region: 'fixture-1',
        bucket: 'private-bucket',
        keyPrefix: 'protected',
        maxBytes: 1_048_576,
      },
      writerCredentialsFile: '/private/writer',
      readerCredentialsFile: '/private/reader',
      keyringFile: '/private/keyring',
      limits: { maxBytes: 1_048_576, timeoutSeconds: 30 },
      maxGlobalBytes: 1_048_576,
    }),
  });
  return {
    access,
    hosting,
    backups,
    login: {
      config: { provider: 'github', clientId: 'fixture-public-client', invitationRequired: true },
      login: noIo,
    },
  } satisfies Partial<AppInput>;
}
beforeAll(async () => {
  database = await testDatabase();
  server = serve({ fetch: (request) => app.fetch(request), hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected fixture HTTP listener.');
  endpoint = `http://127.0.0.1:${address.port}`;
});
beforeEach(async () => {
  await database.reset();
  owner = await seedAccount(database.connection.db);
  app = makeApp();
  noIo.mockClear();
});
afterAll(async () => {
  if ('closeAllConnections' in server) server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    }),
  );
  await database.close();
});
async function document() {
  const response = await fetch(`${endpoint}/openapi.json`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(response.headers.get('x-request-id')).toMatch(/^[a-f0-9-]{36}$/);
  return documentSchema.parse(await response.json());
}
function resolve(document: Document, ref: string): unknown {
  expect(ref).toMatch(/^#\/components\/(schemas|headers|responses)\//);
  return ref
    .slice(2)
    .split('/')
    .reduce<unknown>((value, key) => object.parse(value)[key], document);
}
function schema(document: Document, name: string) {
  return z.fromJSONSchema(object.parse(document.components.schemas[name]));
}
function getOperation(document: Document, path: string, method: string) {
  return operation.parse(document.paths[path]?.[method]);
}
function checkReferences(document: Document, value: unknown = document) {
  if (Array.isArray(value)) {
    for (const item of value) checkReferences(document, item);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const fields = object.parse(value);
  if (typeof fields.$ref === 'string') expect(resolve(document, fields.$ref)).toBeDefined();
  for (const item of Object.values(fields)) checkReferences(document, item);
}

it('serves public machine-readable discovery over HTTP without exposing deployment values', async () => {
  const spec = await document();
  const text = await fetch(`${endpoint}/llms.txt`);
  expect(text.status).toBe(200);
  expect(text.headers.get('content-type')).toContain('text/plain');
  const guide = await text.text();
  expect(guide).toContain('[OpenAPI 3.1](/openapi.json)');
  expect(guide).toContain('Idempotency-Key');
  expect(guide).toContain('HTTP 202 is admission, not completion');
  expect(guide).toContain('grant policy');
  expect(JSON.stringify(spec)).not.toContain(owner.token);
  expect(JSON.stringify(spec)).not.toContain(endpoint);
  expect((await fetch(`${endpoint}/v1/whoami`)).status).toBe(401);
  expect(noIo).not.toHaveBeenCalled();
});

it('covers every registered public customer method while excluding guest, gateway and operator protocols', async () => {
  app = makeApp({
    ...configuredServices(),
    enrollment: { enroll: noIo },
    renewal: { renew: noIo },
    imageEnrollment: { enroll: noIo },
    internalReference: noIo,
  });
  const spec = await document();
  const documented = Object.entries(spec.paths)
    .flatMap(([path, methods]) =>
      Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
    )
    .sort();
  const registered = app.routes
    .filter(
      (route) =>
        ['GET', 'POST', 'DELETE'].includes(route.method) && /^\/(auth|v1)\//.test(route.path),
    )
    .map((route) => `${route.method} ${route.path.replace(/:([A-Za-z]+)/g, '{$1}')}`)
    .sort();
  expect(documented).toEqual(registered);
  expect(documented).toHaveLength(38);
  const ids = Object.values(spec.paths).flatMap((methods) =>
    Object.values(methods).map((method) => method.operationId),
  );
  expect(new Set(ids).size).toBe(ids.length);
  checkReferences(spec);
  for (const [path, methods] of Object.entries(spec.paths)) {
    const names = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort();
    for (const method of Object.values(methods)) {
      expect(
        (method.parameters ?? [])
          .filter((item) => item.in === 'path')
          .map((item) => item.name)
          .sort(),
      ).toEqual(names);
      for (const parameter of method.parameters ?? [])
        if (parameter.in === 'path') expect(parameter.required).toBe(true);
    }
  }
  expect(Object.keys(spec.components.securitySchemes).sort()).toEqual([
    'CustomerBearer',
    'GitHubOAuth',
  ]);
  expect(getOperation(spec, '/auth/config', 'get').security).toEqual([]);
  expect(getOperation(spec, '/auth/github', 'post').security).toEqual([{ GitHubOAuth: [] }]);
  expect(getOperation(spec, '/v1/whoami', 'get').security).toEqual([{ CustomerBearer: [] }]);
  const serialized = JSON.stringify(spec);
  for (const excluded of [
    '/guest/',
    '/image/',
    '/gateway/',
    '/hosting/',
    '/internal/',
    '/private/',
    'private-store.example',
    'private-gateway.example',
    'fixture-public-client',
    'acld_hosting_' + 'a'.repeat(43),
  ])
    expect(serialized).not.toContain(excluded);
  for (const value of Object.values(spec.components.schemas))
    expect(() => z.fromJSONSchema(value)).not.toThrow();
  expect(noIo).not.toHaveBeenCalled();
});

it('filters optional routes and keeps image factory customer access disabled', async () => {
  const base = await document();
  for (const path of ['/auth/config', '/v1/routes', '/v1/restores', '/v1/access-sessions/{id}'])
    expect(base.paths[path]).toBeUndefined();
  const services = configuredServices();
  app = makeApp({ access: services.access });
  const access = await document();
  expect(access.paths['/v1/access-sessions/{id}']).toBeDefined();
  expect(access.paths['/v1/routes']).toBeUndefined();
  const absent = await fetch(`${endpoint}/v1/routes`, {
    headers: { Authorization: `Bearer ${owner.token}` },
  });
  expect(absent.status).toBe(404);
  app = makeApp({ ...services, customerAccess: 'disabled' });
  for (const path of ['/openapi.json', '/llms.txt', '/auth/config'])
    expect((await fetch(endpoint + path)).status).toBe(404);
  expect(
    (await fetch(`${endpoint}/v1/whoami`, { headers: { Authorization: `Bearer ${owner.token}` } }))
      .status,
  ).toBe(403);
  expect(noIo).not.toHaveBeenCalled();
});

it('describes input defaults, discriminated actions and real authenticated/error HTTP responses', async () => {
  const spec = await document();
  const projectInput = schema(spec, 'ProjectInput');
  expect(projectInput.safeParse({ name: 'valid-project' }).success).toBe(true);
  expect(projectInput.safeParse({ name: 'invalid project', extra: true }).success).toBe(false);
  expect(
    schema(spec, 'MachineAction').safeParse({ kind: 'destroy', expectedVersion: 1 }).success,
  ).toBe(false);
  const capture = {
    id: randomUUID(),
    recipe: {
      kind: 'compose-postgres',
      app: 'postgres',
      releaseId: randomUUID(),
      service: 'database',
      database: 'app',
      user: 'app',
    },
  };
  expect(schema(spec, 'BackupCaptureRequest').safeParse(capture).success).toBe(true);
  const cases: [string, string][] = [
    ['/v1/whoami', 'WhoamiResponse'],
    ['/v1/capabilities', 'CapabilitiesResponse'],
    ['/v1/projects', 'ProjectsResponse'],
    ['/v1/catalog', 'CatalogResponse'],
    ['/v1/recipes', 'RecipesResponse'],
    ['/v1/usage', 'UsageResponse'],
  ];
  for (const [path, responseSchema] of cases) {
    const response = await fetch(endpoint + path, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(response.status).toBe(200);
    expect(schema(spec, responseSchema).safeParse(await response.json()).success).toBe(true);
  }
  const denied = await fetch(`${endpoint}/v1/whoami`);
  expect(denied.status).toBe(401);
  const failure: unknown = await denied.json();
  expect(schema(spec, 'ErrorResponse').safeParse(failure).success).toBe(true);
  expect(object.parse(failure).requestId).toBe(denied.headers.get('x-request-id'));
});

it('documents and exercises admission idempotency rather than interpreting HTTP 202 as completion', async () => {
  const spec = await document();
  const path = '/v1/projects/{projectId}/machines';
  const operation = getOperation(spec, path, 'post');
  expect(operation.parameters?.find((item) => item.name === 'Idempotency-Key')).toMatchObject({
    in: 'header',
    required: true,
  });
  expect(operation.responses['202']).toBeDefined();
  expect(operation.description).toContain('not completion');
  const create = (key?: string, name = 'discovered-machine') =>
    fetch(`${endpoint}/v1/projects/${owner.projectId}/machines`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${owner.token}`,
        'Content-Type': 'application/json',
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      body: JSON.stringify({ name, size: 'small', region: 'nbg1' }),
    });
  expect((await create()).status).toBe(400);
  const key = randomUUID();
  const admitted = await create(key);
  expect(admitted.status).toBe(202);
  const body: unknown = await admitted.json();
  expect(schema(spec, 'OperationResponse').safeParse(body).success).toBe(true);
  const repeated = await create(key);
  expect(repeated.status).toBe(202);
  expect(await repeated.json()).toEqual(body);
  expect((await create(key, 'different-machine')).status).toBe(409);
});

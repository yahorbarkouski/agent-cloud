import { z } from 'zod';
import * as contract from '@agent-cloud/contracts';

const requests = {
  LoginRequest: contract.loginRequestSchema,
  ProjectInput: contract.projectInputSchema,
  MachineSpec: contract.machineSpecSchema,
  MachineAction: contract.machineActionSchema,
  GrantInput: contract.grantInputSchema,
  AccessSessionRequest: contract.accessSessionRequestSchema,
  RoutePublish: contract.routePublishSchema,
  RouteRemove: contract.routeRemoveSchema,
  DomainCreate: contract.domainCreateSchema,
  BackupCaptureRequest: contract.backupCaptureRequestSchema,
  BackupScheduleRequest: contract.backupScheduleRequestSchema,
  BackupPurgeRequest: contract.backupPurgeRequestSchema,
  RestoreRequest: contract.restoreRequestSchema,
};
const responses = {
  LoginConfig: contract.loginConfigSchema,
  LoginResponse: contract.loginResponseSchema,
  WhoamiResponse: contract.whoamiResponseSchema,
  CapabilitiesResponse: contract.capabilitiesResponseSchema,
  CatalogResponse: contract.catalogResponseSchema,
  ProjectsResponse: contract.projectsResponseSchema,
  ProjectResponse: contract.projectResponseSchema,
  MachinesResponse: contract.machinesResponseSchema,
  MachineResponse: contract.machineResponseSchema,
  OperationResponse: contract.operationResponseSchema,
  GrantsResponse: contract.grantsResponseSchema,
  IssuedGrantResponse: contract.issuedGrantResponseSchema,
  RevokedResponse: contract.revokedResponseSchema,
  UsageResponse: contract.usageResponseSchema,
  ReservationHistoryResponse: contract.reservationHistoryResponseSchema,
  AccessSessionResponse: contract.accessSessionResponseSchema,
  RoutesResponse: contract.routesResponseSchema,
  RouteResponse: contract.routeResponseSchema,
  DomainResponse: contract.domainResponseSchema,
  RecipesResponse: contract.recipesResponseSchema,
  RecipeResponse: contract.recipeResponseSchema,
  BackupResponse: contract.backupResponseSchema,
  BackupsResponse: contract.backupsResponseSchema,
  BackupScheduleResponse: contract.backupScheduleResponseSchema,
  BackupSchedulesResponse: contract.backupSchedulesResponseSchema,
  BackupPurgeResponse: contract.backupPurgeResponseSchema,
  RestoreResponse: contract.restoreResponseSchema,
  ErrorResponse: contract.errorResponseSchema,
};
const jsonSchema = (schema: z.ZodType, io: 'input' | 'output') =>
  z.toJSONSchema(schema, { target: 'draft-2020-12', io, cycles: 'throw' });
const schemas = Object.fromEntries([
  ...Object.entries(requests).map(([name, schema]): [string, ReturnType<typeof jsonSchema>] => [
    name,
    jsonSchema(schema, 'input'),
  ]),
  ...Object.entries(responses).map(([name, schema]): [string, ReturnType<typeof jsonSchema>] => [
    name,
    jsonSchema(schema, 'output'),
  ]),
]);
const reference = (name: keyof typeof requests | keyof typeof responses) => ({
  $ref: `#/components/schemas/${name}`,
});
function parameter(
  name: string,
  location: 'path' | 'query',
  schema: z.ZodType,
  description: string,
) {
  return {
    name,
    in: location,
    required: location === 'path',
    description,
    schema: jsonSchema(schema, 'input'),
  };
}
const machine = parameter('machineId', 'path', contract.machineIdSchema, 'Owned machine ID.');
const project = parameter('projectId', 'path', contract.projectIdSchema, 'Accessible project ID.');
const hostname = parameter(
  'hostname',
  'path',
  contract.hostnameSchema,
  'Exact lowercase ASCII DNS hostname; no wildcard or trailing dot.',
);
const id = (schema: z.ZodType) =>
  parameter('id', 'path', schema, 'Exact ID returned by the API or persisted before admission.');
const requestIdHeader = { $ref: '#/components/headers/RequestId' };
const idempotencyHeader = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  description:
    'Persist before submission. Retry an uncertain response with the same key and identical request; changed input conflicts. A new key can admit another operation.',
  schema: jsonSchema(contract.idempotencyKeySchema, 'input'),
};
type Feature = 'login' | 'access' | 'routing' | 'protectedBackups';
type Operation = {
  method: 'get' | 'post' | 'delete';
  path: string;
  operationId: string;
  summary: string;
  response: keyof typeof responses;
  body?: keyof typeof requests;
  status?: 200 | 201 | 202;
  feature?: Feature;
  authentication?: 'public' | 'github';
  parameters?: ReturnType<typeof parameter>[];
  idempotency?: 'header' | 'id' | 'commandId' | 'name' | 'none';
  description?: string;
};
const operations: Operation[] = [
  {
    method: 'get',
    path: '/auth/config',
    operationId: 'loginConfiguration',
    summary: 'Read public GitHub sign-in configuration',
    response: 'LoginConfig',
    feature: 'login',
    authentication: 'public',
  },
  {
    method: 'post',
    path: '/auth/github',
    operationId: 'exchangeGithubLogin',
    summary: 'Exchange GitHub identity for a customer principal',
    body: 'LoginRequest',
    response: 'LoginResponse',
    feature: 'login',
    authentication: 'github',
    idempotency: 'id',
    description:
      'Invitation required. Prefer acld login for the device flow. Low-level clients generate and retain their own acld token, send its SHA-256 tokenHash with a persisted UUIDv4 login id, and authenticate this exchange with a GitHub OAuth token. The response does not contain the locally generated token.',
  },
  {
    method: 'get',
    path: '/v1/whoami',
    operationId: 'whoami',
    summary: 'Inspect the current principal and grant policy',
    response: 'WhoamiResponse',
  },
  {
    method: 'get',
    path: '/v1/capabilities',
    operationId: 'capabilities',
    summary: 'Discover the protocol, provider and configured features',
    response: 'CapabilitiesResponse',
    description:
      'Configured describes service wiring. It does not grant permission or establish guest/image compatibility, available capacity, or current health. Read whoami for policy and inspect operation results.',
  },
  {
    method: 'get',
    path: '/v1/catalog',
    operationId: 'catalog',
    summary: 'Read available machine offers and reservation prices',
    response: 'CatalogResponse',
  },
  {
    method: 'get',
    path: '/v1/projects',
    operationId: 'projects',
    summary: 'List up to 100 accessible projects, newest first',
    response: 'ProjectsResponse',
  },
  {
    method: 'post',
    path: '/v1/projects',
    operationId: 'createProject',
    summary: 'Create or retrieve an account project by name',
    body: 'ProjectInput',
    response: 'ProjectResponse',
    status: 201,
    idempotency: 'name',
  },
  {
    method: 'get',
    path: '/v1/projects/{projectId}/machines',
    operationId: 'machines',
    summary: 'List up to 100 project machines, newest first',
    response: 'MachinesResponse',
    parameters: [project],
  },
  {
    method: 'post',
    path: '/v1/projects/{projectId}/machines',
    operationId: 'createMachine',
    summary: 'Admit a machine creation operation',
    body: 'MachineSpec',
    response: 'OperationResponse',
    status: 202,
    parameters: [project],
    idempotency: 'header',
  },
  {
    method: 'get',
    path: '/v1/machines/{machineId}',
    operationId: 'machine',
    summary: 'Inspect a machine and its current version',
    response: 'MachineResponse',
    parameters: [machine],
  },
  {
    method: 'post',
    path: '/v1/machines/{machineId}/actions',
    operationId: 'act',
    summary: 'Admit reboot, power, resize or destruction',
    body: 'MachineAction',
    response: 'OperationResponse',
    status: 202,
    parameters: [machine],
    idempotency: 'header',
    description:
      'Use the latest machine version as expectedVersion. Destruction requires an explicit allowDataLoss value and the corresponding grant permission; retained backups have their own lifetime.',
  },
  {
    method: 'get',
    path: '/v1/operations/{operationId}',
    operationId: 'operation',
    summary: 'Inspect an admitted operation',
    response: 'OperationResponse',
    parameters: [
      parameter(
        'operationId',
        'path',
        contract.operationIdSchema,
        'Operation ID returned by admission.',
      ),
    ],
    description:
      'Poll until succeeded, failed or cancelled. A blocked operation needs reconciliation; a timeout or lost HTTP reply does not cancel admitted work.',
  },
  {
    method: 'get',
    path: '/v1/grants',
    operationId: 'grants',
    summary: 'List up to 100 grants beneath the current principal',
    response: 'GrantsResponse',
    parameters: [
      parameter(
        'after',
        'query',
        contract.grantIdSchema,
        'Opaque nextCursor from the preceding page.',
      ),
    ],
  },
  {
    method: 'post',
    path: '/v1/grants',
    operationId: 'issueGrant',
    summary: 'Issue a narrower expiring delegation',
    body: 'GrantInput',
    response: 'IssuedGrantResponse',
    status: 201,
    idempotency: 'none',
    description:
      'The plaintext token is returned only by issuance. Store it privately. After an uncertain response, inspect the grant list before issuing again; this endpoint does not accept an idempotency key.',
  },
  {
    method: 'delete',
    path: '/v1/grants/{grantId}',
    operationId: 'revokeGrant',
    summary: 'Revoke a grant and its authority descendants',
    response: 'RevokedResponse',
    parameters: [parameter('grantId', 'path', contract.grantIdSchema, 'Exact grant to revoke.')],
  },
  {
    method: 'get',
    path: '/v1/usage',
    operationId: 'usage',
    summary: 'Inspect reservations, limits and retained backup bytes',
    response: 'UsageResponse',
    description:
      'Reservation accounting is not a provider invoice. Powered-off VMs remain billable.',
  },
  {
    method: 'get',
    path: '/v1/usage/history',
    operationId: 'reservationHistory',
    summary: 'Read up to 100 reservation history entries',
    response: 'ReservationHistoryResponse',
    parameters: [
      parameter(
        'before',
        'query',
        contract.reservationCursorSchema,
        'Opaque nextCursor from the preceding page; a positive signed-64-bit decimal integer.',
      ),
    ],
  },
  {
    method: 'post',
    path: '/v1/machines/{machineId}/access-sessions',
    operationId: 'createAccessSession',
    summary: 'Admit a short-lived customer access session',
    body: 'AccessSessionRequest',
    response: 'AccessSessionResponse',
    status: 202,
    feature: 'access',
    parameters: [machine],
    idempotency: 'header',
    description:
      'Send a canonical Ed25519 public key and SHA-256 hash of a locally retained random ticket. Keep private keys and ticket plaintext client-side. The CLI uses these sessions for SSH, file transfers, durable commands and Compose; those are not additional HTTP endpoints.',
  },
  {
    method: 'get',
    path: '/v1/access-sessions/{id}',
    operationId: 'accessSession',
    summary: 'Inspect session issuance and connection state',
    response: 'AccessSessionResponse',
    feature: 'access',
    parameters: [id(contract.accessSessionIdSchema)],
  },
  {
    method: 'get',
    path: '/v1/routes',
    operationId: 'routes',
    summary: 'List up to 100 accessible application routes',
    response: 'RoutesResponse',
    feature: 'routing',
  },
  {
    method: 'get',
    path: '/v1/routes/{hostname}',
    operationId: 'route',
    summary: 'Inspect a route and applied versions',
    response: 'RouteResponse',
    feature: 'routing',
    parameters: [hostname],
  },
  {
    method: 'post',
    path: '/v1/routes',
    operationId: 'publishRoute',
    summary: 'Publish or move an application route',
    body: 'RoutePublish',
    response: 'RouteResponse',
    status: 202,
    feature: 'routing',
    idempotency: 'commandId',
    description:
      'The application must listen on the specified guest loopback port. Ports 2019, 8081 and 8443 are reserved. Existing destinations require the current expectedVersion; custom names require a verified domain challenge. Names use lowercase ASCII DNS labels, without wildcards or trailing dots.',
  },
  {
    method: 'post',
    path: '/v1/routes/{hostname}/remove',
    operationId: 'removeRoute',
    summary: 'Remove an application route at its current version',
    body: 'RouteRemove',
    response: 'RouteResponse',
    status: 202,
    feature: 'routing',
    parameters: [hostname],
    idempotency: 'commandId',
  },
  {
    method: 'post',
    path: '/v1/domains',
    operationId: 'createDomain',
    summary: 'Create a DNS ownership challenge',
    body: 'DomainCreate',
    response: 'DomainResponse',
    status: 201,
    feature: 'routing',
    description: 'Publish the returned DNS TXT record before requesting verification.',
  },
  {
    method: 'post',
    path: '/v1/domains/{id}/verify',
    operationId: 'verifyDomain',
    summary: 'Verify the current DNS ownership challenge',
    response: 'DomainResponse',
    feature: 'routing',
    parameters: [id(z.uuidv4())],
  },
  {
    method: 'get',
    path: '/v1/recipes',
    operationId: 'recipes',
    summary: 'Discover maintained PostgreSQL and Umami recipes',
    response: 'RecipesResponse',
  },
  {
    method: 'get',
    path: '/v1/recipes/{id}',
    operationId: 'recipe',
    summary: 'Read a supported recipe version and instructions',
    response: 'RecipeResponse',
    parameters: [
      id(contract.recipeIdSchema),
      parameter(
        'version',
        'query',
        contract.recipeVersionSchema,
        'Optional exact supported recipe version; omitted selects the bundled version.',
      ),
    ],
  },
  {
    method: 'post',
    path: '/v1/machines/{machineId}/backups',
    operationId: 'captureBackup',
    summary: 'Admit an encrypted retained application backup',
    body: 'BackupCaptureRequest',
    response: 'BackupResponse',
    status: 202,
    feature: 'protectedBackups',
    parameters: [machine],
    idempotency: 'id',
    description:
      'Captures the selected PostgreSQL database, Compose source and explicitly declared files. Files are best effort, and this is not a whole-machine or point-in-time backup.',
  },
  {
    method: 'get',
    path: '/v1/machines/{machineId}/backups',
    operationId: 'backups',
    summary: 'List up to 100 machine backups',
    response: 'BackupsResponse',
    feature: 'protectedBackups',
    parameters: [machine],
  },
  {
    method: 'get',
    path: '/v1/backups/{id}',
    operationId: 'backup',
    summary: 'Inspect retained backup state',
    response: 'BackupResponse',
    feature: 'protectedBackups',
    parameters: [id(contract.backupIdSchema)],
  },
  {
    method: 'post',
    path: '/v1/machines/{machineId}/backup-schedules',
    operationId: 'createBackupSchedule',
    summary: 'Register a daily application backup schedule',
    body: 'BackupScheduleRequest',
    response: 'BackupScheduleResponse',
    status: 202,
    feature: 'protectedBackups',
    parameters: [machine],
    idempotency: 'id',
  },
  {
    method: 'get',
    path: '/v1/machines/{machineId}/backup-schedules',
    operationId: 'backupSchedules',
    summary: 'List machine backup schedules',
    response: 'BackupSchedulesResponse',
    feature: 'protectedBackups',
    parameters: [machine],
  },
  {
    method: 'get',
    path: '/v1/backup-schedules/{id}',
    operationId: 'backupSchedule',
    summary: 'Inspect a daily backup schedule',
    response: 'BackupScheduleResponse',
    feature: 'protectedBackups',
    parameters: [id(contract.backupScheduleIdSchema)],
  },
  {
    method: 'delete',
    path: '/v1/backup-schedules/{id}',
    operationId: 'disableBackupSchedule',
    summary: 'Disable future scheduled captures',
    response: 'BackupScheduleResponse',
    feature: 'protectedBackups',
    parameters: [id(contract.backupScheduleIdSchema)],
    description:
      'Existing admitted captures and retained backups keep their own state and retention.',
  },
  {
    method: 'post',
    path: '/v1/backups/{id}/purge',
    operationId: 'purgeBackup',
    summary: 'Request exact-version backup deletion after retention permits it',
    body: 'BackupPurgeRequest',
    response: 'BackupPurgeResponse',
    status: 202,
    feature: 'protectedBackups',
    parameters: [id(contract.backupIdSchema)],
    idempotency: 'id',
    description:
      'Requires explicit allowDataLoss:true and backup:purge authority. Admission does not mean deletion; retention extensions can delay completion.',
  },
  {
    method: 'get',
    path: '/v1/backup-purges/{id}',
    operationId: 'backupPurge',
    summary: 'Inspect a backup purge request',
    response: 'BackupPurgeResponse',
    feature: 'protectedBackups',
    parameters: [id(contract.backupPurgeIdSchema)],
  },
  {
    method: 'post',
    path: '/v1/restores',
    operationId: 'restoreBackup',
    summary: 'Restore an application into a new isolated machine',
    body: 'RestoreRequest',
    response: 'RestoreResponse',
    status: 202,
    feature: 'protectedBackups',
    idempotency: 'id',
    description:
      'Creates a separate budget-checked, billable machine and returns its machineId and operationId. It never targets an existing machine. A pending backup_key diagnostic requires recovery of the matching wrapping key; keep polling the same restore ID.',
  },
  {
    method: 'get',
    path: '/v1/restores/{id}',
    operationId: 'restore',
    summary: 'Inspect an isolated application restore',
    response: 'RestoreResponse',
    feature: 'protectedBackups',
    parameters: [id(contract.restoreIdSchema)],
  },
];

const retryDescriptions = {
  header:
    'Persist the Idempotency-Key and request before sending; reuse both after an uncertain reply.',
  id: 'Persist the request id and identical request before sending; reuse both after an uncertain reply. Do not generate a replacement id merely because a response was lost.',
  commandId:
    'Persist commandId and identical request before sending; reuse both after an uncertain reply.',
  name: 'Repeated creation with the same name returns the existing project within the account.',
  none: 'This mutation has no idempotency key; do not automatically repeat an uncertain submission.',
};
function describe(operation: Operation) {
  const parameters = [
    ...(operation.parameters ?? []),
    ...(operation.idempotency === 'header' ? [idempotencyHeader] : []),
  ];
  return {
    operationId: operation.operationId,
    summary: operation.summary,
    description: [
      operation.description,
      operation.idempotency ? retryDescriptions[operation.idempotency] : undefined,
      operation.status === 202
        ? 'HTTP 202 confirms admission, not completion. Inspect the returned resource or operation ID.'
        : undefined,
    ]
      .filter(Boolean)
      .join(' '),
    tags: [operation.feature ?? 'customer'],
    security:
      operation.authentication === 'public'
        ? []
        : operation.authentication === 'github'
          ? [{ GitHubOAuth: [] }]
          : [{ CustomerBearer: [] }],
    ...(operation.feature ? { 'x-agent-cloud-feature': operation.feature } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(operation.body
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: reference(operation.body) } },
          },
        }
      : {}),
    responses: {
      [operation.status ?? 200]: {
        description:
          operation.status === 202
            ? 'Accepted for asynchronous processing.'
            : 'Successful response.',
        headers: { 'X-Request-Id': requestIdHeader },
        content: { 'application/json': { schema: reference(operation.response) } },
      },
      ...Object.fromEntries(
        [400, 401, 403, 404, 409, 429, 500, 503].map((status) => [
          status,
          { $ref: '#/components/responses/Error' },
        ]),
      ),
    },
  };
}

/** Only booleans enter discovery: no runtime credentials, hostnames or provider configuration. */
export function customerApiDescription(configured: Record<Feature, boolean>) {
  const paths: Record<
    string,
    Partial<Record<Operation['method'], ReturnType<typeof describe>>>
  > = {};
  for (const operation of operations) {
    if (operation.feature && !configured[operation.feature]) continue;
    (paths[operation.path] ??= {})[operation.method] = describe(operation);
  }
  return {
    openapi: '3.1.0',
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: {
      title: 'Agent Cloud customer API',
      version: '1',
      description:
        'Implemented customer HTTP API. Discover configured features at /v1/capabilities and current policy at /v1/whoami. Only configured optional routes appear. Configuration is not permission, health, capacity or guest/image compatibility. JSON Schemas describe structural constraints; runtime authorization and cross-field validation still apply. JSON request bodies are limited to 64 KiB.',
    },
    servers: [{ url: '/' }],
    paths,
    components: {
      schemas,
      securitySchemes: {
        CustomerBearer: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'acld token',
          description:
            'Authorization: Bearer <customer token>. Obtain it with acld login or an authorized delegation; keep it private. Every /v1 request rechecks expiry and revocation.',
        },
        GitHubOAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'GitHub OAuth token',
          description: 'GitHub OAuth token used only for /auth/github, not a customer acld token.',
        },
      },
      headers: {
        RequestId: {
          description: 'Correlation ID for this HTTP request; retain it for investigating errors.',
          schema: { type: 'string', format: 'uuid' },
        },
      },
      responses: {
        Error: {
          description:
            'API failure. Inspect error.code, error.retryable and requestId. A retryable failure never authorizes changing a persisted idempotency key or request ID.',
          headers: { 'X-Request-Id': requestIdHeader },
          content: { 'application/json': { schema: reference('ErrorResponse') } },
        },
      },
    },
  };
}

export const customerLlmsText = `# Agent Cloud

> Deploy and operate customer applications through your existing agent, the acld CLI, or this HTTP API.

- [OpenAPI 3.1](/openapi.json): implemented customer methods, request/response/error JSON Schemas, authentication and retry rules. Resolve the relative server URL against this API origin.
- [Capabilities](/v1/capabilities): authenticate with your customer bearer token to inspect the protocol, provider and configured features.
- [Current principal](/v1/whoami): inspect your grant policy separately from configured features.
- [Recipe catalog](/v1/recipes): maintained PostgreSQL and Umami versions and deployment instructions.

Use acld login for GitHub device sign-in when configured, then acld agent instructions for the complete agent workflow. Store credentials privately. /v1 requests require Authorization: Bearer <customer token>; JSON bodies use Content-Type: application/json and are limited to 64 KiB.

The OpenAPI document includes optional login, access, routing and protected-backup routes only when their services are configured. Configuration does not establish permission, current health, capacity, or compatibility of a particular machine image. An omitted optional route returns 404 after valid customer authentication. Image factories do not serve this customer documentation.

Create a project, inspect the catalog, then admit a machine and poll its operation. Persist Idempotency-Key before machine creation/actions or access-session admission. Backups, schedules, purges and restores persist their body id; route changes persist commandId. Retry an uncertain submission with the same key/ID and identical input. HTTP 202 is admission, not completion; a client timeout does not cancel work. Check each operation's retry rules before repeating mutations such as grant issuance.

Inspect errors using error.code, error.retryable and requestId. Read the latest machine/route version before versioned changes. Powering off does not stop VM billing; usage reports reservations, not invoices. Restore creates a separate isolated machine; retained backups survive machine destruction and deletion waits for retention.

The CLI uses access sessions for SSH, file transfer, durable commands and Compose. Those operations are not separate customer HTTP endpoints. Recipes need persistent volumes and application verification; Umami also needs site instrumentation and a verified visitor event.
`;

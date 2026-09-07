import { sql } from 'drizzle-orm';
import {
  pgTable,
  primaryKey,
  text,
  integer,
  timestamp,
  jsonb,
  unique,
  uniqueIndex,
  index,
  foreignKey,
  check,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const imageBuilds = pgTable('image_builds', {
  id: text('id').primaryKey(),
  admission: jsonb('admission').notNull(),
  state: jsonb('state').notNull().default({ kind: 'running' }),
  runRequestedAt: timestamp('run_requested_at', { withTimezone: true }),
  accessRemovedAt: timestamp('access_removed_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const imageBuildEffects = pgTable(
  'image_build_effects',
  {
    id: text('id').primaryKey(),
    buildId: text('build_id')
      .notNull()
      .references(() => imageBuilds.id),
    effectKey: text('effect_key').notNull(),
    command: jsonb('command').notNull(),
    outcome: jsonb('outcome').notNull().default({ kind: 'prepared' }),
    resolution: jsonb('resolution').notNull().default({ kind: 'pending' }),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.buildId, t.effectKey), unique().on(t.buildId, t.id)],
);

export const imageBuildResources = pgTable(
  'image_build_resources',
  {
    provider: text('provider').notNull(),
    kind: text('kind').notNull(),
    providerId: text('provider_id').notNull(),
    buildId: text('build_id').notNull(),
    effectId: text('effect_id').notNull(),
    role: text('role').notNull(),
    state: jsonb('state').notNull().default({ kind: 'unverified' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.kind, t.providerId] }),
    foreignKey({
      columns: [t.buildId, t.effectId],
      foreignColumns: [imageBuildEffects.buildId, imageBuildEffects.id],
    }),
  ],
);

export const imageBuilderWork = pgTable(
  'image_builder_work',
  {
    buildId: text('build_id').primaryKey(),
    effectId: text('effect_id').notNull(),
    serverId: text('server_id').notNull(),
    progress: jsonb('progress').notNull().default({ kind: 'installing' }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.buildId, t.effectId],
      foreignColumns: [imageBuildEffects.buildId, imageBuildEffects.id],
    }),
  ],
);

export const imageVerifierBootstraps = pgTable('image_verifier_bootstraps', {
  buildId: text('build_id')
    .primaryKey()
    .references(() => imageBuilds.id),
  snapshotId: text('snapshot_id').notNull(),
  spec: jsonb('spec').notNull(),
  tokenHash: text('token_hash').notNull(),
  sealedToken: jsonb('sealed_token'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const imageVerifierIdentities = pgTable(
  'image_verifier_identities',
  {
    buildId: text('build_id')
      .primaryKey()
      .references(() => imageVerifierBootstraps.buildId),
    effectId: text('effect_id').notNull(),
    serverId: text('server_id').notNull(),
    identity: jsonb('identity').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.buildId, t.effectId],
      foreignColumns: [imageBuildEffects.buildId, imageBuildEffects.id],
    }),
  ],
);

export const imageVerifierSigningAttempts = pgTable(
  'image_verifier_signing_attempts',
  {
    buildId: text('build_id')
      .notNull()
      .references(() => imageVerifierBootstraps.buildId),
    purpose: text('purpose').notNull(),
    sequence: integer('sequence').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.buildId, t.purpose, t.sequence] })],
);

export const imageVerifierResults = pgTable('image_verifier_results', {
  buildId: text('build_id')
    .primaryKey()
    .references(() => imageVerifierIdentities.buildId),
  result: jsonb('result').notNull(),
  createdAt: createdAt(),
});

export const imagePublications = pgTable('image_publications', {
  buildId: text('build_id')
    .primaryKey()
    .references(() => imageVerifierResults.buildId),
  evidence: jsonb('evidence').notNull(),
  release: jsonb('release'),
  createdAt: createdAt(),
});

export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    maxMachines: integer('max_machines').notNull(),
    currency: text('currency').notNull(),
    maxHourlyMicros: integer('max_hourly_micros').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('account_limits', sql`${t.maxMachines} >= 0 AND ${t.maxHourlyMicros} >= 0`),
    check('account_currency_format', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    unique('account_currency_identity').on(t.id, t.currency),
  ],
);

export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    name: text('name').notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.accountId, t.id), unique().on(t.accountId, t.name)],
);

export const grants = pgTable(
  'grants',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    parentId: text('parent_id'),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    policy: jsonb('policy').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.accountId, t.id),
    foreignKey({ columns: [t.accountId, t.parentId], foreignColumns: [t.accountId, t.id] }),
  ],
);

export const machines = pgTable(
  'machines',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    projectId: text('project_id').notNull(),
    name: text('name').notNull(),
    spec: jsonb('spec').notNull(),
    provider: text('provider').notNull(),
    state: jsonb('state').notNull(),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.accountId, t.projectId, t.id),
    unique().on(t.accountId, t.id),
    foreignKey({
      columns: [t.accountId, t.projectId],
      foreignColumns: [projects.accountId, projects.id],
    }),
    uniqueIndex('live_machine_name')
      .on(t.projectId, t.name)
      .where(sql`${t.state}->>'kind' <> 'destroyed'`),
    check('machine_version', sql`${t.version} > 0`),
  ],
);

export const allocations = pgTable(
  'allocations',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    machineId: text('machine_id').notNull(),
    provider: text('provider').notNull(),
    serverId: text('server_id'),
    networkProfile: text('network_profile').notNull(),
    currency: text('currency').notNull(),
    hourlyMicros: integer('hourly_micros').notNull(),
    offer: jsonb('offer'),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.accountId, t.machineId],
      foreignColumns: [machines.accountId, machines.id],
    }),
    foreignKey({
      name: 'allocation_account_currency',
      columns: [t.accountId, t.currency],
      foreignColumns: [accounts.id, accounts.currency],
    }),
    uniqueIndex('one_live_allocation')
      .on(t.machineId)
      .where(sql`${t.retiredAt} IS NULL`),
    unique().on(t.provider, t.serverId),
    unique('allocation_account_identity').on(t.accountId, t.id),
    unique('allocation_machine_identity').on(t.accountId, t.machineId, t.id),
    check('allocation_price', sql`${t.hourlyMicros} >= 0`),
  ],
);

export const accessSessions = pgTable(
  'access_sessions',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    projectId: text('project_id').notNull(),
    grantId: text('grant_id').notNull(),
    machineId: text('machine_id').notNull(),
    allocationId: text('allocation_id').notNull(),
    machineVersion: integer('machine_version').notNull(),
    requestKey: text('request_key').notNull(),
    fingerprint: text('fingerprint').notNull(),
    publicKey: text('public_key').notNull(),
    ticketHash: text('ticket_hash').notNull().unique(),
    identityPin: jsonb('identity_pin').notNull(),
    gateway: jsonb('gateway').notNull(),
    admittedAt: timestamp('admitted_at', { withTimezone: true }).notNull(),
    issueDeadline: timestamp('issue_deadline', { withTimezone: true }).notNull(),
    hardDeadline: timestamp('hard_deadline', { withTimezone: true }).notNull(),
    issuance: jsonb('issuance').notNull().default({ kind: 'pending' }),
    connection: jsonb('connection').notNull().default({ kind: 'unclaimed' }),
  },
  (t) => [
    unique('access_request_identity').on(t.accountId, t.grantId, t.requestKey),
    foreignKey({
      name: 'access_machine_scope',
      columns: [t.accountId, t.projectId, t.machineId],
      foreignColumns: [machines.accountId, machines.projectId, machines.id],
    }),
    foreignKey({
      name: 'access_allocation_scope',
      columns: [t.accountId, t.machineId, t.allocationId],
      foreignColumns: [allocations.accountId, allocations.machineId, allocations.id],
    }),
    foreignKey({
      name: 'access_grant_scope',
      columns: [t.accountId, t.grantId],
      foreignColumns: [grants.accountId, grants.id],
    }),
    index('access_account_window').on(t.accountId, t.admittedAt),
    index('access_grant_window').on(t.grantId, t.admittedAt),
    index('access_machine_connections')
      .on(t.machineId)
      .where(sql`${t.connection}->>'kind' <> 'closed'`),
    uniqueIndex('access_gateway_connection').on(
      sql`(${t.gateway}->>'id')`,
      sql`COALESCE(${t.connection}->>'gatewayInstanceId', ${t.connection}->'previous'->>'gatewayInstanceId')`,
      sql`COALESCE(${t.connection}->>'connectionId', ${t.connection}->'previous'->>'connectionId')`,
    ),
    check('access_machine_version', sql`${t.machineVersion} > 0`),
    check(
      'access_hashes',
      sql`${t.ticketHash} ~ '^[0-9a-f]{64}$' AND ${t.fingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'access_deadlines',
      sql`${t.issueDeadline} > ${t.admittedAt}
      AND ${t.issueDeadline} <= ${t.admittedAt} + interval '90 seconds'
      AND ${t.hardDeadline} > ${t.admittedAt}
      AND ${t.hardDeadline} <= ${t.admittedAt} + interval '1 hour'`,
    ),
  ],
);

// Ownership is inherited through the immutable session, avoiding a second mutable copy.
export const accessSigningAttempts = pgTable('access_signing_attempts', {
  sessionId: text('session_id')
    .primaryKey()
    .references(() => accessSessions.id),
  attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull(),
});

export const operations = pgTable(
  'operations',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    projectId: text('project_id').notNull(),
    machineId: text('machine_id').notNull(),
    grantId: text('grant_id').notNull(),
    kind: text('kind').notNull(),
    command: jsonb('command').notNull(),
    offer: jsonb('offer'),
    intent: jsonb('intent').notNull().default({ kind: 'run' }),
    progress: jsonb('progress').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.accountId, t.id),
    foreignKey({
      columns: [t.accountId, t.projectId, t.machineId],
      foreignColumns: [machines.accountId, machines.projectId, machines.id],
    }),
    foreignKey({
      columns: [t.accountId, t.grantId],
      foreignColumns: [grants.accountId, grants.id],
    }),
    uniqueIndex('one_active_operation')
      .on(t.machineId)
      .where(sql`${t.progress}->>'kind' NOT IN ('succeeded', 'failed', 'cancelled')`),
  ],
);

export const operationCleanups = pgTable(
  'operation_cleanups',
  {
    operationId: text('operation_id').primaryKey(),
    accountId: text('account_id').notNull(),
    allocationId: text('allocation_id').notNull(),
    sourceOperationId: text('source_operation_id').notNull(),
    grantId: text('grant_id').notNull(),
    expectedVersion: integer('expected_version').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.accountId, t.operationId],
      foreignColumns: [operations.accountId, operations.id],
    }),
    foreignKey({
      columns: [t.accountId, t.sourceOperationId],
      foreignColumns: [operations.accountId, operations.id],
    }),
    foreignKey({
      columns: [t.accountId, t.allocationId],
      foreignColumns: [allocations.accountId, allocations.id],
    }),
    foreignKey({
      columns: [t.accountId, t.grantId],
      foreignColumns: [grants.accountId, grants.id],
    }),
    check('cleanup_version', sql`${t.expectedVersion} > 0`),
  ],
);

export const allocationImages = pgTable(
  'allocation_images',
  {
    allocationId: text('allocation_id').primaryKey(),
    accountId: text('account_id').notNull(),
    operationId: text('operation_id').notNull().unique(),
    buildId: text('build_id')
      .notNull()
      .references(() => imagePublications.buildId),
    snapshotId: text('snapshot_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.accountId, t.allocationId],
      foreignColumns: [allocations.accountId, allocations.id],
    }),
    foreignKey({
      columns: [t.accountId, t.operationId],
      foreignColumns: [operations.accountId, operations.id],
    }),
  ],
);

export const attempts = pgTable(
  'provider_attempts',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    operationId: text('operation_id').notNull(),
    sequence: integer('sequence').notNull(),
    command: jsonb('command').notNull(),
    outcome: jsonb('outcome').notNull(),
    resolution: jsonb('resolution').notNull().default({ kind: 'pending' }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.accountId, t.operationId],
      foreignColumns: [operations.accountId, operations.id],
    }),
    unique().on(t.operationId, t.sequence),
  ],
);

export const operatorRecoveries = pgTable('operator_recoveries', {
  id: text('id').primaryKey(),
  operationId: text('operation_id')
    .notNull()
    .references(() => operationCleanups.operationId),
  attemptId: text('attempt_id')
    .notNull()
    .unique()
    .references(() => attempts.id),
  request: jsonb('request').notNull(),
  createdAt: createdAt(),
});

export const idempotency = pgTable(
  'idempotency',
  {
    accountId: text('account_id').notNull(),
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    operationId: text('operation_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.accountId, t.scope, t.key),
    foreignKey({
      columns: [t.accountId, t.operationId],
      foreignColumns: [operations.accountId, operations.id],
    }),
  ],
);

export const auditEvents = pgTable('audit_events', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  accountId: text('account_id')
    .notNull()
    .references(() => accounts.id),
  subjectId: text('subject_id').notNull(),
  event: text('event').notNull(),
  details: jsonb('details').notNull(),
  createdAt: createdAt(),
});

// Simulator records deliberately survive control-plane retries independently.
export const simulatedServers = pgTable('simulated_servers', {
  id: text('id').primaryKey(),
  value: jsonb('value').notNull(),
  visibleAt: timestamp('visible_at', { withTimezone: true }).notNull(),
});
export const simulatedActions = pgTable('simulated_actions', {
  id: text('id').primaryKey(),
  command: jsonb('command').notNull(),
  serverId: text('server_id').notNull(),
  result: jsonb('result').notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  readyAt: timestamp('ready_at', { withTimezone: true }).notNull(),
});

export const providerResources = pgTable(
  'provider_resources',
  {
    provider: text('provider').notNull(),
    kind: text('kind').notNull(),
    providerId: text('provider_id').notNull(),
    accountId: text('account_id').notNull(),
    allocationId: text('allocation_id').notNull(),
    labels: jsonb('labels').notNull(),
    absentAt: timestamp('absent_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.kind, t.providerId] }),
    foreignKey({
      columns: [t.accountId, t.allocationId],
      foreignColumns: [allocations.accountId, allocations.id],
    }),
    check('provider_resource_kind', sql`${t.kind} IN ('server', 'primary_ip')`),
  ],
);

export const simulatedPrimaryIps = pgTable('simulated_primary_ips', {
  id: text('id').primaryKey(),
  value: jsonb('value').notNull(),
  visibleAt: timestamp('visible_at', { withTimezone: true }).notNull(),
});

export const guestBootstraps = pgTable(
  'guest_bootstraps',
  {
    accountId: text('account_id').notNull(),
    allocationId: text('allocation_id').primaryKey(),
    operationId: text('operation_id').notNull().unique(),
    spec: jsonb('spec').notNull(),
    tokenHash: text('token_hash').notNull(),
    sealedToken: jsonb('sealed_token'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('bootstrap_account_identity').on(t.accountId, t.allocationId),
    foreignKey({
      columns: [t.accountId, t.allocationId],
      foreignColumns: [allocations.accountId, allocations.id],
    }),
    foreignKey({
      columns: [t.accountId, t.operationId],
      foreignColumns: [operations.accountId, operations.id],
    }),
  ],
);

export const guestIdentities = pgTable(
  'guest_identities',
  {
    accountId: text('account_id').notNull(),
    allocationId: text('allocation_id').primaryKey(),
    identity: jsonb('identity').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.accountId, t.allocationId],
      foreignColumns: [guestBootstraps.accountId, guestBootstraps.allocationId],
    }),
  ],
);

export const guestSigningAttempts = pgTable(
  'guest_signing_attempts',
  {
    accountId: text('account_id').notNull(),
    allocationId: text('allocation_id').notNull(),
    purpose: text('purpose').notNull(),
    sequence: integer('sequence').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.allocationId, t.purpose, t.sequence] }),
    foreignKey({
      columns: [t.accountId, t.allocationId],
      foreignColumns: [guestBootstraps.accountId, guestBootstraps.allocationId],
    }),
    check(
      'guest_signing_attempt_budget',
      sql`(${t.purpose} = 'probe' AND ${t.sequence} BETWEEN 1 AND 12) OR (${t.purpose} = 'identity' AND ${t.sequence} BETWEEN 1 AND 4)`,
    ),
  ],
);

export const guestCertificateRenewals = pgTable(
  'guest_certificate_renewals',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    allocationId: text('allocation_id').notNull(),
    identity: jsonb('identity'),
    createdAt: createdAt(),
  },
  (t) => [
    index('guest_renewal_allocation_time').on(t.allocationId, t.createdAt.desc()),
    foreignKey({
      columns: [t.accountId, t.allocationId],
      foreignColumns: [guestBootstraps.accountId, guestBootstraps.allocationId],
    }),
  ],
);

export const runtimeSigningAttempts = pgTable(
  'runtime_signing_attempts',
  {
    accountId: text('account_id').notNull(),
    allocationId: text('allocation_id').notNull(),
    operationId: text('operation_id').notNull(),
    sequence: integer('sequence').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.operationId, t.sequence] }),
    foreignKey({
      columns: [t.accountId, t.allocationId],
      foreignColumns: [allocations.accountId, allocations.id],
    }),
    foreignKey({
      columns: [t.accountId, t.operationId],
      foreignColumns: [operations.accountId, operations.id],
    }),
    check('runtime_signing_attempt_budget', sql`${t.sequence} BETWEEN 1 AND 12`),
  ],
);

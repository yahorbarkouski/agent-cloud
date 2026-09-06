import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  unique,
  uniqueIndex,
  foreignKey,
  check,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

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
    check('allocation_price', sql`${t.hourlyMicros} >= 0`),
  ],
);

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
      .where(sql`${t.progress}->>'kind' NOT IN ('succeeded', 'failed')`),
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

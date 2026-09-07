import {
  accessSessionRecordSchema,
  machineSchema,
  operationSchema,
  projectSchema,
} from '@agent-cloud/contracts';
import type { accessSessions, machines, operations, projects } from './schema.js';

export function machineRecord(row: typeof machines.$inferSelect) {
  return machineSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
}
export function operationRecord(row: typeof operations.$inferSelect) {
  return operationSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
}
export function projectRecord(row: typeof projects.$inferSelect) {
  return projectSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
}

export function accessSessionRecord(row: typeof accessSessions.$inferSelect) {
  return accessSessionRecordSchema.parse({
    ...row,
    admittedAt: row.admittedAt.toISOString(),
    issueDeadline: row.issueDeadline.toISOString(),
    hardDeadline: row.hardDeadline.toISOString(),
  });
}

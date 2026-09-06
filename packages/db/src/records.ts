import { machineSchema, operationSchema, projectSchema } from '@agent-cloud/contracts';
import type { machines, operations, projects } from './schema.js';

export function machineRecord(row: typeof machines.$inferSelect) {
  return machineSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
}
export function operationRecord(row: typeof operations.$inferSelect) {
  return operationSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
}
export function projectRecord(row: typeof projects.$inferSelect) {
  return projectSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
}

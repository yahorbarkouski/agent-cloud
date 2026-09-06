import { z } from 'zod';

export const errorCodeSchema = z.enum([
  'invalid_input',
  'unauthenticated',
  'permission_denied',
  'not_found',
  'idempotency_conflict',
  'resource_busy',
  'version_conflict',
  'quota_exceeded',
  'budget_exceeded',
  'capacity_unavailable',
  'provider_rejected',
  'provider_outcome_unknown',
  'provider_unavailable',
  'guest_unreachable',
  'data_loss_not_authorized',
  'internal_error',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const failureSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
});
export type Failure = z.infer<typeof failureSchema>;

export const errorResponseSchema = z.object({
  error: failureSchema,
  requestId: z.string(),
});

export class CloudError extends Error {
  readonly failure: Failure;

  constructor(code: ErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'CloudError';
    this.failure = { code, message, retryable };
  }
}

export function errorStatus(code: ErrorCode): 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503 {
  switch (code) {
    case 'invalid_input':
      return 400;
    case 'unauthenticated':
      return 401;
    case 'permission_denied':
    case 'data_loss_not_authorized':
      return 403;
    case 'not_found':
      return 404;
    case 'idempotency_conflict':
    case 'resource_busy':
    case 'version_conflict':
    case 'budget_exceeded':
    case 'provider_rejected':
    case 'provider_outcome_unknown':
      return 409;
    case 'quota_exceeded':
      return 429;
    case 'capacity_unavailable':
    case 'provider_unavailable':
    case 'guest_unreachable':
      return 503;
    case 'internal_error':
      return 500;
  }
}

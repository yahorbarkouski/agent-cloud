Archived candidate, not implementation guidance. See ../architecture/overview.md for the synthesis.

## Problem

The first lifecycle slice must let an agent request create, reboot, resize, and destroy without trusting the HTTP request path to survive long cloud work. The hard parts are low budget, pending Hetzner verification, retryable API clients, worker crashes around provider calls, delegated grants with limits, and fault tests that can prove ambiguous outcomes are handled locally. Stripe is out of scope, so reservations are policy and quota holds rather than payment captures.

## Usage (caller's view)

```ts
const op = await lifecycle.createMachine(ctx, grant, {
  projectId, region: "fsn1", size: "cx22", image: "ubuntu-24.04",
  idempotencyKey: req.header("Idempotency-Key"),
});
return c.json(op, op.reused ? 200 : 202);

await lifecycle.resizeMachine(ctx, grant, {
  machineId, targetSize: "cx32", idempotencyKey,
});

await worker.runLifecycleJob(job.operationId, effects);
```

Callers get an operation immediately. Repeating the same idempotency key and canonical body returns the same operation; changing the body returns `409`. Workers can run the same job twice. Provider calls are never made unless a `provider_attempts` row already describes the intended external request.

## Shape

The core data model is `Machine` as the stable customer object, `Allocation` as the current Hetzner server, `Operation` as the serialized lifecycle command, `Reservation` as quota/cost hold, and `ProviderAttempt` as the journal for every external mutation. API modules validate Zod input and grant scope at the boundary, then call one transaction: claim idempotency, lock project limits, create or update desired state, reserve budget, create operation, and insert the Graphile job. Business functions decide allowed transitions from typed snapshots; long provider calls stay in workers, per boundary-discipline.

Operations serialize per machine with a database lock. Create may start without an allocation; reboot/resize/destroy require a current allocation and increment the machine resource version. Each operation has phases `queued | running | waiting_provider | reconciling | blocked | succeeded | failed`. `blocked` is a first-class terminal-for-now phase for unknown provider outcomes; it is visible to the caller and actionable by an operator, avoiding blind retries.

Workers load one operation, acquire the per-machine lock, and compute the next effect. Effects are explicit values such as `CreateServer`, `PollAction`, `PowerCycle`, `ResizeServer`, `DeleteServer`, or `Noop`. Before `CreateServer`, the worker inserts `ProviderAttempt{submitted}` with deterministic labels and request digest, then performs the provider call. If the response is lost, the attempt becomes `outcome_unknown`; the reconciler searches by labels and action IDs before any replacement create is allowed, per make-operations-idempotent.

Grants are checked twice: the API checks caller authority and limits before creating intent; workers recheck durable policy snapshots before starting irreversible provider effects. Limits are consumed through reservations that resolve to active allocation, expired failed provisioning, or released destroy. The source of truth for billing-like capacity is allocation state plus reservation resolution, not worker memory.

Local-first tests use fake provider scripts and crash gates around each effect boundary. They assert rows, jobs, and attempts after simulated timeouts, duplicate job runs, process crashes after provider success, provider inventory lag, grant revocation between queue and run, and destroy with missing backup acknowledgement.

Module map:

- `api/lifecycle-routes.ts`: Hono handlers, Zod parsing, HTTP mapping.
- `domain/lifecycle.ts`: pure transition rules and effect selection.
- `domain/grants.ts`: capability and limit evaluation.
- `db/lifecycle-store.ts`: transactions, locks, idempotency, reservations.
- `workers/lifecycle-worker.ts`: Graphile task runner and effect loop.
- `providers/hetzner.ts`: provider adapter returning typed observations.
- `workers/reconciler.ts`: inventory/action reconciliation for unknown attempts.
- `tests/fakes/provider.ts`: deterministic provider and crash gates.

## Synthesis decision

Candidate package only; synthesis is filled by the parent arena.

## Tradeoffs accepted

- We accept extra database rows per operation in exchange for a replayable external-effect journal.
- We accept blocked ambiguous operations in exchange for never turning a timeout into duplicate charged VMs.
- We accept per-machine serialization in exchange for simple lifecycle invariants during V1.
- We accept provider-specific attempt payloads behind a small adapter in exchange for shipping Hetzner first.

## Alternatives considered

- Direct synchronous provider calls from API handlers lost because request retries and process exits would blur customer intent with cloud side effects.
- A generic workflow engine lost because Graphile Worker plus explicit operation rows already covers retries, visibility, and local fault injection with fewer layers.
- Treating provider inventory as source of truth lost because allocation ownership, grants, and reservations are control-plane facts that provider labels can only corroborate.

## Open questions and risks

- What operator action is acceptable when Hetzner inventory remains ambiguous beyond the retry window?
- Which resize paths require powered-off transitions for the first supported sizes?
- What backup manifest fields are sufficient to permit destructive delete under delegated grants?

## Next implementation step

Create the schema and store transaction for `createMachine`, with fake-provider tests for idempotent retry and unknown create reconciliation.


```typescript
import { z } from "zod";

type Brand<T, B extends string> = T & { readonly __brand: B };
export type AccountId = Brand<string, "AccountId">;
export type ProjectId = Brand<string, "ProjectId">;
export type MachineId = Brand<string, "MachineId">;
export type AllocationId = Brand<string, "AllocationId">;
export type OperationId = Brand<string, "OperationId">;
export type GrantId = Brand<string, "GrantId">;
export type ProviderAttemptId = Brand<string, "ProviderAttemptId">;

export const CreateMachineInput = z.object({
  projectId: z.string(), region: z.string(), size: z.string(),
  image: z.string(), idempotencyKey: z.string().min(16),
});
export type CreateMachineInput = z.infer<typeof CreateMachineInput>;

export type OperationKind = "create" | "reboot" | "resize" | "destroy";
export type OperationPhase =
  | "queued" | "running" | "waiting_provider" | "reconciling"
  | "blocked" | "succeeded" | "failed";
export type DesiredState = "ready" | "rebooting" | "resizing" | "destroying" | "destroyed";

export interface RequestContext {
  accountId: AccountId; actorId: string; requestId: string; now: Date;
}
export interface Grant {
  id: GrantId; projectIds: readonly ProjectId[];
  capabilities: readonly OperationKind[]; maxMonthlyCents: number; expiresAt: Date;
}
export interface Machine {
  id: MachineId; projectId: ProjectId; desiredState: DesiredState;
  desiredSize: string; currentAllocationId: AllocationId | null; resourceVersion: number;
}
export interface Allocation {
  id: AllocationId; machineId: MachineId; provider: "hetzner";
  providerServerId: string | null; size: string; readyAt: Date | null; deletedAt: Date | null;
}
export interface Operation {
  id: OperationId; kind: OperationKind; machineId: MachineId | null;
  phase: OperationPhase; idempotencyKey: string; bodyHash: string; grantId: GrantId; version: number;
}
export interface ProviderAttempt {
  id: ProviderAttemptId; operationId: OperationId; allocationId: AllocationId | null;
  requestDigest: string; labels: Record<string, string>; actionId: string | null;
  outcome: "submitted" | "succeeded" | "failed" | "outcome_unknown";
}

export type LifecycleEffect =
  | { type: "CreateServer"; attempt: ProviderAttempt; size: string; image: string; region: string }
  | { type: "PollAction"; attemptId: ProviderAttemptId; actionId: string }
  | { type: "PowerCycle"; allocationId: AllocationId }
  | { type: "ResizeServer"; allocationId: AllocationId; targetSize: string }
  | { type: "DeleteServer"; allocationId: AllocationId; requireBackupAck: true }
  | { type: "Noop"; reason: string };

export interface OperationView {
  operationId: OperationId; machineId: MachineId | null; phase: OperationPhase; reused: boolean;
}
export interface OperationSnapshot {
  operation: Operation; machine: Machine | null;
  allocation: Allocation | null; attempts: readonly ProviderAttempt[];
}
export interface NewProviderAttempt {
  operationId: OperationId; allocationId: AllocationId | null;
  requestDigest: string; labels: Record<string, string>;
}
export type ProviderObservation =
  | { type: "ActionSucceeded"; attemptId: ProviderAttemptId; providerServerId?: string }
  | { type: "ActionFailed"; attemptId: ProviderAttemptId; reason: string }
  | { type: "InventoryMatch"; attemptId: ProviderAttemptId; providerServerId: string }
  | { type: "InventoryStillAmbiguous"; attemptId: ProviderAttemptId };

export interface LifecycleStore {
  createMachineTx(ctx: RequestContext, grant: Grant, input: CreateMachineInput): Promise<OperationView>;
  enqueueOperationTx(operationId: OperationId, jobKey: string): Promise<void>;
  withMachineLock<T>(machineId: MachineId, fn: () => Promise<T>): Promise<T>;
  loadOperationForUpdate(operationId: OperationId): Promise<OperationSnapshot>;
  recordProviderAttempt(input: NewProviderAttempt): Promise<ProviderAttempt>;
  markAttemptUnknown(attemptId: ProviderAttemptId): Promise<void>;
  applyObservation(obs: ProviderObservation): Promise<void>;
}
export interface ProviderEffects {
  createServer(effect: Extract<LifecycleEffect, { type: "CreateServer" }>): Promise<ProviderObservation>;
  pollAction(effect: Extract<LifecycleEffect, { type: "PollAction" }>): Promise<ProviderObservation>;
  powerCycle(effect: Extract<LifecycleEffect, { type: "PowerCycle" }>): Promise<ProviderObservation>;
  resizeServer(effect: Extract<LifecycleEffect, { type: "ResizeServer" }>): Promise<ProviderObservation>;
  deleteServer(effect: Extract<LifecycleEffect, { type: "DeleteServer" }>): Promise<ProviderObservation>;
}
export interface LifecycleService {
  createMachine(ctx: RequestContext, grant: Grant, input: CreateMachineInput): Promise<OperationView>;
  rebootMachine(ctx: RequestContext, grant: Grant, input: MachineCommand): Promise<OperationView>;
  resizeMachine(ctx: RequestContext, grant: Grant, input: ResizeMachineInput): Promise<OperationView>;
  destroyMachine(ctx: RequestContext, grant: Grant, input: DestroyMachineInput): Promise<OperationView>;
}

export interface MachineCommand { machineId: MachineId; idempotencyKey: string }
export interface ResizeMachineInput extends MachineCommand { targetSize: string }
export interface DestroyMachineInput extends MachineCommand { backupAck: BackupAcknowledgement }
export interface BackupAcknowledgement { manifestIds: readonly string[]; allowUnregisteredDataLoss: boolean }

export function nextLifecycleEffect(snapshot: OperationSnapshot): LifecycleEffect {
  throw new Error("not implemented");
}
export async function runLifecycleJob(
  operationId: OperationId, store: LifecycleStore, provider: ProviderEffects,
): Promise<void> {
  throw new Error("not implemented");
}

```

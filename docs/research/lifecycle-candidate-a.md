Archived candidate, not implementation guidance. See ../architecture/overview.md for the synthesis.

# Problem

We need the first machine lifecycle slice for an agent-operated cloud: create, reboot, resize, and destroy VMs durably under low budget and uncertain Hetzner availability. The non-obvious part is that provider operations are slow, retried, and sometimes ambiguous, while grants and limits must be enforced before spending. Stripe is out of scope, so the slice treats budget as account/project/grant limits plus reservations, not payments. The shape follows the existing plan: Node 24 TypeScript strict, Hono, Zod, Postgres, Graphile Worker, explicit transactions, and reconciliation for unknown provider outcomes.

# Usage (caller's view)

The API handler validates HTTP with Zod, resolves the actor and grant, then calls one application service:

```ts
const op = await lifecycle.createMachine(ctx, {
  idempotencyKey: req.header("Idempotency-Key"),
  actor: req.actor,
  projectId,
  region: "fsn1",
  size: "cx22",
});
return c.json(op, 202);
```

The worker claims the operation and runs only the side effects recorded in the database:

```ts
await lifecycleWorker.runOperation(job.operationId, {
  db,
  provider: hetznerProvider,
  guest: sshGuestVerifier,
  clock,
});
```

The reconciler never trusts a single timeout or empty list response:

```ts
await reconcileProviderInventory({
  provider,
  db,
  providerProjectId: "hcloud-main",
  requestBudget: providerBudget,
});
```

Clients see a durable operation, not a synchronous VM:

```ts
const { operationId, machineId, phase } =
  await sdk.machines.resize(machineId, { size: "cx32" }, { idempotencyKey });
```

# Shape

The core object is `Operation`, not `Machine`. API methods create intent in one transaction: authorize grant, check limits, claim the idempotency key, reserve capacity, create the operation and enqueue a Graphile job. Workers then serialize per machine and append `ProviderAttempt` rows before every external call. If the process dies after Hetzner accepts a create but before we record success, that attempt becomes `outcome_unknown`; the operation stops spending new money until inventory reconciliation finds the labeled server or an operator resolves it.

Machine and allocation are separate. `MachineId` is the customer reference. `AllocationId` is the concrete provider server generation. Resize creates an operation against the current allocation and records the billing transition only when provider evidence says the new shape is active. Destroy requires a recovery summary and a grant with `allowDataLoss` when unregistered disk state may be lost.

Validation lives at boundaries with Zod schemas for HTTP and worker payloads; inside the service, branded IDs and discriminated states carry the invariants, per boundary-discipline and encode-lessons-in-structure. Lifecycle compatibility is a pure function (`planTransition`) so local fault tests can exercise every crash point without mocking Hono. Effects are explicit interfaces: `LifecycleStore`, `ProviderPort`, `GuestVerifier`, and `JobQueue`. Transactions accept callbacks and return typed rows; cloud calls cannot run inside them.

Conflicting operations are rejected or queued by a per-machine lock plus machine `resourceVersion`. Create is keyed by project and idempotency. Reboot, resize, and destroy are keyed by machine and require the caller to target the observed version, preventing stale agents from destroying a machine after another operation replaced its allocation.

# Synthesis decision

Candidate artifact only; synthesis is filled by the parent arena.

# Tradeoffs accepted

- We accept a slightly heavier operation model in exchange for safe recovery from worker crashes and provider ambiguity.
- We accept blocking ambiguous creates in exchange for avoiding duplicate paid machines.
- We accept caller-supplied `expectedVersion` on mutable operations in exchange for simple stale-agent protection without distributed locks.
- We accept local fake-provider fault tests first in exchange for useful coverage before Hetzner verification or budget exists.

# Alternatives considered

- Direct provider calls in Hono handlers: simpler at first, but request timeouts and crashes would lose the boundary between intent and external effects.
- One `machines` table with provider fields inline: fewer joins, but restore, unknown create, and replacement allocation all become special cases.
- Treat Graphile job uniqueness as idempotency: insufficient because external calls can complete after the worker loses the response.

# Open questions and risks

- Which exact Hetzner labels are stable enough to reconcile across paginated inventory and action APIs?
- Should resize support only same-disk grow operations in V1, leaving shrink and region migration to restore flows?
- What is the first local price book format for enforcing low-budget limits before billing exists?

# Next implementation step

Create the lifecycle package skeleton with Zod request schemas, branded domain types, `planTransition`, and fake-provider fault tests for create success, duplicate retry, and unknown-outcome reconciliation.


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

export const CreateMachineRequest = z.object({
  idempotencyKey: z.string().min(12),
  projectId: z.string(),
  region: z.string(),
  size: z.string(),
});
export const MutateMachineRequest = z.object({
  idempotencyKey: z.string().min(12),
  machineId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
});

export type Capability =
  | "machine:create"
  | "machine:reboot"
  | "machine:resize"
  | "machine:destroy"
  | "machine:destroy:data_loss";
export type Actor = { accountId: AccountId; grantId: GrantId; capabilities: ReadonlySet<Capability> };

export type MachineState =
  | { kind: "provisioning" }
  | { kind: "ready" | "rebooting" | "destroying"; allocationId: AllocationId }
  | { kind: "resizing"; allocationId: AllocationId; targetSize: string }
  | { kind: "destroyed" }
  | { kind: "blocked"; reason: BlockReason };
export type BlockReason = "provider_outcome_unknown" | "grant_or_limit_changed";
export type OperationKind = "create" | "reboot" | "resize" | "destroy";
export type OperationPhase = "accepted" | "running" | "waiting_for_guest" | "blocked_unknown_provider_outcome" | "succeeded" | "failed";
export type Operation = {
  id: OperationId;
  kind: OperationKind;
  accountId: AccountId;
  projectId: ProjectId;
  machineId?: MachineId;
  phase: OperationPhase;
  requestHash: string;
  createdAt: Date;
};

export type ProviderAttempt =
  | { id: ProviderAttemptId; operationId: OperationId; outcome: "pending"; requestDigest: string }
  | { id: ProviderAttemptId; operationId: OperationId; outcome: "succeeded"; providerServerId: string; actionId?: string }
  | { id: ProviderAttemptId; operationId: OperationId; outcome: "failed"; retryable: boolean; message: string }
  | { id: ProviderAttemptId; operationId: OperationId; outcome: "unknown"; evidence: string };

export type LifecycleCommand =
  | { kind: "create"; actor: Actor; projectId: ProjectId; region: string; size: string; idempotencyKey: string }
  | { kind: "reboot" | "resize" | "destroy"; actor: Actor; machineId: MachineId; expectedVersion: number; idempotencyKey: string; size?: string; allowDataLoss?: boolean };
export type AcceptedOperation = { operationId: OperationId; machineId?: MachineId; phase: OperationPhase };

export interface LifecycleStore {
  transaction<T>(fn: (tx: LifecycleTx) => Promise<T>): Promise<T>;
}
export interface LifecycleTx {
  claimIdempotency(cmd: LifecycleCommand, requestHash: string): Promise<AcceptedOperation | null>;
  assertGrant(actor: Actor, capability: Capability, scope: ProjectId | MachineId): Promise<void>;
  reserveLimits(cmd: LifecycleCommand): Promise<void>;
  insertOperation(cmd: LifecycleCommand, requestHash: string): Promise<AcceptedOperation>;
  enqueueOperation(operationId: OperationId): Promise<void>;
}

export interface OperationStore {
  withMachineLock<T>(operationId: OperationId, fn: (ctx: LockedOperation) => Promise<T>): Promise<T>;
  recordProviderAttempt(input: { operationId: OperationId; requestDigest: string; labels: Record<string, string> }): Promise<ProviderAttemptId>;
  markAttemptOutcome(id: ProviderAttemptId, outcome: ProviderAttempt["outcome"], evidence?: unknown): Promise<void>;
  applyTransition(operationId: OperationId, transition: PlannedTransition): Promise<void>;
}
export type LockedOperation = {
  operation: Operation;
  machine?: { id: MachineId; state: MachineState; resourceVersion: number };
};

export type PlannedTransition =
  | { effect: "provider.create"; region: string; size: string; labels: Record<string, string> }
  | { effect: "provider.reboot" | "provider.destroy"; providerServerId: string }
  | { effect: "provider.resize"; providerServerId: string; size: string }
  | { effect: "guest.verify"; allocationId: AllocationId }
  | { effect: "mark.succeeded" }
  | { effect: "block"; reason: BlockReason };

export interface ProviderPort {
  createServer(input: { region: string; size: string; labels: Record<string, string> }): Promise<ProviderCreateResult>;
  rebootServer(providerServerId: string): Promise<ProviderActionResult>;
  resizeServer(providerServerId: string, size: string): Promise<ProviderActionResult>;
  destroyServer(providerServerId: string): Promise<ProviderActionResult>;
  findServersByLabels(labels: Record<string, string>): Promise<ReadonlyArray<ObservedServer>>;
}
export type ProviderCreateResult =
  | { kind: "accepted"; providerServerId: string; actionId: string }
  | { kind: "rejected"; retryable: boolean; message: string }
  | { kind: "unknown"; evidence: string };
export type ProviderActionResult =
  | { kind: "accepted"; actionId: string }
  | { kind: "rejected"; retryable: boolean; message: string }
  | { kind: "unknown"; evidence: string };
export type ObservedServer = { providerServerId: string; labels: Record<string, string>; size: string; status: string };
export interface GuestVerifier { verifyAllocation(allocationId: AllocationId): Promise<"ready" | "not_ready">; }

export function planTransition(ctx: LockedOperation): PlannedTransition { throw new Error("not implemented"); }
export async function acceptLifecycleCommand(store: LifecycleStore, cmd: LifecycleCommand): Promise<AcceptedOperation> { throw new Error("not implemented"); }
export async function runOperation(store: OperationStore, provider: ProviderPort, guest: GuestVerifier, operationId: OperationId): Promise<void> { throw new Error("not implemented"); }
export async function reconcileProviderInventory(args: {
  store: OperationStore;
  provider: ProviderPort;
  providerProjectId: string;
  requestBudget: { take(): Promise<boolean> };
}): Promise<void> { throw new Error("not implemented"); }

```

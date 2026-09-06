Archived candidate, not implementation guidance. See ../architecture/overview.md for the synthesis.

# Problem

The first lifecycle slice must let an API caller create, reboot, resize, and destroy one VM-backed machine without assuming cloud calls are reliable or cheap. The product constraints push toward a small control plane: Node 24 TypeScript strict, Zod at HTTP/job boundaries, Hono, Postgres, Graphile Worker, low VM budget, no Stripe in this scope, and Hetzner verification still pending. The non-obvious part is avoiding double-created paid machines when a provider request succeeds but the worker loses the response.

# Usage (caller's view)

The public package exposes one lifecycle service. HTTP routes validate JSON with Zod, resolve the authenticated actor/grant, and call it. The service returns an operation immediately; callers poll operations instead of waiting for provider work.

```ts
const op = await lifecycle.createMachine(actor, {
  projectId,
  idempotencyKey: req.header("Idempotency-Key"),
  body: { name: "web-1", region: "fsn1", size: "cx22", image: "agent-base-v1" },
});

await lifecycle.rebootMachine(actor, {
  machineId,
  idempotencyKey,
  body: { mode: "graceful" },
});

await lifecycle.destroyMachine(actor, {
  machineId,
  idempotencyKey,
  body: { retainBackups: true, allowDataLoss: "explicit" },
});
```

Workers consume operation jobs by ID. A create worker claims the machine row, records a provider attempt before the Hetzner call, stores action/server IDs when known, and marks the attempt `outcome_unknown` on timeout or lost response. Reconciliation then owns unknown outcomes by matching provider labels before any retry.

# Shape

Data centers on `operations`, `machines`, `allocations`, `provider_attempts`, `resource_reservations`, and `idempotency_keys`. The only desired state is on `machines`; provider reality lives in `allocations` and attempts. Operations are durable commands with phases, not request logs.

Validation lives at ingress: Hono route schemas and Graphile job payload schemas. Inside, branded IDs and discriminated unions encode lifecycle constraints per boundary-discipline and type-system-discipline. A `PendingExternalAttempt` must be inserted before `ProviderEffects.createServer`; an unknown attempt cannot become another provider create. That invariant is represented by `canSubmitCreateAttempt(attempts)` returning either `{ ok: true }` or a blocking reason.

Transactions are narrow and explicit. `beginCreate` claims idempotency, checks grant limits, reserves capacity, creates the machine and operation, and transactionally enqueues the Graphile job. Workers use short transactions for phase transitions and attempts, then call provider effects outside the transaction. Per-machine locks serialize conflicting lifecycle operations; provider-project concurrency is a separate worker allowance.

Reconciliation is not a retry helper. It is an independent reader of provider inventory and recorded attempts. It can attach a found server to the canonical allocation, confirm deletion, or mark an operation blocked for operator resolution. Cleanup requires recorded ownership labels.

Module map: `http/lifecycle-routes.ts` parses requests and maps errors; `domain/lifecycle.ts` holds use-case functions and pure transition guards; `db/lifecycle-repo.ts` owns SQL and row locks; `jobs/lifecycle-worker.ts` runs operation effects; `jobs/reconciler.ts` resolves unknown outcomes; `providers/provider-effects.ts` is the fake/Hetzner interface for fault tests.

# Synthesis decision

Candidate C proposes the operation-at-center shape: route handlers only create durable operations, workers perform effects, and reconciliation owns ambiguous outcomes. The slice deliberately omits routing, billing, guest enrollment details, and Stripe hooks, except for reservation and grant interfaces needed to make lifecycle calls safe.

# Tradeoffs accepted

- We accept more operation bookkeeping in exchange for replay-safe workers and inspectable recovery.
- We accept blocked customer operations on unknown provider outcomes in exchange for avoiding duplicate paid servers.
- We accept one lifecycle service module before splitting packages in exchange for short call chains during the first slice.
- We accept a minimal provider interface in exchange for being able to fault-test Hetzner-like behavior locally.

# Alternatives considered

- Direct synchronous provider calls from Hono routes lost because request timeouts and process crashes would erase lifecycle progress.
- A generic workflow engine lost because the first slice needs a few idempotent transitions, not a new orchestration DSL.
- Machine-state-only modeling lost because resize, destroy, and unknown creates need durable command history and retry classification.

# Open questions and risks

- Should destructive data-loss permission live as a separate grant capability or as a required request field checked against `machine:destroy`?
- What is the first supported resize policy when the provider cannot downsize disks?
- How much provider inventory delay is acceptable before an unknown create requires operator resolution?

# Next implementation step

Create the Postgres migrations and repository methods for idempotency, operations, machines, reservations, and provider attempts, then wire one create route and one worker against a fake provider.


```typescript
import { z } from "zod";

type Brand<T, N extends string> = T & { readonly __brand: N };
export type AccountId = Brand<string, "AccountId">;
export type ProjectId = Brand<string, "ProjectId">;
export type MachineId = Brand<string, "MachineId">;
export type OperationId = Brand<string, "OperationId">;
export type AllocationId = Brand<string, "AllocationId">;
export type ProviderAttemptId = Brand<string, "ProviderAttemptId">;
export type IdempotencyKey = Brand<string, "IdempotencyKey">;

export const createMachineBody = z.object({ name: z.string().min(1).max(80), region: z.string().min(1), size: z.string().min(1), image: z.string().min(1) });
export const rebootMachineBody = z.object({ mode: z.enum(["graceful", "hard"]) });
export const resizeMachineBody = z.object({ size: z.string().min(1) });
export const destroyMachineBody = z.object({ retainBackups: z.boolean(), allowDataLoss: z.literal("explicit").optional() });

export type Actor = { accountId: AccountId; grantId: string; capabilities: ReadonlySet<Capability> };
export type Capability =
  | "machine:create"
  | "machine:reboot"
  | "machine:resize"
  | "machine:destroy"
  | "machine:destroy:data-loss";

export type Machine = { id: MachineId; accountId: AccountId; projectId: ProjectId; desired: DesiredMachineState; allocationId: AllocationId | null; version: number };
export type DesiredMachineState =
  | { kind: "provisioning"; size: string; region: string; image: string }
  | { kind: "ready"; size: string }
  | { kind: "rebooting"; previous: "ready" }
  | { kind: "resizing"; fromSize: string; toSize: string }
  | { kind: "destroying"; retainBackups: boolean };

export type OperationKind = "create" | "reboot" | "resize" | "destroy";
export type Operation = {
  id: OperationId;
  accountId: AccountId;
  machineId: MachineId;
  kind: OperationKind;
  phase: OperationPhase;
  requestHash: string;
  version: number;
};
export type OperationPhase = "queued" | "running" | "blocked_unknown_provider_outcome" | "reconciling" | "succeeded" | "failed";

export type ProviderAttempt =
  | { id: ProviderAttemptId; operationId: OperationId; kind: "create"; digest: string; result: "pending" }
  | { id: ProviderAttemptId; operationId: OperationId; kind: "create"; digest: string; result: "outcome_unknown" }
  | { id: ProviderAttemptId; operationId: OperationId; kind: "create"; digest: string; result: "known"; serverId: string; actionId: string }
  | { id: ProviderAttemptId; operationId: OperationId; kind: "delete" | "reboot" | "resize"; digest: string; result: "pending" | "known" | "outcome_unknown"; actionId?: string };

export type BeginResult = { operationId: OperationId; machineId: MachineId; reused: boolean };
export type LifecycleService = {
  createMachine(actor: Actor, input: CreateMachineInput): Promise<BeginResult>;
  rebootMachine(actor: Actor, input: RebootMachineInput): Promise<BeginResult>;
  resizeMachine(actor: Actor, input: ResizeMachineInput): Promise<BeginResult>;
  destroyMachine(actor: Actor, input: DestroyMachineInput): Promise<BeginResult>;
  getOperation(actor: Actor, operationId: OperationId): Promise<Operation>;
};
export type CreateMachineInput = { projectId: ProjectId; idempotencyKey: IdempotencyKey; body: z.infer<typeof createMachineBody> };
export type RebootMachineInput = { machineId: MachineId; idempotencyKey: IdempotencyKey; body: z.infer<typeof rebootMachineBody> };
export type ResizeMachineInput = { machineId: MachineId; idempotencyKey: IdempotencyKey; body: z.infer<typeof resizeMachineBody> };
export type DestroyMachineInput = { machineId: MachineId; idempotencyKey: IdempotencyKey; body: z.infer<typeof destroyMachineBody> };

export type UnitOfWork = { lifecycle: LifecycleRepo; grants: GrantRepo; reservations: ReservationRepo; enqueueOperation(operationId: OperationId): Promise<void> };
export type Db = { tx<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T> };
export type LifecycleRepo = {
  claimIdempotency(args: { accountId: AccountId; endpoint: string; key: IdempotencyKey; requestHash: string }): Promise<{ reusedOperationId: OperationId | null }>;
  insertMachine(projectId: ProjectId, desired: DesiredMachineState): Promise<Machine>;
  insertOperation(args: { machineId: MachineId; kind: OperationKind; requestHash: string }): Promise<Operation>;
  lockMachine(machineId: MachineId): Promise<Machine>;
  listAttempts(operationId: OperationId): Promise<ProviderAttempt[]>;
  insertProviderAttempt(attempt: Omit<ProviderAttempt, "id">): Promise<ProviderAttempt>;
  markAttemptKnown(id: ProviderAttemptId, serverId: string, actionId: string): Promise<void>;
  markAttemptUnknown(id: ProviderAttemptId): Promise<void>;
  attachAllocation(machineId: MachineId, providerServerId: string): Promise<AllocationId>;
  transitionOperation(id: OperationId, phase: OperationPhase): Promise<void>;
};
export type GrantRepo = { assert(actor: Actor, capability: Capability, resource: ProjectId | MachineId): Promise<void> };
export type ReservationRepo = { reserveCreate(actor: Actor, body: z.infer<typeof createMachineBody>): Promise<void>; resolve(operationId: OperationId, outcome: "active" | "released"): Promise<void> };

export type ProviderEffects = {
  createServer(req: { name: string; region: string; size: string; image: string; labels: Record<string, string> }): Promise<{ serverId: string; actionId: string }>;
  rebootServer(serverId: string, mode: "graceful" | "hard"): Promise<{ actionId: string }>;
  resizeServer(serverId: string, size: string): Promise<{ actionId: string }>;
  deleteServer(serverId: string): Promise<{ actionId: string }>;
  findServersByLabels(labels: Record<string, string>): Promise<Array<{ serverId: string }>>;
};

export function canSubmitCreateAttempt(attempts: ProviderAttempt[]): { ok: true } | { ok: false; reason: "unknown_outcome" | "pending_attempt" } {
  if (attempts.some((a) => a.kind === "create" && a.result === "outcome_unknown")) return { ok: false, reason: "unknown_outcome" };
  if (attempts.some((a) => a.kind === "create" && a.result === "pending")) return { ok: false, reason: "pending_attempt" };
  return { ok: true };
}

export async function beginCreate(db: Db, actor: Actor, input: CreateMachineInput): Promise<BeginResult> {
  throw new Error("not implemented"); // tx: validate grant, claim idempotency, reserve, insert machine/op, enqueue.
}
export async function runCreateOperation(db: Db, provider: ProviderEffects, operationId: OperationId): Promise<void> {
  throw new Error("not implemented"); // lock machine, insert pending attempt, call provider, record known/unknown, verify, ready.
}
export async function reconcileUnknownCreates(db: Db, provider: ProviderEffects): Promise<void> {
  throw new Error("not implemented"); // compare attempts with labeled provider inventory; attach canonical or keep blocked.
}

```

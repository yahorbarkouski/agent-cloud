# Machine cleanup

## Usage

Use `acld machine destroy <id> --expected-version <version> --allow-data-loss --key <stable-key>` for a ready machine, a blocked create or a failed create with a retained allocation. The existing SDK call is `client.act({ machineId, command: { kind: 'destroy', expectedVersion, allowDataLoss: true }, idempotencyKey })`. Inspect the returned operation ID before retrying.

An active create returns its original operation, now carrying cleanup intent. It ends `cancelled` only after owned resources are absent and its allocation is retired. This is a terminal result, distinct from successful creation. A terminal failed create retains its result; a new ordinary destroy operation performs recovery and ends `succeeded`. Ready-machine destroy uses the same cleanup executor.

## Ownership and admission

The existing operation journal remains the lifecycle owner. An immutable `operation_cleanups` row, keyed by the executing operation ID, binds the admitting grant, expected version, allocation and original create operation. No separate authority UUID or cleanup job engine is needed. Operation intent identifies cleanup and its source operation; public inspection exposes this intent without private material.

Destroy admission takes a transaction-scoped machine advisory lock with the same key as worker/enrollment session locks, then the global admission lock, account row and machine row. Busy returns a retryable conflict. It reloads current grant authority, requires both destroy capabilities and explicit data-loss consent, checks version and persists intent/authority/idempotency/audit/job together. Accepted admission increments the machine version. Same-key replay reauthorizes against the current credential and returns the same operation before version checks. Other active lifecycle actions still block destroy; a nonterminal create can transfer its execution into cleanup.

Cleanup authority survives grant expiry/revocation only for deletion of exact owned resource IDs in that allocation. It grants no creation, resize, boot or guest signing. Current labels and IP assignment are re-observed before deletion. Fresh effects reject an operation with admitted cleanup. Admission changes progress away from guest enrollment under the machine lock, so enrollment cannot publish across acceptance.

## Reconciliation and deletion

`advance-operation.ts` dispatches cleanup before the ordinary pending-attempt branch. `machine-cleanup.ts` loads original source attempts, cleanup attempts and the complete allocation resource ledger. `effect-journal.ts` remains the owner of prepared-before-submit effects and immutable receipts/resolutions. Source reconciliation through a different executing operation explicitly validates the cleanup relationship.

Reconcile source attempts using original command labels, never the recovery operation's labels. Persist every exact-label duplicate ID before deleting any discovered resource. A duplicate source remains unresolved after all known duplicates disappear: an empty inventory is not authoritative closure of an unknown create. Every known resource remains in the ledger, including absence records. A later single inventory result must not erase earlier duplicate evidence.

Delete known owned servers while source uncertainty remains only when their IP cannot be auto-deleted by that action. If an owned attached IP has autoDelete enabled, preserve both resources until source reconciliation or explicit operator intervention makes deletion safe. This provider behavior was exposed by the first duplicate-cleanup test; unknown creates must not lose their IP through implicit VM deletion. Keep the source reservation and IP while any VM create remains pending. An acknowledged create with a fixed server ID can close as an exact absent observation only after its action is terminal and an exact-ID read proves absence; an unknown create with empty inventory cannot. No uncertain source create is ever resubmitted.

After source VM uncertainty closes and all known servers are absent, delete owned unassigned IPs. A resource mismatch blocks deletion. Provider read failures defer work without broadening authority. Complete only after every source/cleanup attempt is resolved and every recorded resource is absent. Preserve image pins: matching original server confirmation or fully retired ownership releases active snapshot use under the existing SQL rule.

Deletion retries append new exact-ID attempts; never overwrite or resubmit an old attempt. Reconcile a lost response first. If the exact same owned target is still present, an unknown or failed deletion may retry with bounded backoff (5 seconds, then 30 seconds), initially at most three submissions per target per cleanup. Accepted running actions wait; failed action reads do not authorize another delete. After exhaustion, keep `blocked/cleanup_retry_exhausted`, the resource ledger and reservation. Authoritative external deletion can still finish cleanup. The separate [operator recovery command](operator-recovery.md) can record externally established source closure or grant one additional exact-target deletion. Each decision is immutable, scoped and audited; it does not reset history or bypass ownership checks.

## Modules and verification

Contracts own cleanup intent, explicit cancelled terminal state and blocked retry exhaustion. Database migration0018 owns retained authority and guards against fresh effects, mutable cleanup identity and premature retirement/completion. `cleanup-admission.ts` owns destroy admission; the existing lifecycle entry point routes destroy there. `machine-cleanup.ts` owns cleanup progression. Existing SDK/CLI destroy callers retain their command shape; operation waiting recognizes cancellation.

Verification covers tenant/data-loss/version/idempotency boundaries; session-versus-transaction lock races; cancellation before any effect, after IP and after VM; revocation after acceptance; unknown/duplicate create retention; exact labels, delayed inventory and lost/failed delete responses; bounded retry exhaustion; terminal failed recovery; enrollment races and image pins; and actual local CLI/API/worker cleanup. No paid resource is required for this implementation slice.

## Synthesis decision

Base: candidate B, agreed by parent and independent gpt-5.6-sol judge (24/30). Parent scores were A15, B21, C12; both rank B first. B supplies the immutable relational cleanup authority and active/terminal split. From A, retain the version bump and compact use of the existing operation. From C, retain concrete failure/renewal/enrollment coverage and re-observation before delete retry.

Reject C's reopening of terminal operations and reporting cancelled creates as succeeded. Reject an extra public cancel-create action, duplicate authority UUID, generic cleanup planner framework and a second queue. Correct all candidates' underspecified duplicate closure and unbounded/permanently blocked deletion retry behavior. Keep operator-required uncertainty explicit. All three candidates and the judge were read in full; no dropout occurred. Private source artifacts are under `.local/recovery-design/`.

We accept cleanup-specific admission/controller modules to keep one durable operation owner and exact authority visible. We accept blocked unresolved source effects after known cost removal rather than invent evidence. This document defines the selected implementation contract; verification results belong in the progress and evidence documents.

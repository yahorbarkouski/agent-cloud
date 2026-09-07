# Blocked provisioning recovery

Grounded in commit157da958d54d87e5c15e0a6c7c8ceac01f5fe636 on 2026-09-07. This records the next implementation boundary, not completed cancellation behavior.

The customer runtime now exposes the missing recovery path. A create can have a confirmed owned VM while enrollment, runtime inspection or signing remains blocked. `lifecycle.ts` rejects every new machine action while a nonterminal operation exists. `one_active_operation` enforces the same limit in SQL. The customer cannot submit destroy for that blocked machine yet.

`beginFailure` in `advance-operation.ts` compensates only when there cannot be a VM and an unused IP remains. A possible VM preserves the allocation reservation. `claimResource` saves every provider resource and updates allocation.serverId when a server is found; that field alone does not represent duplicates or an unresolved create. The resource ledger and all create attempts remain authoritative for cleanup.

The journal permits `authorization: cleanup` only for IP deletion. Customer VM deletion currently needs a fresh authorization check for the saved lifecycle command. Reusing the old create credential to delete a VM would not establish data-loss permission. Recovery must persist its own authorized intent and audit evidence before deletion. A credential expiring after cleanup starts must not strand already-authorized deletion or expand its resource scope.

The controller reconciles the first pending attempt before selecting another effect. Unknown or merely prepared creates never resubmit. Empty inventory does not resolve uncertainty. Any recovery path must preserve that behavior, retain every known duplicate resource, and avoid deleting an IP while a create may still attach it. Exact resource IDs and current original ownership labels are required before deletion. Only authoritative absence releases the reservation.

An implementation needs to choose between cancellation recorded on the existing operation and a distinct cleanup operation that references the source attempts. The first fits the current single-operation journal, but needs explicit terminal/recovery semantics. The second preserves terminal source results but must reconcile source attempts without letting an old worker resume creation. Neither can be implemented by just clearing the active-operation index or changing a blocked row to failed.

Cancellation must serialize with a running machine controller, admission/idempotency, bootstrap rendering and enrollment completion. The existing machine advisory lock is the natural controller boundary, while admission also uses account and row locks. Establish a consistent lock order before adding nested transactions. After cancellation is durable, no fresh create may start. Outcomes of effects submitted before cancellation still need reconciliation.

The verification cases that decide readiness are:

- Cancellation before the first effect, after IP creation and after known VM creation.
- A lost create response, a crash after preparation, delayed inventory and known duplicate resources.
- Cancellation racing worker submission or guest enrollment, without a replacement create.
- Cross-tenant requests, missing data-loss permission, stale versions and repeated request keys.
- Revoked credentials after accepted cleanup, changed ownership labels, unavailable reads and lost deletion responses.
- VM and IP absence before reservation release, with original image pins preserved during uncertainty.
- Actual CLI/API/worker cancellation of a deliberately blocked fixture, followed by complete cleanup.

Complete this path before renting a customer VM for the bounded live drill. The image factory's independent recovery command already handles its own builds and should remain separate.

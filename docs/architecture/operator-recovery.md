# Operator recovery

This extends the admitted machine cleanup contract. The customer first requests destroy with data-loss authority. Recovery cannot create that authority, reopen a terminal operation or admit fresh resources.

Use `pnpm machine:recover inspect <cleanup-operation-id>` to read the original attempts, retained resources, recoveries and a state digest. `pnpm machine:recover apply <request.json>` requires local database access and the allocation's provider read credentials. It has no customer HTTP endpoint. The request identifies its UUID, account, allocation, cleanup operation, target attempt, inspected digest, operator and evidence reference/checksum. Reusing the UUID with identical content returns its original record; changed content conflicts.

Save a request as an owner-only JSON file of at most 16 KiB. Copy the scope and digest from inspection and generate one UUID per decision. For example:

```json
{
  "id": "<new recovery UUID>",
  "kind": "close_create",
  "accountId": "<account ID>",
  "allocationId": "<allocation ID>",
  "operationId": "<cleanup operation ID>",
  "attemptId": "<uncertain source attempt ID>",
  "expectedState": "<inspected stateDigest>",
  "operator": "operator@example.com",
  "evidence": {
    "reference": "<nonsecret provider case or evidence reference>",
    "sha256": "<checksum of the retained evidence>"
  },
  "providerRequestFinished": true,
  "resourceIds": ["<each retained source resource ID, including absent IDs>"]
}
```

An empty `resourceIds` array is valid only when the independently established complete resource set is empty. For `retry_delete`, use that kind and the latest deletion attempt ID; omit `providerRequestFinished` and `resourceIds`. The [contract](../../packages/contracts/src/operator-recovery.ts) rejects fields from another variant. Keep evidence content outside the database; the reference and checksum are audit metadata, not verified contents. The `operator` value is attribution supplied by the caller. Possession of local database and provider read credentials is the authorization boundary.

Two requests are supported:

- `close_create` records an explicit operator attestation that the original provider request has finished and the listed resource IDs are exhaustive. It is for prepared or unknown source creates during admitted cleanup. The operator must obtain independent provider evidence; an empty listing or elapsed timeout is insufficient. The command rechecks inventory and exact ownership, retains every discovered ID, and requires the supplied set to include historical absent resources. A distinct `operator_closed` resolution references the immutable recovery record. It neither claims successful creation nor invents an absent observation. Ordinary cleanup still observes each resource's absence before retirement.
- `retry_delete` grants one extra attempt after the existing exact target's deletion allowance is exhausted. It names the latest attempt and retains the receipt, retry history and existing backoff. A unique target-attempt constraint prevents repeated requests from multiplying the allowance. Further failures require another explicit decision.

`apps/control/src/operator-recovery.ts` owns inspection and admission under the existing machine lock. `packages/contracts/src/operator-recovery.ts` owns validated requests. An append-only SQL record binds recovery to cleanup, its original source and target attempt. SQL protects closure provenance, replay, terminality and retry allowance. `machine-cleanup.ts` consumes only the exact-target retry allowance. The existing worker performs deletion with its current labels and IP-assignment checks.

Provider reads occur under the machine session lock, outside a transaction. Final admission checks the inspected state again in a transaction and records recovery, source resolution where applicable, audit and wake-up together. A process crash before commit grants nothing. A response lost after commit replays the saved record. No recovery command submits provider mutations or loads pricing, images, bootstrap keys or signing credentials.

The evidence reference and digest identify operator-maintained evidence; the software cannot verify the truth of an out-of-band provider confirmation. Do not automate that attestation from inventory. Simulator cases verify enforcement and cleanup behavior, not the provider's consistency guarantees.

Verification must cover stale state, cross-allocation requests, machine-lock contention, false resource sets, delayed/duplicate inventory, retained receipts, idempotent replay, immutable records, forged closure, bounded additional retries and actual operator CLI parsing. No paid test is needed for this extension.

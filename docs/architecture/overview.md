# Architecture

Status: chosen implementation shape; features become verified only when recorded in `../PROGRESS.md`.

## Caller contract

An authenticated caller creates a machine with an idempotency key and receives an operation immediately. The worker performs the provider action, verifies its result, and advances that operation. A repeated request returns the same operation; the same key with a different body is a conflict. Other accounts cannot observe it.

```text
POST /v1/projects/:projectId/machines
Authorization: Bearer <scoped credential>
Idempotency-Key: <stable request identity>
{ "name": "example", "size": "small", "region": "nbg1" }

202 { "operation": { "id": "op_...", "kind": "machine.create", ... } }
```

`GET /v1/operations/:id` reports durable progress. `GET /v1/machines/:id` separates desired configuration, allocation, power, and guest readiness. Lifecycle changes require the observed machine version. Creation, restarting a worker, or a lost response must not silently issue a second paid allocation.

## Ownership and effects

- API routes validate requests and resolve authorization. One lifecycle service commits admission, idempotency, quota reservation, machine/operation rows, and Graphile job insertion in the same transaction.
- PostgreSQL is the durable source of desired state and owned external resources. Machine IDs survive replacement allocations.
- A worker holds a per-machine advisory lock on one database connection, uses short transactions for state changes, and performs provider I/O outside transactions. A second worker cannot advance the same machine concurrently.
- Every external mutation has a committed attempt row before submission. A crash after recording an attempt is treated as an unknown outcome until evidence resolves it, even if that conservatively blocks a call that was never sent.
- Unknown create outcomes retain quota reservations. Inventory can attach exactly one matching owned server. No matches is inconclusive; multiple matches require operator attention. No blind create retry.
- A grant is checked at admission and again before an unsubmitted external mutation. After a mutation was submitted, reconciliation and cleanup continue even if the grant is revoked, because stopping recovery would orphan resources.
- The simulated provider is an explicit development/testing adapter. It persists external-style state separately from lifecycle records and can lose responses, delay visibility, fail Actions, and expose duplicates. It never claims VM or SSH verification.
- Hetzner is the first real provider. Expose a small typed interface for submitting and observing its supported actions, not a generic multi-cloud workflow engine.

## Types and database rules

Zod schemas own public input/output and branded IDs. Discriminated unions describe operation progress, external outcomes, and allocation state. Avoid state bags with unrelated nullable fields at the domain boundary. SQL storage uses constraints and validated decoding to recover these unions.

Tenant-owned records carry account/project keys with composite foreign keys. Account rows serialize admission against aggregate quotas. Machine versions reject stale changes. Idempotency uniqueness includes the account and route scope. Attempts have unique sequence identities and cannot be overwritten to erase an unknown outcome.

## Source structure

Keep the planned folders but build only modules with behavior: `packages/contracts`, `packages/db`, `packages/hetzner`, `packages/sdk`, `apps/control`, and `apps/cli` first. Use pnpm workspaces and TypeScript project references. Public imports resolve built workspace packages; build before tests. This avoids custom module resolvers and speculative bundling infrastructure.

The control app owns lifecycle policy and workers. Shared packages own contracts, database schema/connection primitives, provider transport, and the client. A request should normally cross route, service, and database modules; split only when a real responsibility needs isolation.

## Synthesis

Three independent sketches were compared and a separate `gpt-5.6-sol` review scored A 21/25, B 18/25, and C 16/25. A is the base for separate allocations, optimistic versions, typed provider outcomes, and explicit guest readiness. Adopt B's worker-time grant checks and crash-boundary tests, and C's independent reconciliation responsibility and short module paths.

Reject all sketches' optional-field command bags: schemas will distinguish resize/destroy/reboot inputs. Reject their stale illustrative CX22/CX32 names; the researched initial catalog uses CX23/CX33/CX43 and live catalog validation is still required. Reject a generic unit-of-work/repository interface per table. Concrete transactions and narrow provider/runtime interfaces are enough.

## Accepted limits

Stripe is deferred. Administrative account policies supply resource limits without payments. Start local-first. A normal container can verify HTTP/process behavior but does not prove systemd, full VM boot, SSH host identity, or real provider recovery. Live tests are separate and must be cheap, labeled, time-limited, and cleaned up.

Unknown outcomes can delay a request. That is preferable to guessing whether a paid server exists. The operator resolution path must display evidence and preserve the audit history.

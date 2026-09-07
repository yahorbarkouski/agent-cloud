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
- Unknown create outcomes retain quota reservations. Inventory can attach exactly one matching owned resource. No matches is inconclusive; multiple matches require operator attention. No blind create retry.
- A grant is checked at admission and again before an unsubmitted external mutation. After a mutation was submitted, reconciliation and cleanup continue even if the grant is revoked, because stopping recovery would orphan resources.
- Resource cleanup follows the implemented [VM and Primary IP lifecycle](provider-resources.md). A create may compensate its unused IP only when VM non-submission is established; deletion waits for both resources to disappear.
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

## Account prices and admitted offers

M1 replaces the initial EUR-only estimates with explicit currencies. Account, grant, deployment, and allocation limits carry currency codes and integer micro-units. Admission rejects a mismatch rather than converting currencies. Provider decimal prices are parsed with integer arithmetic and rounded upward only below one micro-unit. Operator limits must be exactly representable.

A catalog snapshot records observation and expiry times. Offers bind size, exact provider type, region, architecture, availability, VM price, and IPv4 price. The provider uses explicit operator type mappings with no fallback. Missing or ambiguous prices exclude an offer. Catalog reads follow pagination and reject loops. VM and IP gross prices come from the same response as the account currency, including its tax treatment. Each stored offer records `priceBasis`: `account_gross`, `simulated`, or `legacy_estimate`. M0 stored only combined estimates; migrations preserve their totals but mark the reconstructed VM/IP split as a legacy estimate.

Admission reads a synchronous catalog snapshot after resolving idempotency. A stale catalog cannot prevent replay of an existing request or deletion of an existing machine. The selected offer is persisted on create and resize operations; allocations retain their current offer. Resizing compares the existing disk and architecture with the proposed offer. Reservations hold the greater amount until successful observation.

Before a fresh create or resize effect, the worker fetches a current catalog outside its transaction. A changed type, architecture, disk size, currency, or higher price fails before submission. It then rechecks current deployment, account, and grant limits under the global admission and account locks before journaling the attempt. Already-submitted work reconciles from its durable attempt even if prices change or capacity disappears. Success uses the admitted price, not whatever the catalog says later.

The live catalog adapter and read-only check work against Hetzner. The API refreshes complete snapshots outside database transactions, coalesces overlapping refreshes, and preserves the original TTL through a transient outage. Currency changes withdraw the previous snapshot. API/worker live activation is still gated on guest verification, operator resolution, and other ancillary spending limits. The resource ownership and cleanup path is implemented, with live behavior still awaiting a bounded integration test. The hourly VM/IP reservation does not limit traffic overage or total lifetime spend.

## Guest identity implementation

The selected [guest bootstrap design](guest-bootstrap.md) separates encrypted allocation secrets, key claims, certificate issuance and verified readiness. Storage and catalog refresh are implemented. `packages/pki` wraps Smallstep and validates certificate identity, public key, privileges and expiry. `packages/remote` uses native OpenSSH with isolated trust, explicit short-lived credentials and fixed read commands. The enrollment handler verifies confirmed provider ownership and direct pinned-key SSH before claiming keys. It commits certificates, token erasure and the runtime handoff together. Reference-only create_guest commands render pinned boot data only at initial submission; both legacy and current attempts remain reconcilable without resubmission.

The guest image boots and enrolls through actual cloud-init/systemd in a local Ubuntu VM. [Runtime readiness](guest-runtime.md) now gates create/reboot/power-on completion on fresh restricted SSH evidence, matching image/identity, component health and disk space. Reboot requires a new boot ID. Signing budgets persist, and completion checks the database deadline again after network work. Local drills stop services and constrain a temporary filesystem, then prove recovery and reboot. Local image sanitation and cloned identity proof are verified. Production worker wiring, provider snapshot publication, certificate renewal and bounded Hetzner validation remain open.

## Public image provenance

`packages/images` owns complete input inspection, digest construction, trusted transfer preflight and Ed25519 release verification. Manifest format 2 binds installer, executable, service/policy files, pinned artifacts and public trust through a sorted inventory. Builds publish read-only directories named by manifest digest; callers select and verify one directory before use. The controller-owned transfer check uses base OS tools before uploaded code executes.

The [image publication design](image-release.md) assigns temporary builders, access resources and snapshots to a sibling operator journal. The journal and Hetzner image/access transport are implemented with exact effect ownership, admission caps, uncertain-outcome reconciliation and cleanup planning. Operator key preparation, prepared builder boot rendering and pinned SSH/SFTP installation are implemented separately from the read-only guest probe. The live phase runner, snapshot boot verification and release promotion remain open. Cryptographic release validation authenticates recorded evidence; it cannot by itself prove current provider ownership or which snapshot a verifier actually booted.

# Operator recovery implementation review

## Verdict

**Approved for the reviewed implementation slice; no blocker found.** Operator recovery remains subordinate to an already admitted cleanup, uses the existing machine lock, performs provider reads only, preserves original outcomes, and records explicit closure/retry authority durably. Empty inventory is never interpreted as provider closure.

I independently reran `pnpm vitest run tests/machine-cleanup.test.ts` against the stable tree: **33/33 passed** in 13.40 seconds. Final full run 94746 passed typecheck, lint, and **420/420 tests across 36 files** in 104.25 seconds (`.local/operator-recovery-check-2.log`).

## Corrected verification fixtures

The first independent run exposed two test-fixture defects, not production defects:

- The retry fixture selected the last global history row even though deliberately aged deletion rows sort before source-create history. It now selects the last `destroy` attempt explicitly (`tests/machine-cleanup.test.ts:1000-1021`).
- The IP closure fixture used the server-create fault input. It now uses the simulator's documented `primaryIpFault`, leaving the uncertain IP attempt pending deterministically (`tests/machine-cleanup.test.ts:1056-1075`).

The stable rerun passed both cases. The earlier 36/37 run remains intermediate evidence with its known strict-Zod fixture error and should not be presented as final.

## Confirmed implementation properties

- **Narrow authority:** `operator-recovery.ts:43-115` requires an existing `operation_cleanups` row and serializes inspection/application with `withMachineLock`. It binds request account/allocation/provider to the admitted cleanup and rejects retired or terminal cleanup.
- **Optimistic state binding:** inspection hashes sorted attempts, resources, and recoveries. Application checks the digest before reads and again in the admission transaction. Inventory discoveries are intentionally durable: if reads add a resource, the stale request is rejected and the operator must inspect the expanded ledger.
- **Honest closure:** `close_create` accepts only a pending prepared/unknown source create. It scans all inventory results, retains every valid exact-label claim even when another result mismatches, requires the request to acknowledge every historical source resource ID including absent rows, and exact-reads each known ID. Inventory absence alone does not close anything; `providerRequestFinished: true` is the explicit out-of-band attestation.
- **Immutable provenance:** the transaction inserts `operator_recoveries` before changing resolution to `{kind:'operator_closed', recoveryId}`. Migration 0019 permits that transition only from pending, preserves outcome, and requires the exact immutable recovery record tied to the source attempt and cleanup. Recovery rows and provider attempts cannot be updated or deleted.
- **Resolution ownership:** automatic provider evaluation explicitly excludes `operator_closed`; only the operator-recovery transaction can create that resolution, and ordinary reconciliation cannot reinterpret or overwrite it.
- **Bounded retry extension:** `retry_delete` requires the latest exact-command attempt, current live owned resource, exhausted current allowance, and a non-running accepted action. Each immutable recovery is unique per target attempt. `cleanup_delete_limit()` adds one allowance per prior decision for that exact command; after the extra attempt fails, another decision must target the new latest attempt. Worker and SQL use the same limit.
- **Provider/read separation:** `RecoveryProvider` omits `submit`; `HetznerInventory` contains only action/resource/inventory reads, while `HetznerProvider` subclasses it to add catalog and mutation. The operator CLI constructs the read-only class, reads its request from an owner-protected file, does not expose an HTTP route, sanitizes failures, and closes its DB pool.
- **Cleanup remains authoritative:** after closure, the existing worker still re-observes labels, current IP assignment, and exact absence before deletion/retirement. Operator recovery neither records resource absence nor mutates provider state.

## Claims and limits

The architecture document correctly states that the evidence reference/hash is operator-maintained metadata whose truth the software cannot verify. The local script authenticates the operator by possession of database and provider-read credentials; the free-form `operator` field is attribution, not cryptographic identity. This is stated clearly and is not a hidden guarantee.

The final decision row accurately reports 420 tests, both local smokes, all 20 migration hashes, and zero provider resources. The earlier implementation row remains marked “verification in progress,” preserving the chronology rather than rewriting it. No reviewed evidence proves live-provider closure correctness or performs a provider mutation.

The Hetzner inventory extraction preserves the previous parsing, pagination, 404 handling, exact-label filtering, and numeric-ID checks. No behavior change was found beyond making the read surface independently constructible.

## Final evidence and trail

- Native cleanup session 60304 passed the real built CLI → HTTP → PostgreSQL → Graphile path and disposed its database/credentials (`.local/operator-recovery-cleanup-smoke.log`). Restarted development CLI session 49678 also passed and cleaned its simulated machine (`.local/operator-recovery-local-smoke.log`).
- Migration 0019 is applied in development; the migration audit reports 20 expected/applied migrations with every hash matching. Its now-immutable hash is `92dcf490e4a775ed21daa5a69beefc67e914d308e0f55b87201722c8562f931b`; migration 0018 still matches its prior immutable hash.
- Final local state reports zero active allocations, simulated servers/IPs, and unfinished image builds at 13:22Z. The actual Hetzner read reports zero servers, Primary IPs, snapshots, firewalls, and SSH keys at 13:21Z. These are cleanup/inventory observations, not a live operator-closure test.
- `docs/research/m1-operator-recovery-verification.json` accurately records the successful runs, intermediate failures and corrections, attestation limit, absent transcript directory, pending implementation commit, and `pending_private_push` CI state. Formatting, push, and exact Linux CI remain pending and are stated as such in `docs/PROGRESS.md`.
- README, AGENTS, customer skill, operator runtime, and operator recovery docs consistently keep operator recovery outside customer authority. They state that evidence truth is not software-verified, closure cannot come from empty inventory, and retry grants exactly one additional exact-target attempt per decision.

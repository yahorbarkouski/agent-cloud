# M1 pricing and credential checkpoint review

Reviewed the uncommitted checkpoint against `bbd33adfa34a76169a81e9f1def35e21aefcdae1`. The review covered explicit currency handling, stored offers, fresh-effect checks, migrations 0002 through 0004, credential intake, and the read-only Hetzner catalog path. Live provider mutation and later M1 provisioning work were out of scope.

No `agent-transcripts/` directory was supplied or present in this workspace. I could not audit the earlier CLI smoke, browser credential transfer, or live catalog command against a transcript. I used the current code, PostgreSQL integration tests, the append-only decision log, and `docs/research/hetzner-catalog-check-2026-09-06.json`. The refreshed catalog artifact records `account_gross` USD offers observed at 20:56:14 UTC and zero servers and Primary IPs.

## Standards

The first pass found four hard gaps against `AGENTS.md`:

- `apps/control/src/advance-operation.ts:423` could complete an accepted create without checking the returned server type, region, or ownership labels. It now blocks the operation with `provider_resource_mismatch`; `tests/pricing.test.ts:174` covers all three mismatches.
- `apps/control/src/advance-operation.ts:104` rechecked account and grant limits but not the current deployment limit. It now receives the worker limits, takes the global admission lock, and rechecks global currency, hourly cost, and machine count before recording an attempt. `tests/pricing.test.ts:164` covers a lowered deployment budget.
- `packages/db/src/schema.ts:22` and `:102` allowed implicit EUR values. Migration `0003_explicit_currency_guards.sql` drops those defaults, validates account currency format, and ties allocation currency to its account through a composite foreign key. The migration initially put the foreign key before its referenced unique key; the real PostgreSQL migration test failed with `42830`, and the final migration orders them correctly.
- `scripts/receive-hetzner-token.ts:9` followed a pre-existing `.local` directory symlink. It now requires a real owner-only directory before listening, with regression coverage at `tests/credential-intake.test.ts:138`.

I found no remaining hard standards violation in the bounded slice after these changes. The explicit modules do not show a Fowler smell that justifies another abstraction.

## Spec

The first pass found two pricing-evidence problems:

- `packages/hetzner/src/catalog.ts:58` originally paired currency and IPv4 prices from `/pricing` with VM prices from a later `/server_types` response. The reader now obtains denomination, VM prices, and IP prices from one `/pricing` response and uses paginated `/server_types` only for specs and capacity. `tests/catalog.test.ts:149` covers disagreement between the responses.
- `0002_account_currency_offers.sql:20` reconstructs VM and IP components for M0 records even though M0 stored only their combined estimate. Migration `0004_offer_price_basis.sql` now marks them `legacy_estimate`, while current simulated and live offers carry `simulated` and `account_gross`. `packages/contracts/src/catalog.ts:47` rejects a catalog whose item price basis disagrees with its catalog pricing mode. README and architecture text now describe the synthetic legacy split rather than claiming exact historical components.

The current implementation matches the checkpoint spec for gross integer micro-unit reservations, explicit currency, no automatic type substitution, synchronous admission snapshots, persisted create/resize offers, fresh catalog and limit checks before an attempt, and catalog-independent reconciliation after submission. The read-only check has no mutation call site and its durable artifact contains no credential.

One coverage gap remains: `tests/migration.test.ts:28` exercises queued and prepared M0 creates, authenticates the preserved fake credential, and proves one attempt and one server after upgrade, but it does not exercise the separate resize-offer backfill branch at `0002_account_currency_offers.sql:36`. The SQL and worker path look consistent on inspection, but the checkpoint should not claim migrated queued or prepared resizes are regression-tested.

The documentation correctly leaves live activation disabled. This checkpoint does not prove guest boot or identity, Primary IP ownership and cleanup, runtime catalog refresh, traffic and other ancillary limits, or operator resolution of unknown and duplicate resources.

## Verification boundary

The main run reported 40 tests passing before the last review fixes and started the final full check afterward. This reviewer inspected the added regression cases and the corrected migrations but did not independently complete the final full test, lint, formatting, skill-validation, migration/restart, or CLI-smoke run. Record those results only after their commands finish. The refreshed live catalog artifact is schema-valid and reports zero paid resources; no cloud mutation was performed in this review.

## Attention

reviewed by gpt-5.6-sol

- Add a migrated resize case if compatibility for queued or prepared M0 resizes is part of this checkpoint's claim.
- Treat the prior real CLI smoke and browser credential-transfer claims as run evidence from the main task, not as transcript-audited facts; no transcript was available here.
- Keep live activation gated on the remaining M1 ownership, cleanup, guest, refresh, and operator-resolution work listed in `docs/PROGRESS.md`.


## Main-task verification after review

The main task completed the final `pnpm check` with 41 tests in six files, typecheck, and strict lint. Migrations 0003–0004 then applied to the development database; the API and worker restarted and `pnpm smoke:local` passed creation, inspection, deletion, and cleanup for `vm_7f5d518f-1e8d-4425-8840-6dab13c63d2e`. These are main-task command results, not an additional independent reviewer run.

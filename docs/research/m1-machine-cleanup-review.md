# Machine cleanup implementation review

## Verdict

**Approved for this implementation slice; no remaining code blocker found.** The implementation follows the selected architecture closely: destroy admission is serialized with worker/enrollment, cleanup authority is durable and narrow, terminal source operations remain unchanged, source uncertainty is retained honestly, duplicate IDs are journaled, deletion attempts are append-only and bounded, and SQL prevents premature retirement/terminal completion.

Final verification evidence: the full check passed typecheck, lint, and **407/407 tests across 36 files** in 97.15 seconds (`.local/cleanup-check-final.log`). The focused cleanup/network run passed 48/48 tests (`.local/cleanup-network-review.log`). `cleanup-typecheck-6.log` is the sixth log name, not six passing runs; runs 1, 3, 4, and 6 passed, while intermediate runs 2 and 5 exposed typing defects that were subsequently fixed. The final native cleanup and development CLI smokes passed (`.local/cleanup-native-final.log`, `.local/cleanup-local-final.log`). All provider behavior in those smokes was simulated. Nothing here proves a customer Hetzner boot or live cleanup.

## Closed finding

### [P1] Verify that an owned attached IP is assigned to the server being deleted

`apps/control/src/machine-cleanup.ts:140-158`

The earlier blocker is closed. When a server reports `primaryIpId`, cleanup now requires the exact retained IP, matching current labels, `assignment.kind === 'server'`, and `assignment.serverId === observed.id` before server deletion. It continues to defer deletion when a pending VM create could lose an `autoDelete` IP implicitly.

`tests/machine-cleanup.test.ts:562-587` covers all four inconsistent assignment cases: unassigned and assigned to another server, each with `autoDelete` true and false. Each blocks before a destroy attempt. The duplicate simulator also now models the provider invariant honestly: the duplicate is orphaned and cannot share the original server's exclusively assigned Primary IP.

## Confirmed behavior

- **Authorization and locks:** `cleanup-admission.ts:38-72` checks tenant ownership before exposing lock state, takes the transaction machine advisory lock before the global/account/machine locks, reloads the grant, and requires destroy plus data-loss authority. `operation_cleanups` binds executor, source, allocation, account, grant and admitted version. `effect-journal.ts:113-199` blocks fresh work after admission and permits only exact live owned server/IP deletion after revocation.
- **Terminal preservation:** active create cleanup reuses the create and ends `cancelled`; ready or failed terminal creates get a new `machine.destroy`. `advance-operation.ts:330-346` returns on terminal operations before cleanup dispatch, so a terminal source is never reopened. The migration permits only `cancelled` for a cleanup create and `succeeded` for cleanup destroy.
- **Unknown and duplicate creates:** `effect-journal.ts:283-319` scans the entire inventory result, retains every valid exact-label resource even if an earlier item is mismatched or conflicts with an ownership claim, and only then blocks on any mismatch. The mixed-inventory test at `machine-cleanup.test.ts:589-615` proves both valid duplicates survive while the mismatched ID is rejected and the source attempt stays pending. Retained discoveries are counted even after absence, so later empty/single inventory cannot erase duplicate evidence. Prepared/unknown empty inventory remains pending. `machine-cleanup.ts:185` prevents retirement while any such source attempt remains pending.
- **IP retention:** `machine-cleanup.ts:115-121` never selects an IP while a VM create remains pending. The `autoDelete` guard also prevents known-server deletion from implicitly removing the owned IP during that uncertainty after proving the exact current assignment.
- **Delete reconciliation and retries:** pending attempts are reconciled before new work. Exact absence confirms lost delete responses without resubmission. A still-present exact owned target receives a new immutable attempt after persisted 5/30-second delays, with three total submissions enforced in both application code and SQL. Exhaustion remains blocked while external authoritative absence can still complete recovery.
- **SQL retention:** migration `0018_operation_cleanups.sql` makes cleanup authority immutable/undeletable, rejects fresh/source effects after cleanup admission, restricts cleanup attempts to exact live ledger resources, prevents IP deletion with pending VM ownership, and gates allocation retirement and terminality on no pending attempts/no live resources.

## Non-blocking observations

The SQL identity guard ties source and allocation through their common machine rather than a direct allocation-to-source-operation key (`0018_operation_cleanups.sql:20-39`). That matches the current model, where a machine has one source create, but the invariant should be revisited before any future reprovisioning/reallocation feature permits multiple creates for one machine.

The architecture document accurately records that provider `autoDelete` changed the safe deletion boundary and that operator recovery is outside this slice. The last three decision rows are consistent with the code and test evidence. The claimed verification boundary is honest: simulated cleanup is covered; paid-provider boot is not.

The native smoke is meaningful rather than a direct controller test: it invokes the built CLI against a bound HTTP server, admits a normal create, establishes one journaled lost-response create, verifies blocked uncertainty, admits destroy through the CLI, exposes delayed inventory, then lets Graphile perform cancellation. It asserts one source create, `cancelled`, destroyed machine state, retired allocation, no live ledger resources, and no simulated VM/IP. The final control flow catches the primary failure, attempts every runner/pool/server/database/directory cleanup without throwing inside `finally`, aggregates all failures after cleanup, and prints success only when none occurred. The final native log therefore matches the final source and proves fixture disposal preceded success output.

The README smoke wording is now consistent. Migration 0018 was applied, all 19 migration hashes matched, and the supplied final SQL/provider reads reported zero resources at 12:51Z. The immutable migration hash is `28603225656aa7d881cfea9b86e638bcf885982b8dbbcb2c81dd78d7aa85c719`.

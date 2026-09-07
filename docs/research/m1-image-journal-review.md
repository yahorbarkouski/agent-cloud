# M1 operator image journal review

## Scope and conclusion

Read-only review of the image build/provider contracts, budget and admission code, effect policy/journal, resource ownership, abort cleanup, migration 0009, operator CLI tests and updated validation trail. I did not edit implementation or run provider/VM actions. No active-workspace transcript directory was supplied, so this is an artifact review rather than a transcript audit.

The original review's exact-ID retry and both duplicate-cleanup findings are fixed. Prepared/unknown power-off and delete effects can delegate through an immutable `superseded` resolution to a prepared identical replacement; create effects cannot use that path. Abort cleanup can delete recorded duplicates from unknown or accepted outcomes while retaining unresolved create history and operator reservation. SQL enforces the replacement relationship and requires cleanup state before deletion.

Successful retained-release cleanup and promotion are explicitly unfinished and are not exposed as working behavior, so retention is a future-scope requirement rather than a defect in the current full-abort command. No remaining code blocker was found within this journal/admission/abort milestone.

## Remaining findings

None within the implemented milestone.

## Fixed findings

### Exact-ID stop/delete recovery

`runImageEffect` first reconciles the last attempt. A prepared/unknown power-off or delete that still has not reached its target state may create an append-only identical replacement (`apps/control/src/image-effect-journal.ts:169-250`). The original row's outcome remains unchanged and its resolution becomes `superseded { byEffectId }` in the same transaction that inserts the prepared replacement. Create commands are excluded by both application logic and the SQL trigger.

Migration 0009 permits supersession only from pending prepared/unknown power-off or delete, requires the referenced replacement to belong to the same build, carry an identical command, differ in ID, and still be prepared/pending (`packages/db/migrations/0009_image_builds.sql:122-131`). The prepared/unknown deletion regression confirms the original receipt and link remain visible (`tests/image-builds.test.ts:291-321`). A missing builder resolves pending power-off as failed, so abort deletion of the source cannot strand shutdown reconciliation (`apps/control/src/image-effect-journal.ts:138-149`).

This is the correct asymmetry: creates never retry because they can allocate duplicates; power-off/delete operate on a confirmed exact provider ID and can be retried after current ownership validation.

### Unknown-outcome duplicate cleanup

Reconciliation unions currently found IDs with every previously claimed ID for the create effect, so deleting one duplicate cannot erase the historical ambiguity (`apps/control/src/image-effect-journal.ts:75-107`). Abort cleanup may select an observed duplicate even while its create effect remains pending, deletes known IDs one at a time, and then remains waiting rather than releasing reservation (`apps/control/src/image-cleanup.ts:38-82`). The regression proves two unknown-response duplicates are both removed, the create stays pending, and no second create is submitted.

### Accepted-receipt duplicate cleanup

Cleanup now waits only while the accepted provider action is actually running (`apps/control/src/image-cleanup.ts:39-47`). After it succeeds, observed exact-label duplicates may be selected and deleted while the create remains unresolved. Reconciliation avoids reclaiming only an identical receipt identity already present in the journal; it does not suppress observation of a provider resource that reappears after recorded absence (`apps/control/src/image-effect-journal.ts:62-103`). The accepted-action regression creates two matching Primary IP candidates, deletes both, and proves the build still waits with its uncertain reservation (`tests/image-builds.test.ts:346-380`).

### SQL ownership and lifecycle guards

The migration now rejects deletion effects before a cleanup request (`packages/db/migrations/0009_image_builds.sql:104-111`). Its supersession guard prevents create retries and forged replacement links. The cross-scope trigger takes the same provider/kind/ID advisory transaction lock for image and customer resource inserts, then rejects a provider identity already owned by the other journal (`packages/db/migrations/0009_image_builds.sql:182-201`). This closes the race that independent primary keys would otherwise permit.

Migration history is append-only in the current files. Migration 0009 leaves the customer trigger as `BEFORE INSERT`; migration 0010 alone replaces it with `BEFORE INSERT OR UPDATE OF provider, kind, provider_id`. The parent reports session `29387` applied 0010 and compared both SQL file hashes with the recorded Drizzle migration rows: all hashes matched, 11 migrations were present, and allocations, image builds and simulated provider resources were zero. My earlier observation of 0009 raced the restoration and is withdrawn.

## Spending and admission assessment

The spending boundary is conservative and internally consistent:

- `imageReservation` rounds the entire deadline up to hours separately for both builder and verifier, using the offer's gross combined VM+IPv4 hourly price, and reserves `maxSnapshotGb` for a full month.
- Admission requires account-gross pricing, one currency across offer/storage/budget, matching architecture, snapshot ceiling at least the offer disk, a future deadline no more than 24 hours away, and retained deletion after the build deadline but within 30 days.
- Per-build maxima must cover the calculated VM/IP and snapshot reservations. Aggregate open-build limits are serialized with a global transaction advisory lock and sum admitted caps, which is at least as conservative as summing calculated use.
- Every fresh create refreshes exact catalog/storage evidence and rejects server type, region selection, architecture, disk/memory/vCPU, currency, component-price or storage-price increases. There is no fallback. Existing cleanup does not fetch prices or require remaining fresh allowance.
- Cleaning and unresolved builds remain open in aggregate limits until SQL permits the final cleaned transition, so ambiguous ownership does not prematurely release reservation.

No concrete spending-admission defect remains in this slice.

## Receipt and resource invariants

- Admission verifies the actual selected source tree before its resource-free database insertion. Same-ID replay compares the complete parsed admission.
- Effects start prepared and unresolved; command/effect identity is immutable; outcome and resolution move once. Provider exceptions or invalid receipts become durable unknown outcomes.
- Provider receipt IDs are claimed before observation. The provider/kind/ID primary key and cross-scope guard prevent adoption by another image build or customer allocation.
- Resource identity, creator effect and role remain immutable. Observed provider state must match recorded ID/kind and exact build/role ownership labels. Once absence is recorded, the resource cannot reappear in the journal.
- Builder creation requires the admitted dedicated IP, management public key, one-rule firewall and exact base image/offer. Snapshot creation requires a sanitation-bound, confirmed power-off effect and a currently observed stopped builder. This slice still relies on the future runner to authenticate and validate the sanitation response before planning power-off.
- A build cannot transition to cleaned while any effect is pending or any resource is not absent. Build/effect/resource rows cannot be deleted.

## Abort semantics and unfinished retention

`image:build cancel` is documented and implemented as an explicit full-build abort. Its cleanup includes an unpublished snapshot and can operate without provider credentials at the request step. There is no live `advance`, verified release state, current-channel promotion or successful retained-release cleanup path. Accordingly, deleting all resources during the current abort is coherent even when admission requested retention: no retained release can yet exist.

Before live advancement is exposed, add phase-specific success state and separate temporary cleanup from retained-snapshot expiry/explicit deletion. A retained release must leave snapshot ownership and reservation open until `deleteAfter`; it cannot use the current fully-cleaned terminal state. Production promotion must remain impossible until provider snapshot/source/verifier evidence and signature validation are complete.

## Validation and trail

The parent reports final check session `31120` passing 194 tests in 21 files, typecheck and strict lint after the accepted-receipt fix; formatting had passed in the preceding complete check. The image suite contains 27 tests covering admission, budget drift, aggregate races, immutable SQL rows, cross-scope ownership, unknown creates, duplicate history/cleanup for unknown and accepted receipts, exact-ID replacement attempts, builder shutdown/snapshot/all-resource teardown, and real CLI subprocess replay/inspection/cancel against PostgreSQL. Restarted CLI/API/worker smoke `47670` passed for `vm_e1ec62a2-9165-477c-befd-97f8fb223b42`. Migration/hash audit `29387` passed as described above. This reviewer did not rerun those commands and relies on the supplied results and repository trail.

Current documentation correctly calls provider behavior a protocol fixture, calls cleanup a full abort, leaves successful retained cleanup/promotion and live advancement unfinished, and states that no paid resource was created. At the instant of this audit, `PROGRESS.md` and `CONTEXT.md` still describe the earlier 193-test state and say the accepted-receipt check/final review are in progress; the parent explicitly reports that finalization is ongoing. Update those two summaries and the decision/result trail to sessions `31120` and `29387` before checkpoint handoff. No transcript directory was supplied, so do not add a transcript-audit claim.

This is not a product-completion claim. Provider image/access transport, authenticated builder management, platform verifier enrollment, signed release promotion, live Hetzner reconciliation and the bounded paid drill remain unfinished.

## Post-review documentation update

The parent updated PROGRESS and CONTEXT with the final194-test result, separate successful formatting, both matching migration hashes,11 applied migrations and the successful local CLI smoke. `m1-image-journal-verification.json` contains the exact evidence and proof limits. This closes the documentation attention item after the reviewer audit; it does not add a transcript audit or live-provider proof.

# M1 durable image-builder work review

## Scope and result

Read-only review against baseline `8eb2a46` of the builder-work contracts and table, migration 0013 (unapplied during the initial pass and applied before this final trail audit), controller, inspection and sanitation policy changes, and `tests/image-builder-work.test.ts`. I did not edit implementation, build, mutate a database, or issue VM/provider commands. No active-workspace transcript directory was supplied, so this is an artifact review rather than a transcript audit.

**Result: no remaining correctness blocker in the reviewed boundary.** The SQL shape gap from the first review is fixed. The application controller’s serialization, provider re-observation, install recovery, cancellation handling, sanitation fail-closed behavior and terminal access cleanup are coherent.

## Resolved finding

### [Fixed] SQL now enforces the strict progress and evidence shapes

The first review found that migration 0013 checked selected evidence fields but accepted extra JSON members that strict application inspection rejected. The unapplied migration now reconstructs the exact permitted `installed`, `sanitizing` and `sanitized` objects with `jsonb_build_object` and requires equality. The initial `installing` value was already exact. It separately requires a string machine ID with the bounded lowercase-hex form and reconstructs the exact nested installation and sanitation receipts from immutable admission/build identity. Extra, missing, null or wrong-typed members therefore fail before a state can satisfy the snapshot-evidence trigger. The new regression coverage exercises these bypasses. The correction was made while 0013 was still unapplied. It is now applied byte-for-byte, and all 14 migration hashes match disk, preserving migration discipline.

## Controller and recovery review

- `runImageBuilderWork` uses the same per-build advisory lock as image effects and cleanup. A second compliant controller returns busy, so it cannot overlap SSH or provider cleanup.
- Before recovering credentials or opening SSH, it requires exactly one confirmed builder receipt, exact recorded work identity if present, a currently observed assigned persistent IP and a current server that still matches effect-bound labels, admitted shape, IP and firewall. Provider absence or drift is observed into the journal and stops progress.
- The first work row is inserted as `installing` before upload/install I/O. A process loss before or during installation therefore resumes by remote inspection. `not_started` permits upload and one install attempt; `started` waits; a durable matching installed receipt advances without uploading or installing again. Retryable SSH loss remains waiting and never proves the remote process stopped.
- The controller rechecks active state, expiry and pending effects before each fresh mutation. Expiry requests cleanup. Cancellation during key recovery or upload prevents the next SSH mutation. If installation finishes while cancellation arrives, the immutable installation evidence may still be recorded, then the next call returns cleanup. Cleanup retains priority.
- Sanitation intent is persisted before SSH. Any thrown or lost sanitation result requests failed cleanup, and a restarted `sanitizing` row never calls sanitation again. This is the correct asymmetric boundary because sanitation erases access: uncertainty cannot authorize shutdown or snapshot publication.
- A valid sanitation result may be recorded after cancellation during that SSH call, while the build remains open for cleanup. The subsequent stop/snapshot policy and SQL trigger require the same persisted sanitation receipt and exact builder server. A confirmed power-off with that receipt is required before snapshot intent.

## Migration semantics

Migration 0013 preserves the important invariants:

- Work identity is a one-row-per-build primary key bound by a composite foreign key to the exact create effect. Insert requires the confirmed observed builder server and an exact initial `installing` value.
- Build, effect and server identity plus creation time are immutable; rows cannot be deleted; progress moves only `installing → installed → sanitizing → sanitized`; installation evidence cannot change after first recording.
- Fresh `installing`/`sanitizing` transitions require a running, unexpired build with no pending effects. Evidence completion can still be recorded after cancellation, but a cleaned build rejects updates.
- Installation binds builder ID and manifest digest to immutable admission and bounds the machine ID. Sanitation binds builder and manifest. Stop/snapshot inserts require the persisted sanitized work/server; snapshot additionally requires a confirmed matching shutdown effect.

## Planner, controller and terminal cleanup

- `planImageRelease` is pure over one inspected SQL snapshot and chooses one dependency-ordered effect: access key, firewall, persistent IP, builder, builder SSH work, receipt-bound power-off, snapshot, then an explicit verification barrier. Existing pending effects are reconciled before new work. Missing/failed evidence routes to full cleanup rather than substituting resources or skipping phases.
- The outer `advanceImageBuild` plan can become stale, but every mutating executor reacquires the per-build lock and revalidates state, expiry, command policy, ownership and pending effects. Cleanup first records cleaning intent, then uses the locked cleanup planner. A stale provider plan cannot bypass cancellation or create a second role resource.
- The controller never advances past `verification_required`; verifier lifecycle and promotion remain absent. Repeated calls at that barrier produce no provider/SSH mutation.
- Terminal key removal happens only after `planImageCleanup` has authoritatively observed all provider resources absent and committed the build as cleaned. If filesystem removal fails or the process exits after SQL cleanup, the next `cleaned` pass retries removal without recreating or deleting provider resources. Unknown creates keep the build in cleaning/waiting and retain access plus budget reservation.
- `ImageAccessStore.remove` binds build, manifest, full admitted access metadata and deterministic retiring name, atomically renames before unlinking, refuses unexpected contents, fsyncs the parent, and tolerates concurrent/restarted removal. It does not erase access merely because cancellation was requested. Future retained-release cleanup may remove obsolete builder keys once builder and temporary access resources are absent while separately retaining the sanitized snapshot.

## Final evidence and trail audit

The final artifact `docs/research/m1-image-builder-work-verification.json` is internally consistent with the repository trail:

- Full session `85297` passed 288 tests in 26 files with typecheck and lint. Targeted session `38406` passed 94 tests across four files. Formatting `14512` passed after the documented second Prettier pass. I did not rerun these checks.
- Native controller session `6670` passed the implemented flow using a protocol provider with an owned local Ubuntu 24.04 builder: committed provider effects, real cloud-init and pinned SSH/SFTP, tamper/identity/expiry refusals, persisted install intent, deliberately lost install response recovered through a fresh database connection without repeat upload/install, persisted sanitation intent/receipt, real source shutdown, protocol snapshot creation, two actual local clone boots, and full-abort provider/key cleanup.
- The two clones are real local VM boots through the existing customer enrollment/runtime smoke. They prove that the controller-built sanitized filesystem can boot twice with distinct machine, SSH, TLS and allocation identities and pass runtime/reboot checks. They do **not** implement or prove the future platform-owned verifier lifecycle, provider snapshot boot identity, signed promotion or retained release. The artifact and architecture state this distinction explicitly.
- Builder scan (64 files, 94,289 bytes) and both clone scans (125 files each) found no bounded key/token matches. These are residual-secret checks rather than forensic erasure. Cleanup checks `d10d87` and `bf26c2` at 06:07:53Z record an empty local VM inventory, absent smoke ownership records and empty private builder-access directory. No paid cloud resource was created.
- Migration 0013 is now applied. Session `f60973` reports all 14 applied migration hashes matching disk after the owned services were stopped. Restarted CLI/API/worker smoke `68795` passed, and SQL cleanup check `45f8f1` reports zero active allocations, simulated servers and simulated Primary IPs.

The `image-builder-controller`, `image-builder-schema` and `image-builder-native` decision rows accurately preserve chronology: the full check preceded the active native run; the SQL-shape and restartable-removal fix preceded applying 0013; and the final native row records successful recovery, clone proof and cleanup. `docs/CONTEXT.md`, `docs/PROGRESS.md` and `docs/architecture/image-release.md` make no provider-snapshot or platform-verifier claim. They correctly leave live advancement, platform verifier enrollment, retained cleanup, signing/promotion and production activation unfinished. Final review is complete; GitHub CI remains pending until the parent commits and pushes this checkpoint.

No active-workspace transcript directory was supplied, so this remains an artifact and decision-trail audit. No implementation or product-completion claim extends beyond the boundaries above.

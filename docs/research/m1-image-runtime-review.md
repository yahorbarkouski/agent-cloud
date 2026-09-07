# M1 production image runtime review

Reviewed by: `gpt-5.6-sol`

Scope: read-only review of the uncommitted image-factory runtime wiring and its current artifact trail. No active-workspace transcript directory was supplied, so this is not a transcript audit. I did not edit implementation code, run tests, mutate the database, operate a VM, or call the provider.

## Findings

### Resolved — expiry and effect authorization use database time

The earlier P1 is fixed. `apps/control/src/image-runtime.ts` now reads database time before deciding whether a running build or retained publication has expired. `advance-image-build.ts`, `image-builder-work.ts`, the renderer, verifier bootstrap and enrollment, and `image-effect-journal.ts` now use database time at their deadline boundaries. Production passes an explicit database-derived instant into the pure command policy.

The associated decision row accurately records the discovered destructive-cleanup risk and database-time correction. The subsequent row accurately explains that three old tests had mocked only `Date.now()`, and that their repaired versions use short real admissions plus a database-clock wait helper. A later full-run queue failure was also fixed at its source: immediately due Graphile work now uses PostgreSQL `clock_timestamp()` instead of a Node timestamp that can be a few milliseconds in the database's future.

### Resolved — probe credential caches use database time

The follow-up P2 is fixed in both verifier enrollment and runtime checking. Each cache now reads database time at the validity check before deciding whether to reuse a probe credential. The two new regressions move the host clock forward by ten minutes between a failed probe and its retry and verify that enrollment and runtime each reuse the valid credential without another signing attempt.

### Documented limitation — PKI trust and signer credentials are cached until process restart

`apps/control/src/image-runtime.ts:59-72` caches the result of `readRuntimeIdentity` and `readRuntimeSigner` in `ports`. Release authorization correctly reloads `release-policy.json` on every authorization, including retained-image selection, so release-key revocation fails closed without restart. The TLS root, SSH CAs, provisioner password, bootstrap sealing key, and release private key remain the initially loaded values for the process lifetime.

This is safe against silently accepting a changed file because admitted manifest trust is compared with the cached signer trust, and `docs/architecture/operator-runtime.md` now explicitly requires restarting both processes after PKI, provisioner credential, bootstrap key, or release private-key changes. A missing or invalid release policy is retryable and has no cached-trust fallback, which is the correct failure behavior.

## Confirmed boundaries

- Hetzner API mode passes `customerAccess: 'disabled'`; the `/v1/*` middleware rejects customer authentication and admission before any customer route executes. `/image/enroll` remains available for the authenticated verifier protocol. The runtime does not wire customer allocation tasks.
- Constructing the runtime reads credentials and builds transport objects but does not submit provider mutations. API startup performs catalog refresh, and worker startup polls durable image tasks; neither admission nor startup itself creates a paid resource. A build must already be admitted and have durable `runRequestedAt` before controller progress can reach a create.
- Provider and PKI secrets are read from no-follow, bounded files with ownership and mode checks. They remain in process memory and are passed to transport/signer objects; the reviewed wiring does not persist them in image admission, journals, tasks, or rendered boot metadata.
- Cleanup of an expired, cancelled, or already-cleaning build bypasses runtime identity, signing keys, sealing key, CA material, price service, and source inputs. Exact-ID provider observation/deletion still requires the provider credential, as it must; the standalone `image:build cleanup` command constructs a delete-only renderer that cannot create a server.
- Release trust is re-read for publication verification and retained selection. Unavailable or invalid policy fails closed as retryable `provider_unavailable`; an explicitly unauthorized active signing key causes cleanup rather than publication.
- Create effects still pass through current catalog and snapshot-price reads, admitted budget checks, global image limits, the per-build lock, and the database journal before provider submission. Delete-only recovery cannot acquire create capability because `runImageEffect` requires pricing and limits for a create command and rejects their absence.
- The temporary public readiness check proves only route exposure and gating: `/healthz` returned 200, customer `/v1/projects` returned 403, malformed `/image/enroll` returned 400, and unavailable `/guest/enroll` returned 404. It did not enroll a verifier, admit an image build, submit a provider mutation, or create a paid resource.

## Final verification and trail audit

`docs/research/m1-image-runtime-verification.json` records a successful final `pnpm check`: 351 tests in 33 files, typecheck, lint, and process exit 0 (`6bfd3e`). `.local/runtime-check-verified.log` contains the matching successful summary, and the full formatter passed. Native enrollment session `23398`, explicitly observed at exit 0 in `159ac1`, exercised real Smallstep and pinned OpenSSH with local simulated provider observations and local activation hooks. This is native enrollment evidence, not a live image-factory enrollment or cloud boot.

The fresh Hetzner read-only artifact reports current catalog and storage data, the expected Ubuntu 24.04 x86 base image, and zero servers, Primary IPs, snapshots, firewalls, or SSH keys. Prepared build `bbb28cd4-aca1-4a94-87cf-364728bf6771` contains local inputs and keys only; it was neither admitted nor started. The no-paid-resource statement is supported.

The latest runtime decision rows accurately preserve the clock and queue failures, their fixes, final local/native validation, public route restrictions, and zero-resource state. One trail correction remains before checkpoint commit: `docs/CONTEXT.md` still says full check `66763` awaits exit and formatting remains, while `docs/PROGRESS.md` still leaves final checks and native enrollment unchecked. Those statements should record the final `351/33`, formatter, `6bfd3e`, and `159ac1` evidence while leaving exact-commit CI and the bounded live drill open.

No reviewed implementation blocker remains. An implementation commit and exact-commit CI are pending. No paid provider mutation or live image build was part of this checkpoint. Production customer operation admission remains intentionally gated. Successful Hetzner builder boot, authenticated first SSH/SFTP, sanitation, snapshot, verifier enrollment/runtime, retained publication, cleanup, customer release wiring, renewal, backups, and broader product deployment remain outside this proof.

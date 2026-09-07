# M1 allocation image use and scheduling review

Reviewed by: `gpt-5.6-sol`

Review scope: read-only artifact and decision-trail review of the allocation image pin and durable image scheduling checkpoint. No active-workspace transcript directory was supplied, so this report does not claim a transcript audit. I did not run tests, mutate the database, operate VMs, or call a provider.

## Result

I found no blocking correctness issue in the reviewed checkpoint.

The implementation now keeps image selection bound to the allocation throughout the sensitive lifecycle. Admission verifies the signed release against database time, checks architecture, minimum disk size, cancellation, local retained-publication metadata, tenant pin metadata, and the required retention window, then persists the tenant-owned pin in the admission transaction. Provider ownership is observed later by the worker and renderer. Operation advancement resolves the original pin before any fresh IP or VM create and supplies the same selection to rendering. A change in the default release therefore cannot silently substitute another image after admission.

Pin blocking is conservative at the provider uncertainty boundary. Pins are immutable historical rows. A pin continues to block snapshot deletion while a guest create is prepared, running, or has an unknown outcome. It ceases blocking after a confirmed correctly owned guest create, or after retirement when there is no pending create and no live owned resource. The SQL guards reinforce this behavior by preventing pin-row deletion, a second guest create, bootstrap substitution, and deletion of a snapshot blocked by a pin. These checks make the database the final invariant boundary rather than relying only on controller ordering.

Scheduling also has a durable start boundary. Admission schedules deadline handling without implicitly authorizing resource creation; an explicit start records `runRequestedAt` before capacity work can be queued. Cancellation queues prompt reconciliation, and ordinary reconciliation derives the next task while holding the source image build row lock. Builder access cleanup is represented by the durable `accessRemovedAt` marker, so a filesystem-cleanup failure remains retryable even after SQL cleanup has advanced.

The follow-up error and clock fixes close the material issues found during review. Signed-release validation at the control boundary becomes a typed, nonretryable `permission_denied` failure, allowing post-admission revocation to enter compensation rather than retry forever. A retryable `provider_unavailable`, including a held image-build lock, leaves allocation progress available for another tick instead of beginning terminal failure. Signing, immediate verification, selection checks around provider I/O, and admission now use database time. That removes both host-ahead and database-ahead disagreement while preserving the strict SQL deadline guards.

## Verification and trail audit

The evidence in `docs/research/m1-image-use-verification.json` is consistent with the current documentation and decision rows:

- Full session `79451` reports passing typecheck and lint, plus 339 passing tests across 31 files.
- Final session `32612` reports passing typecheck and lint plus four queue tests after adding actual CLI start invocation and `db:check` to the validation path. The separate migration session `986c26` supplies the actual `db:check` runtime and hash proof.
- Native enrollment session `97118` exercised real Smallstep and OpenSSH enrollment, while provider observations remained simulated.
- Local CLI session `91748` exercised the simulated create, inspect, destroy, and cleanup path.
- Migration session `986c26` reports 17 applied migrations with matching hashes, including migration 0016 at `569599f36dc2807f8c52acda47b867805a7bb8bcfaeeb09a524afd0146e8e048`.
- Cleanup evidence `f2b982` reports zero active allocations, simulated VMs, simulated IPs, and open image builds.

The latest `docs/DECISIONS.tsv` rows accurately describe pin retention across uncertain creates, explicit scheduling authorization, typed trust and transient errors, the database-clock correction, and the final local verification. `docs/CONTEXT.md` and `docs/PROGRESS.md` accurately keep the overall goal active and describe this checkpoint as uncommitted with exact-implementation CI pending. I found no unsupported completion or deployment claim in the reviewed artifacts.

Migration 0016 has been applied to the base database and its recorded hash matches the current file. It should consequently remain immutable; any later SQL correction needs a follow-up migration.

## Remaining limits and attention flags

- The implementation commit and exact-head Linux CI were still pending in the reviewed evidence. Local results support the checkpoint, but the trail must not claim committed or CI-verified status until those identifiers are recorded.
- Production API and worker entry points remain gated. The optional resolver used by native and protocol fixtures is acceptable for those tests, but production admission must require trusted release configuration and must not fall back to an unpublished fixture image.
- Provider behavior in this checkpoint is covered through protocol fixtures rather than paid Hetzner creates, boots, snapshot retention, and deletion. Native enrollment proves the guest identity path locally; it does not prove initial boot or retained-image behavior on the production provider.
- Retention scheduling is exercised through task and state transitions, not a real multiday expiration run. An unknown create can deliberately retain its pin and associated snapshot capacity until observation or operator recovery resolves it; that is the safe behavior but remains an operational recovery obligation.
- Production worker operation, signing configuration, reachable enrollment, certificate renewal and recovery, allocation consumption over the retained image lifetime, and a bounded live-provider drill remain unfinished. The checkpoint should not be presented as full product completion.

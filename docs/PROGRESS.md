# Implementation progress

## Architecture workflow

- [x] Ground: greenfield repository; researched plan available; parent projects are unrelated.
- [x] Sketch: bounded alternatives for durable lifecycle and persistence.
  - [x] Frame: compare recoverable effects, testability, TypeScript contracts, and implementation size.
  - [x] Fan out
  - [x] Cross-judge
  - [x] Pick
  - [x] Graft
  - [x] Verify
- [x] Agree: user authorized autonomous implementation; no design approval checkpoint required.
- [ ] Implement: fill the chosen contracts with real behavior and tests.
- [ ] Scrap audit: revisit boundaries if implementation needs repeated exceptions.

## Product milestones

- [x] M0: repository, contracts, local services, authenticated API, operation model, simulated provider.
- [ ] M1: durable machine lifecycle, Hetzner adapter, first-boot image, cleanup and reconciliation.
- [ ] M2: CLI and customer access, grants, device login, SSH access and revocation.
- [ ] M3: file transfer, persistent command runs, Compose deployments, HTTPS routes and domains.
- [ ] M4: PostgreSQL/analytics recipes, protected backups, isolated restore, platform recovery.
- [ ] M5: resource limits, usage, audit, alerts, local account funding policy. Stripe deferred.
- [ ] M6: self-hosting, maintained skills/docs, realistic end-to-end validation.
- [ ] M7: availability and failure drills appropriate to the user's low infrastructure budget.

## Verification ledger

2026-09-06 local checkpoint:

- TypeScript build and tooling/test typecheck pass. Strict typed ESLint passes.
- 19 PostgreSQL integration tests pass in two suites. They verify admission races, account isolation, provider uncertainty, worker contention, cleanup, delegation bounds, expiry, and revocation. A subprocess crash exercises the real provider-commit/journal boundary; database guards reject attempt-history rewrites.
- The CLI → HTTP API → PostgreSQL → Graphile worker smoke test passed, including creation, readiness inspection, deletion, and cleanup. Provider state and guest readiness are **simulated**.
- All smoke allocations were cleaned up; the development account reported zero active reservations afterward.
- Independent `gpt-5.6-sol` review and follow-up found no material regression after the journal guard fix; see `docs/research/m0-review.md`.
- Initial migrations applied locally. Database/queue state persists across processes.
- Private repository `yahorbarkouski/agent-cloud` contains implementation commit `bbd33ad` on `main`. [CI run 34056857441](https://github.com/yahorbarkouski/agent-cloud/actions/runs/34056857441) passed frozen installation, full checks, and formatting on Linux.
- Hetzner project `agent-cloud-development` (`15945891`) and its read/write token `agent-cloud-local-development` were created. The token was saved through a one-use loopback form to ignored `.local/hcloud-token` with mode 0600, without printing it. Authenticated read-only API checks succeeded and reported zero servers and zero Primary IPs. No cloud resources have been rented.
- The account's live catalog uses USD and 23% VAT. CX23/CX33/CX43 reported unavailable in fsn1/nbg1/hel1 at inspection. M1 must replace EUR-only estimates with account-currency pricing and current availability; do not silently choose an expensive substitute.

M1 is in progress. A Hetzner HTTP transport exists, but live admission/worker activation is disabled. Before enabling it: verify account prices and availability; enforce reservation ceilings including ancillary charges; track Primary IP cleanup; verify the guest template; distinguish allocation from guest readiness; implement authoritative resolution of uncertain and duplicate resources.

M2 has a JSON CLI, local token login, scoped grants through API/SDK, and revocation. Browser/device login, SSH certificates, gateway access, and CLI grant management remain.

M3–M7 remain implementation work. Current passing tests do not establish real VM boot, SSH identity, routing, Compose deployment, database restore, or production availability.

M1 pricing and credential checkpoint, 2026-09-06:

- Account, grant, deployment, and allocation limits now use explicit currencies and integer micro-units. Migration 0002 preserved the local M0 account and its credentials. The CLI smoke passed after migration and restart, including cleanup.
- Create/resize operations persist an exact admitted offer. Fresh effects recheck availability, price, architecture, and current deployment/account/grant limits. Accepted creates must return the recorded type, region, and ownership; mismatches block with slower reconciliation. Submitted effects reconcile without depending on the current catalog.
- Hetzner catalog pagination, gross account prices, IPv4 charges, and explicit type selection are implemented. `PROVIDER_CURRENCY=USD HCLOUD_SERVER_TYPE_SMALL=cpx12 pnpm hetzner:check` succeeded against the account. At 20:40 UTC CPX12 was available in the three selected regions at USD 0.027798/hour including IPv4 and VAT. Project counts remained zero servers and zero Primary IPs.
- The one-use credential intake now rejects a second in-flight submission after the first consumes the form. Tests use fake credentials and temporary directories, including a real overlapping HTTP request, wrong Origin/Host, body bounds, mode 0600, and overwrite refusal.
- 41 tests in six files pass, as do typecheck, strict lint, formatting, and customer-skill validation. Legacy upgrade tests migrate queued and interrupted M0 creates, preserve authentication and original aggregate estimates, and finish with one provider attempt and one server. The focused review fixes are implemented. Migrations 0003–0004 applied locally; the restarted API/worker passed the real CLI smoke with cleanup. The report is `docs/research/m1-pricing-review.md`. Migrated create recovery is covered; the separate legacy resize migration branch has not been regression-tested.

Live creates are still disabled. Primary IP ownership/cleanup, guest bootstrap/readiness, catalog refresh in the running API, traffic/other ancillary limits, and operator resolution remain M1 work.

Review-driven changes in this checkpoint:

- Migration 0003 removes implicit currency defaults and enforces account/allocation currency agreement in PostgreSQL. The generator put its foreign key before the referenced unique constraint; isolated tests caught error 42830. The unapplied migration was reordered, and all tests passed afterward.
- Migration 0004 marks reconstructed historical price components `legacy_estimate`. Original aggregate estimates stay unchanged. New simulated and live account prices have explicit provenance.
- VM/IP prices now come from the same account-pricing response as their currency. The current credential-free live artifact is `docs/research/hetzner-catalog-check-2026-09-06.json`, captured at 20:56:14 UTC and validated against the current catalog schema. Counts remained zero.
- The credential intake requires a real owner-only `.local` directory and rejects symlinks before starting a listener.

Pricing checkpoint `df11926d54d23cee06f21f9705c83fdb3cba5345` is pushed on `yahor/agent-cloud`. [GitHub CI run 34059794570](https://github.com/yahorbarkouski/agent-cloud/actions/runs/34059794570) passed on Linux, including frozen installation, checks, and formatting. `docs/architecture/provider-resources.md` records the next implementation slice. It has not enabled live provisioning.

M1 provider-resource checkpoint, 2026-09-06:

- New allocations create a labelled IPv4 Primary IP before their VM. Both resources have account/allocation ownership records and share the immutable effect journal. Submission receipts identify resource kind and ID; resolutions are recorded once. The full VM/IP reservation remains until both are confirmed absent.
- Revocation or a definitive VM rejection can trigger cleanup of an unused IP. Unknown VM submission keeps the IP and reservation for reconciliation. IP deletion continues after confirmed server deletion, including when provider auto-delete leaves an unassigned IP behind. Ownership, assignment, and identity mismatches block destructive work.
- Post-submission exceptions now reload attempt history before any compensation decision. The provider receipt persists even if its ownership claim conflicts. Current Hetzner assignment parsing rejects both contradictory type/ID combinations. These cases have focused regression coverage.
- The persistent simulator models independent IP effects and can retain IPs after server deletion. Transport fixtures verify explicit IP attachment without automatic IPv6, bodyless 204 deletion, inventory pagination, resource-specific absence, and uncertain responses.
- `pnpm check` passes 67 tests in eight files, build/typecheck, and strict lint. The previous legacy resize coverage gap is closed. The migration matrix covers queued/prepared/accepted/completed creates and resizes from the M0 schema, including old receipt/progress shapes and known-server ownership backfill.
- Migration 0005 applied to the local development DB with API/worker stopped. Restarted services passed `pnpm smoke:local` for `vm_3605fdec-d4f6-4fce-b77c-f53fb4173928`. A read-only database check confirmed its retired reservation and zero remaining live owned resources, simulator VMs, or simulator IPs. The updated customer skill passed validation.
- The bounded review report is `docs/research/m1-resources-review.md`. Its reviewer independently passed 28 resource/transport/migration tests. No cloud mutation was used, and live guest boot/SSH behavior remains unverified.

M1 still needs guest bootstrap and host identity, runtime API catalog refresh, operator resolution of blocked effects, and a bounded live cleanup drill. No paid resource has been created. M2–M7 remain open.

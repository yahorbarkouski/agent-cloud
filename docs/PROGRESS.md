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

Resource checkpoint `8f416ba194bab4b31229426873d4a91e1e2c253e` is committed and pushed. [Linux CI run 34061962745](https://github.com/yahorbarkouski/agent-cloud/actions/runs/34061962745) passed frozen install, full checks, and formatting. Local formatting and customer-skill validation passed. The configured `gpt-5.6-sol` audit verified the four resource decision rows and reran the two safety regressions; it found no additional issue.

## Guest bootstrap implementation workflow

- [x] Ground: traced admission, effect preparation, provider template, and completion boundaries in `research/guest-grounding.md`.
- [x] Sketch: compared three isolated designs and cross-judged them. Selected A with the explicit secret-reference and provider-IP SSH proof in `architecture/guest-bootstrap.md`; implementation verification remains open.
- [x] Agree: autonomous implementation is already authorized; no approval checkpoint requested.
- [ ] Implement: guest identity, bootstrap artifacts, readiness verification, runtime catalog and operator recovery.
- [ ] Scrap audit: revisit the design if implementation needs repeated exceptions.

M1 guest bootstrap and local identity checkpoint, 2026-09-07:

- The API refreshes complete provider catalogs outside transactions, coalesces requests, aborts on shutdown, rejects expired admission offers, and withdraws snapshots on currency disagreement. The private credential reader validates the opened no-follow file descriptor.
- Migration 0006 adds allocation-owned encrypted bootstrap records and one-way claimed/issued guest identities. Metadata, key claims and issued certificates are immutable. Invalid issuance data cannot erase the encrypted token. Concurrent preparation, tampering, cross-account changes, expiry and token consumption have PostgreSQL coverage.
- Pinned Smallstep CLI 0.30.6 and step-ca 0.30.2 run locally. Setup preserves the root identity and keeps its encrypted private root outside the CA container mount. The signer uses private temporary provisioner files, native tools and bounded subprocesses. SSH guest keys are Ed25519; TLS leaves use ECDSA P-256. Certificates are checked against exact keys, names, CA trust, permissions and expiry.
- Internal probe credentials are issued explicitly and reused by read-only OpenSSH calls. The SSH certificate itself forces the identity command, with no forwarding/PTY extensions. The client ignores user SSH configuration and agents.
- `pnpm check` passed 78 tests in 12 files, typecheck/build and strict lint. `pnpm smoke:pki` passed actual TLS issuance/connection and negative name, SAN, curve, returned-key and validity checks. `pnpm smoke:ssh` passed real raw-key and host-CA connections, wrong-key/CA/allocation rejection, and mismatched guest evidence. The independent gpt-5.6-sol reviewer reran both smokes and the focused inspector test. Report: `docs/research/m1-bootstrap-review.md`.
- The SSH fixture copies bind-mounted trust into root-owned container files before startup so native Linux runner ownership does not violate OpenSSH StrictModes. Its updated smoke passed; temporary fixture containers and key directories were removed. CI now includes pinned tooling setup and both real local smokes. Remote CI verification is pending this commit.
- Migration 0006 applied to the development DB after stopping owned services. Restarted API/worker passed `pnpm smoke:local` for `vm_a07cf525-ab4d-40f8-a4d0-a7de55ef49a0`. A read-only DB check returned zero active allocations, zero simulator VMs and zero simulator IPs. Customer-skill validation passed.

This checkpoint does not complete M1. Bootstrap preparation, signing and SSH proof are not yet connected through an enrollment endpoint or VM create command. Image build/sanitation, provider reference rendering, readiness/renewal, bounded persisted probe issuance, snapshot cleanup and operator resolution remain. Preserve old provider-command forms during that integration. No paid cloud resource was created.

Guest identity checkpoint `d70d80f68eae9ba69482e3824b462214f3077967` is committed and pushed. [Linux CI run 34064759704](https://github.com/yahorbarkouski/agent-cloud/actions/runs/34064759704) passed frozen installation, 78-test full check, formatting, fresh pinned Smallstep installation and CA setup, real TLS/OpenSSH smokes, and cleanup. Local final formatting and customer-skill validation passed.

M1 enrollment and provider bootstrap integration, 2026-09-07:

- `/guest/enroll` authenticates an immutable allocation token and requires a confirmed create phase, complete authoritative ownership labels, provider-assigned IPv4 and direct pinned-key SSH proof. Invalid TLS CSRs fail before key claims or signing. Certificate persistence, token erasure and runtime handoff commit together; same-key replay returns the first certificates without new signing.
- Migration 0007 retains bounded signing history across crashes and process restarts. Probe credentials are cached during read retries. The hard SQL budgets are 12 probe issuances and 4 identity attempts. The 30-second application cooldown still assumes synchronized database/control host clocks.
- New `create_guest` commands carry only a bootstrap reference. The renderer verifies the prepared attempt and admitted allocation, recovers the pinned image/token and constructs bounded cloud-init data only for initial submission. Old `create` commands remain reconcilable; fresh legacy live creates are rejected. Unknown creates never rerender or resubmit. A definitive rejection can clean up its unused IP.
- Review fixed enrollment during blocked creates, incomplete stored-label comparisons, mutable signer trust and a missing atomic runtime handoff. Report `research/m1-enrollment-review.md`; independent focused suite passed 9 tests. Provider-reference review found no high-confidence blocker; report `research/m1-provisioning-review.md`.
- `pnpm smoke:enrollment` passed the composed HTTP/PostgreSQL/Smallstep/OpenSSH path. A guest initially without a host certificate proved its raw host key, enrolled, installed the returned host certificate and connected using CA trust. The returned TLS certificate passed a real HTTPS connection. Wrong host keys failed before key claims; replay did not add enrollment signing attempts. Provider observations were local fixtures. The owned SSH container, keys and isolated database were removed.
- A shared disposable SSH fixture now owns cleanup for both native smokes. CI includes composed enrollment alongside the existing native PKI and SSH checks. Full check passes 94 tests in 14 files, typecheck/build and strict lint. All three native smokes pass. Migration 0007 applied to the development database with owned services stopped, and restarted CLI/API/worker smoke passed for `vm_c89019a1-3aab-43dc-b0d5-fcfc18b3b197`. SQL confirmed zero active allocations, simulated VMs and simulated IPs. Remote CI remains pending the commit.

No paid cloud resource has been created. Startup gates stay closed. Guestctl/image boot and sanitation, runtime readiness, renewal, operator recovery and the bounded live drill remain M1 work; M2–M7 are still open.

The final configured gpt-5.6-sol trail check verified the four new decision rows and independently passed 21 focused enrollment/provisioning/transport tests plus the composed native enrollment smoke. The report corrects the precise renderer validation order. Formatting and customer-skill validation pass. No transcript directory was supplied, so this is an artifact/trail audit.

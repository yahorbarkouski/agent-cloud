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

## Image publication implementation workflow

- [x] Ground: trace full public input binding and the operator/customer ownership boundary in `research/image-release-grounding.md`.
- [x] Sketch: compare bounded operator release designs, then select types and modules.
  - [x] Frame: full input provenance, explicit ownership, unknown outcomes, gross budget/deadline, cleanup, and short call chains.
  - [x] Fan out
  - [x] Cross-judge
  - [x] Pick
  - [x] Graft
  - [x] Verify: provenance/transfer/crypto contracts passed focused and native checks; provider publication remains open.
- [x] Agree: autonomous implementation remains authorized.
- [ ] Implement: public input provenance, snapshot publication/reconciliation/cleanup, release consumption and bounded provider proof.
- [ ] Scrap audit: revisit the chosen shape only if implementation shows repeated friction.

## Verification ledger

M1 full image input provenance and authenticated release, 2026-09-07:

- Added format 2 manifests and the `packages/images` package. Image identity now includes the installer, service and SSH/sudo configuration, guest bundle, pinned artifacts, canonical artifact metadata and public trust. Sorted inventories exclude their derived metadata to avoid self-referential hashes. Complete-tree validation rejects omissions, extras, unsafe paths, symlinks and changed bytes.
- Builds publish read-only directories named by manifest digest and update a separate current-build pointer atomically. Consumers capture one selection; clone checks inherit the parent digest. Rebuilding identical inputs returned the same digest. A macOS EACCES result when renaming over a read-only existing directory now resolves only by verifying that exact existing tree.
- Review identified an upload trust-order flaw. The corrected entry point uses controller-owned shell and base OS checksums against an independently captured transfer digest before any uploaded code executes. Actual shell tests reject a fully substituted installer/runtime/manifest/checksum tree and unlisted package files. The staged guestctl verifier remains a second consistency check.
- Ed25519 release validation binds complete input metadata, sanitation source server, distinct verifier and event ordering. It checks key validity, additive rotation, revocation, retention and tampering, then derives GuestImage. These are authenticated recorded assertions; the operator journal must still prove current snapshot ownership, availability and actual boot source before promotion.
- Final full check session 44164 passed 167 tests in 20 files, typecheck and strict lint. The composed native enrollment smoke also passed with actual guest library, Smallstep and OpenSSH/TLS; its provider observations and activation hooks remain fixtures. Formatting, shell syntax and customer-skill validation passed.
- Native image drill 59921 passed trusted preflight, actual installation, sanitation/refusal/recovery and two complete clone enrollment/runtime/reboot checks. Each 125-file token scan had zero matches. Final VM inventory was empty and all ownership records were absent. Exact public evidence is in `research/m1-image-provenance-verification.json`. The same manifest and transfer digest survived repeated builds, including the final reuse-permission correction.
- Review is in `research/m1-image-provenance-review.md`. Cryptographic release verification is complete for this boundary; operator journal, provider proof, budgets, cleanup and promotion remain unfinished. No paid resource has been created. Implementation `b891c716bc2ff88811ae7bcff778897c15673613` is committed and pushed. [Linux CI 34078153918](https://github.com/yahorbarkouski/agent-cloud/actions/runs/34078153918) passed in 2m6s, including frozen install, the full check, formatting, fresh PKI setup, all three native smokes and cleanup.

M1 image sanitation and cloned identity, 2026-09-07:

- Added root-only `guestctl prepare-image --json` with a private record bound to the externally owned builder, its original machine ID and installed manifest. Installation checks managed paths and accounts before package mutation. Enrollment refuses an unsanitized image before generating keys. The installed wrapper serializes preparation and enrollment.
- Preparation refuses allocation data, unexpected homes, unsafe state directories and Docker workloads, images, volumes, cache, custom networks or swarm state. It never starts Docker for inspection. A durable `preparing` record supports retry on the original machine; a fresh clone cannot resume it. If Docker restarted during recovery, preparation inspects its data again.
- Cleanup removes Docker/containerd state, cloud-init caches, machine ID, system SSH host keys and explicit builder homes. Builder access is removed last. Temporary volatile journald configuration and stopped rsyslog prevent later service operations from recreating persistent builder logs. Incomplete final access removal requires out-of-band recovery or disposal of the recorded builder.
- Fresh native run16252 passed two cloned enrollments with different allocation IDs, Linux machine IDs, SSH keys and TLS public keys. Both clones passed restricted SSH/runtime checks, service/disk failures and recovery, token erasure and reboot. All owned VMs were deleted. This preceded the final installer/logging/retry review fixes.
- Native10176 passed installer-before-apt refusals and a deliberate interruption after the durable preparing write and machine-ID reset. Its subsequent test restart hit systemd's Docker start limit. The fixture now resets its start counters. Diagnostic43606 then proved new-volume refusal, safe resume, sanitized replay and empty persistent logs after logger/sync. The failed-run builder was deleted. Native52823 then passed recovery/log and refusal-clone checks but was invalidated when an operator diagnostic restarted its stopped source. No positive clone was created; the builder and unused child intent were removed. AGENTS now forbids concurrent VM diagnostics. Fresh73319 then passed every current refusal/retry/log check and two complete clones. Each125-file token scan had zero matches. A final local inventory was empty and all three ownership records were absent. Exact public identities and proof limits are in `research/m1-image-sanitation-verification.json`.
- Full check42939 passed121tests/18files, typecheck/lint and formatting. Native enrollment9311 passed the real guest library, Smallstep and OpenSSH/TLS with fixture activation. Shell syntax, customer-skill validation and actual installer UUID boundary checks passed. The different-model artifact/trail review is `research/m1-image-sanitation-review.md`; no remaining code blocker was found within the exclusive fresh-builder scope.

Sanitation implementation `4653f791846a840e8d37df9beb16833e775a2f69` is committed and pushed. [Linux CI34075101498](https://github.com/yahorbarkouski/agent-cloud/actions/runs/34075101498) passed frozen installation,121-test full check, formatting, fresh PKI setup, all three native smokes and cleanup in2m12s.

Local clones first boot to stage NoCloud data, then restart into enrollment. This does not prove Hetzner allocation data at initial power-on. Provider snapshots, production worker activation, renewal and operator recovery remain M1 work. No paid cloud resource has been created; M2–M7 are still open.

M1 runtime readiness checkpoint, 2026-09-07:

- Added `guestctl inspect --json` and a separate runtime certificate that forces exactly its sudo command. The probe user has no general sudo, Docker group membership or interactive certificate extensions. Inspection reports pinned component versions, daemon access, disk headroom, allocation-specific proxy health and Linux boot ID.
- The controller rechecks provider VM/IP ownership, persisted image and keys before reading runtime evidence. Migration 0008 stores immutable per-operation signing attempts, with a 12-attempt ceiling. Credentials are cached for reuse and a database-backed cooldown survives worker restarts.
- Create, reboot and power-on require fresh runtime evidence. Reboot/power-on wait for a new Linux boot ID. A 30-minute deadline starts at admission; fresh effects check it before submission, and completion checks database time again inside its transaction after SSH returns. Existing unknown effects remain reconcilable. Expiry preserves owned resources or cleans a definitively unused IP.
- The different-model review found the deadline race; the fix has a regression that expires the operation during its SSH read. Queued-expiry tests cover both an empty allocation and an already-owned IP. Concurrent completion, unavailable components, ownership changes, identity mismatch, signing limits/restarts and reboot/power-on tests pass.
- `pnpm check` passed 121 tests in 18 files, TypeScript checks and strict lint in session29425. Native PKI runtime policy passed in71057; existing SSH and enrollment smokes passed in97851. The full fresh Ubuntu VM smoke passed in46053, including restricted sudo denials, stopped Docker/socket, stopped proxy, a 32 MiB temporary guest state filesystem, recovery, old-boot waiting and actual reboot completion. Token scan: 135 files, 18,358,624 bytes, no matches. VM deleted; local VM inventory empty and ownership record absent. Image version/digest are recorded in `architecture/guest-runtime.md`.
- Migration 0008 applied to development after stopping the owned API/worker. Restarted services passed the actual CLI/API/worker smoke for `vm_d527c4fb-11a0-4b5e-b0cf-dd6e7ebd75c2`, including deletion and cleanup. No cloud resources were created.

Runtime implementation `ca03da9ef6330357559d06d65eb83dc672a6a6a3` is committed and pushed. [Linux CI34071617896](https://github.com/yahorbarkouski/agent-cloud/actions/runs/34071617896) passed frozen installation, the 121-test full check, formatting, fresh PKI setup, all three native smokes and cleanup. The final different-model artifact/trail audit is `research/m1-guest-runtime-review.md`.

Production worker configuration still does not enable live provisioning. Image snapshot sanitation, certificate renewal, explicit operator recovery, bounded Hetzner boot/cleanup and M2–M7 remain. These results do not establish end-to-end customer application deployment.

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

Enrollment/provisioning checkpoint `12cee632fda2e86b655e052916e81f9bd69d98f4` is committed and pushed. [Linux CI run 34066756174](https://github.com/yahorbarkouski/agent-cloud/actions/runs/34066756174) passed frozen installation, the 94-test full check, formatting, fresh pinned Smallstep setup, all three native smokes and cleanup. M1 remains in progress.

M1 guest image and real Linux first boot, 2026-09-07:

- Added the TypeScript guestctl package, image manifest/bootstrap schemas, pinned public build artifacts, Ubuntu installer and systemd/SSH/Caddy configuration. Guest keys and certificate bundles publish atomically. Retries preserve keys, verify both private/public pairs and validate installed certificates before reactivation.
- The real installer passed with Node 24.20.0, Smallstep 0.30.6, Caddy 2.11.4, Docker 29.8.0 and Compose 5.5.1. Ubuntu package versions are recorded separately. No fleet credential enters the image build inputs.
- Review fixed service persistence across reboot, restrictive-umask file publication and installed-certificate timing. Actual boot exposed the missing SSH runtime directory after socket shutdown. Real Noble accepted the restricted certificate login while the probe account remained password-locked.
- Cloud-init 26.1 retained a token in combined-cloud-config.json after the first cleanup implementation. The fixed service disables subsequent cloud-init discovery and erases that cache too. The bounded scanner skips nonregular files and scans decoded systemd journal output. Its temporary token/journal copies are now removed through finally, including scanner failures.
- Clean `pnpm smoke:guest` passed on a fresh owned OrbStack Ubuntu VM, with real cloud-init/systemd enrollment, native host-CA SSH, Docker, Caddy health, rejection of clientless TLS, and a second reboot followed by another SSH connection. The token scan checked 135 files and 18,311,558 bytes with zero matches. The VM was deleted; a final OrbStack inventory was empty. The earlier diagnostic VMs were deleted too.
- `smoke:enrollment` now uses actual guest library key generation, lost-response retry, certificate installation and reactivation with its local service fixture. All three native smokes passed after the certificate validity change. Final pnpm check passed 99 tests in 16 files, typecheck/build and strict lint, including the cache/scanner edits. Linux CI is pending this checkpoint.

This proves a local Linux first boot, not Hetzner networking, sanitized snapshot boot, completed worker runtime readiness, renewal or the application product. Those M1 gaps and M2–M7 remain. No paid cloud resource was created. Architecture is in `docs/architecture/guest-image.md`; review is in `docs/research/m1-guest-image-review.md`.

Guest image checkpoint `a43cc322b3a438fd5f9256ff7e135aa28be6efb5` is committed and pushed. [Linux CI run 34069508351](https://github.com/yahorbarkouski/agent-cloud/actions/runs/34069508351) passed frozen installation, the 99-test full check, formatting, fresh PKI setup, all three native smokes and cleanup. Local shell syntax and customer-skill validation passed. The configured gpt-5.6-sol reviewer verified six decision rows and independently passed five filesystem/validity tests. Its report records the clean VM proof and keeps the untested forced scanner-failure path explicit.

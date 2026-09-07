# Current handoff context

Updated 2026-09-07. Implement the full agent-operated cloud in `docs/archive/original-plan.md`, excluding Stripe. M0 is complete; M1 is in progress. Keep the active goal open until the product works end to end.

## Scope and repository

Customers bring their own coding agents. Build their CLI/API/skills, not an agent. TypeScript, Linux VMs, Docker Compose, SSH and Hetzner. Keep infrastructure cheap; no provider benchmarks, expensive fallback or warm pool. Maintain AGENTS.md, architecture, progress, append-only decisions and this concise summary. Continue authorized work without repeated approvals.

Repo `/Users/yahorbarkouski/Documents/ChatGPT/learning/agent-cloud` is a standalone Git repository inside an unrelated workspace. Work only here. Branch `yahor/agent-cloud`; private origin `https://github.com/yahorbarkouski/agent-cloud.git`. Sanitation implementation4653f791846a840e8d37df9beb16833e775a2f69 is committed and pushed; Linux CI34075101498 passed frozen installation,121-test full check, formatting, fresh PKI setup, all three native smokes and cleanup. Previous runtime implementationca03da9ef6330357559d06d65eb83dc672a6a6a3 is committed and pushed. Linux CI34071617896 passed frozen install,121-test full check, formatting, fresh PKI setup, all three native smokes and cleanup. Previous guest implementation a43cc32/CI34069508351 also passed.

## Implemented control path

Zod contracts, PostgreSQL/Drizzle, Hetzner transport, SDK, Hono API/Graphile worker and JSON CLI. Tenant isolation, hashed credentials, delegation/revocation, idempotency, admission locks, gross VM+IPv4 integer-currency reservations and pinned offers have local proof. Catalog refresh is outside DB transactions and fails closed on expiry/currency disagreement.

The effect journal persists intent before I/O, owns Primary IP before VM, never resubmits an unknown create and waits for both resources to be absent before releasing quota. Legacy create/resize migrations pass. Live startup remains gated.

Migration0006 stores metadata-bound encrypted bootstrap and immutable claimed/issued guest identities. Migration0007 gives durable12-probe/4-identity signing ceilings. Exact prepared create_guest attempts render cloud-init once. Enrollment verifies confirmed create/ownership/provider IP, CSR and native SSH raw-key proof, then commits issued certificates, ciphertext erasure and runtime handoff together. Lost responses preserve keys/certificates.

## Guest and runtime checkpoint

`packages/guestctl` publishes keys/certificates atomically, validates private/public correspondence and stored certificates on retry, activates SSH/Caddy through actual systemd and erases cloud-init token copies. Explicit chmod handles UMask0077. Cloud-init combined runtime JSON and decoded journals require scanning; the scanner skips FIFOs/symlinks and bounds total bytes.

Public image tooling stages eight checksum-pinned artifacts: Node24.20.0, Smallstep0.30.6, Caddy2.11.4, Docker29.8.0, Compose5.5.1 and Docker dependencies. Ubuntu package versions are recorded, not bit-reproducible. Local sanitation is verified; provider snapshot publication/release is unfinished.

New guestctl inspect reports pinned versions, Docker daemon access, disk headroom, allocation-specific loopback proxy health and boot ID. A separate five-minute runtime SSH certificate forces exactly `sudo -n -- /usr/local/bin/guestctl inspect --json`. Exact sudoers permission, no Docker group/general sudo; identity command stays unprivileged. `packages/remote` requires the matching purpose and host-CA trust for runtime reads.

`guest-readiness.ts` checks current provider ownership, pinned image/keys and runtime evidence. Migration0008 stores immutable consecutive signing attempts with12-attempt per-operation cap. Service cooldown30s survives restart; credentials reused in memory. Create/reboot/power-on require fresh evidence, and reboot/power-on require a changed boot ID. Thirty-minute admission deadline checked before fresh effects and in completion transaction after SSH. Expiry blocks an owned VM; uncertain effects still reconcile; unused IP cleanup still runs. Review found the late-SSH completion race and its regression now passes.

Local evidence: full check121tests/18files, typecheck/lint passed session29425. Native runtime PKI policy passed71057. SSH and enrollment smokes passed97851. Fresh owned Ubuntu smoke46053 passed real cloud-init/systemd, restricted sudo denials, stopped Docker/socket, stopped proxy,32MiB temporary state filesystem, restored readiness, old-boot waiting and actual reboot completion. Token scan135files/18,358,624bytes/no matches. VM deleted; orb list[] and ownership record absent. Image dev-3e7f5c0ea7e8, digestb14b11bdb05883e7af0307a3817f31c047b0fcb10e3b9c382e1381dd0c2834c5. Provider observations simulated; no Hetzner boot claim.

Migration0008 applied after stopping owned API/worker. Restarted CLI smoke73214 passed for vm_d527c4fb-11a0-4b5e-b0cf-dd6e7ebd75c2. DB counts:9migrations,0activeallocations,0simulatedVMs/IPs. Updated customer skill, shell syntax and formatting valid. Different-model artifact/trail review complete; no remaining concrete runtime finding. Implementation commit and CI are complete.

## Local runtime and secrets

- Use `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>`. Node24 intended; system26.5/pnpm runtime24.10.0. Avoid concurrent builds sharing output.
- Dedicated Docker project agent-cloud-dev PostgreSQL17 at127.0.0.1:55439, DB/user agentcloud, local-development-only password. Tests own isolated temporary DBs. Base migrated through0008.
- API exec29969 at127.0.0.1:4319; worker6585, both current code with simulated provider. Inspect command/cwd before stopping.
- Ignored .env is simulated. `.local/admin.credentials.json` and `.local/hcloud-token` are0600. Never print values or pass secrets in argv/guests.
- `.local/tools/step-0.30.6`; healthy CAprojectagent-cloud-pki at https://localhost:9449. Issuer state `.local/pki/issuer`, rootprivate/provisionerpassword outside mount. Public trust `.local/pki/public`. Preserve keys.
- step-ca0.30.2 digest-pinned, NET_BIND_SERVICE only, no-new-privileges,256MiB/.5CPU. SSHkeysEd25519, CAkeysP256, TLSkeysP256. Host/TLS1h, identity/runtimeprobe5m. TLSserveronly; renewal/clientissuance unfinished. setup:pki updates managed templates and returns restartRequired; pki:down/up loads them without rotating keys. Updated runtime template passed native issuance.
- No local OrbStack VM exists. smoke:image ownership records are .local/guest-image-builder.json, guest-image-refusal.json and guest-image-machine.json. Records precede creation, success deletes owned machines, failure preserves them. Do not issue VM commands during active smokes. No paid resources exist.

## Hetzner

Verified account, dedicated project agent-cloud-development15945891; Default untouched. RW token agent-cloud-local-development saved privately. USD/23%VAT. Last saved catalog docs/research/hetzner-catalog-check-2026-09-06.json showed0VMs/IPs; CX23/33/43 unavailable, explicitly selected CPX12 grossUSD0.027798/hour includingIPv4. Refresh before mutation. SimulatedEUR.02/hour ceiling is not live configuration.

Read-only `PROVIDER_CURRENCY=USD HCLOUD_SERVER_TYPE_SMALL=cpx12 pnpm hetzner:check`. Never silently substitute a more expensive type. Live drill needs explicit currency/price/deadline and VM/IP/snapshot cleanup. No browser action pending.

## Active image publication work

Sanitation checkpoint 4653f79 and Linux CI 34075101498 are complete. Current HEAD c802b3a is the pushed documentation checkpoint. New image provenance/release implementation is dirty and uncommitted. No migration or base API/worker changes in this slice.

Selected operator image design in docs/architecture/image-release.md. Three arena candidates converged on sibling platform ownership; parent and gpt-5.6-sol judge selected A with B's acyclic input chain and provisioned initial host key, C's pure planner/recovery/promotion. Reject fake customer allocations, TOFU, raw cloud-init/private keys in journal and all type/region fallback. Research and current price evidence are in docs/research/image-release-\*.md and hetzner-image-catalog-check-2026-09-07.json.

Implemented so far:

- New @agent-cloud/images package; format 2 guest manifest binds full sorted public inventory. Includes installer, units, SSH/sudo policy, guest bundle, 8 pinned artifacts, canonical pins/trust. Derived manifest/inventory/checksums are excluded from their own input graph.
- Build stages privately, publishes .local/guest-builds/<manifestDigest>, files 0444/directories 0555, and atomically updates .local/guest-build.json. readGuestBuild captures/validates once; image smoke passes its digest to both child smokes. Same-owner chmod remains possible, so verify on reuse. macOS rename over read-only existing directory returns EACCES; accept only after verifying the complete existing destination. Failed staging restores its own directory permissions before removal.
- Trusted imageInstallCommand runs controller-owned shell source over management execution. Base OS sha256sum validates independently captured checksumDigest, listed files and absence of extras/symlinks before uploaded code. Installer takes input directory, builder UUID and admitted manifest digest; staged guestctl verify-inputs is a second check after Node extraction.
- Ed25519 signed release validates canonical inventory/manifest/artifact metadata, sanitation source, distinct verifier, event order, signing windows/revocation and retention. GuestImage is derived. It authenticates recorded assertions, not live provider ownership or actual boot source. Promotion/journal still unimplemented.

Validation at this live handoff:

- Final pnpm check 44164 passed 167 tests in 20 files, typecheck/lint. Native composed enrollment passed in the same session with actual guest library, Smallstep and OpenSSH/TLS; provider observations and activation are fixtures. Format, shell and customer-skill validation passed. Earlier tests exposed macOS sha256sum requiring explicit stdin minus, now corrected. Repeated build exposed EACCES on a read-only target, then final assertions found writable directories on reuse. Publication now reapplies 0444/0555 to new and reused verified destinations; final assertions passed with no staging remnants.
- Native smoke 59921 PASSED installation, sanitation/refusal/recovery and two full cloned enrollment/runtime/reboot checks. Each 125-file token scan had zero matches. Final orb inventory was empty and all three ownership records absent. Exact public evidence: docs/research/m1-image-provenance-verification.json. No local VM remains.
- Current selected manifest digest 7792e6add5b2e008c3b8e2e9bd681f4909c4e221bb43fcd66b2896f76ccf0db1, version dev-ec3deebee0cd9c819a50eb27, input digest ec3deebee0cd9c819a50eb2732b23121908dd6314d1e22617bffcf4bf964891f, transfer digest 9e365a2c22e2bb16db47848103bb13912b296a667a769c7099a4ce6b137387cf. Exact same build reused after permission fix. Initial superseded build 3af93a2d... remains a public local artifact only.
- gpt-5.6-sol image_release_judge reviewed current implementation in docs/research/m1-image-provenance-review.md. Its P1 self-attesting upload flaw is fixed by trusted transfer preflight and shell attack tests. Remaining finding is explicit future provider proof/promotion. It did not run tests; the final artifact/trail audit is complete with no local code blocker. No transcript directory supplied.

Next actions:

1. Local verification is complete. Reviewer image_release_judge on gpt-5.6-sol completed the final artifact/trail audit with no local code blocker. Commit/push this coherent checkpoint and verify Linux CI. Update this context with actual commit/run identifiers. Do not repeat completed local tests without a new change or finding.
2. Continue operator image admission, SQL build/effect/resource journal, bounded gross storage/VM budgets, provider image/access transport, isolated first SSH host trust, unknown/duplicate reconciliation and cleanup. Platform verifier bootstrap must not fabricate a customer allocation. Signed release consumption must verify current provider ownership and exact snapshot boot before promotion. No paid resource yet.
3. Finish certificate renewal/operator recovery and production GuestProvisioning wiring, then one bounded cheap Hetzner build/boot/cleanup drill. No expensive type/region fallback.
4. M2 browser/device login and customer access; M3 transfer/durable commands/Compose/routes; M4 recipes/off-VM backups/isolated restore; M5 usage/traffic/alerts/cost limits; M6 self-hosting; M7 end-to-end/failure proof. Keep goal active until the full product works.

Read PROGRESS and the linked research artifacts for historical evidence instead of rerunning completed checkpoints. Never use orb stop without an explicit owned machine name. Sanitation receipts authorize stopping that source before cloning; starting it during diagnostics invalidates the proof.

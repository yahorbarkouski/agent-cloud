# Current handoff context

Updated 2026-09-07. Implement the full agent-operated cloud in `docs/archive/original-plan.md`, excluding Stripe. M0 is complete; M1 is in progress. Do not mark the active goal complete around one finished slice.

## Scope and repository

Customers bring their own coding agents. Build the CLI/API/skills they use, not an AI agent. Use TypeScript, Linux VMs, Docker Compose, SSH and Hetzner. Keep infrastructure cheap. No provider benchmarks, expensive fallback VMs or warm pool. Maintain AGENTS.md, architecture, decisions, progress and this short summary. Continue authorized work without repeated approval.

Repo `/Users/yahorbarkouski/Documents/ChatGPT/learning/agent-cloud` is a standalone Git repository inside an unrelated parent workspace. Work only here. Branch `yahor/agent-cloud`; private origin `https://github.com/yahorbarkouski/agent-cloud.git`. Guest/image implementation `a43cc322b3a438fd5f9256ff7e135aa28be6efb5` is committed and pushed. Linux CI `34069508351` passed frozen installation, 99-test full check, formatting, fresh PKI setup, all three native smokes and cleanup. Previous enrollment implementation `12cee63` and CI `34066756174` passed.

## Implemented control path

Zod contracts, PostgreSQL/Drizzle, Hetzner transport, SDK, Hono API/Graphile worker, JSON CLI, Smallstep PKI and native SSH are implemented. Tenant isolation, hashed credentials, delegation/revocation, idempotency, admission locks, gross VM+IPv4 integer currency reservations and pinned offers have local proof. Catalog refresh is outside DB transactions and fails closed on expiry/currency mismatch.

The effect journal persists intent before I/O, owns Primary IP before VM, never resubmits an unknown create, and waits for both resources to be absent before releasing a reservation. Legacy command/resize migration cases pass. Live startup remains gated.

Migration 0006 stores encrypted, metadata-bound bootstrap tokens and immutable guest identity claims/certificates. Migration 0007 gives durable 12-probe/4-identity signing ceilings. Exact prepared create_guest attempts render cloud-init once. Enrollment checks confirmed operation/ownership/provider IP, validates the CSR, proves keys over native SSH, then atomically persists certificates, erases ciphertext and advances waiting_guest/enrollment to waiting_guest/runtime. Runtime completion is still missing. Probe credential cooldown uses synchronized application/DB clocks.

## Guest/image checkpoint

New `packages/guestctl` supplies the real first-boot CLI and library. It publishes complete key/certificate directories atomically, verifies SSH and TLS private/public correspondence, rejects changed stored certificate files, preserves keys after lost responses, and reactivates installed identity after token removal. Explicit chmod preserves intended public/group permissions under systemd UMask=0077. Signing-time and installed-certificate validity are separate checks.

`images/` and `scripts/build-guest.ts` stage public-only build inputs. Eight downloaded artifacts have pinned checksums: Node 24.20.0, Smallstep 0.30.6, Caddy 2.11.4, Docker 29.8.0, Compose 5.5.1 plus Docker dependencies. Ubuntu 24.04 package versions are recorded, not bit-reproducible. Manifest records component versions, bundle hash and public trust; snapshot release/provenance is unfinished.

The installer enables Docker, enrollment and proxy units. Enrollment runs after cloud-final, creates /run/sshd after disabling socket activation and enables ssh.service. Real Noble UsePAM accepts certificate login while agent-probe stays password-locked. Caddy runs as agent-proxy, with loopback admin/health and client-certificate-required 8443. There are no application routes yet.

Erasure disables later cloud-init discovery, removes user/vendor data, serialized datasource, local seeds, sensitive/combined runtime config and cloud-init logs, then removes bootstrap last. Actual cloud-init 26.1 exposed a token copy in /run/cloud-init/combined-cloud-config.json; it is now included. The smoke scans regular files and decoded journal output, skipping the hotplug FIFO and limiting total bytes.

Clean `pnpm smoke:guest` run, exec session92815, passed on owned Ubuntu VM agent-cloud-image-170314bb: actual cloud-init/systemd first boot, native host-CA SSH, Docker, Caddy health, clientless TLS rejection, token scan 135 files / 18,311,558 bytes/no matches, second reboot identity/proxy/host-CA SSH. Image dev-16e464e1b451, digest8ec5f5a92dbcfc01381b9a80a1ccc2d219f8bba0e998c21727948ca58b25f82d. VM deleted; orb list returned[]; ownership record absent. No manual repair was used in this passing run. Earlier diagnostic VMs were deleted. OrbStack networking is fixture-owned, so only its local datasource disables cloud-init networking. No Hetzner boot was verified.

The scanner failure cleanup was subsequently tightened with finally; reviewed structurally, not forced through a fresh failing VM scan. Successful scanning/reboot used the real implementation above. Do not claim every failure drill is complete.

All three native smokes passed after validity changes. Final pnpm check passed 99 tests in 16 files, typecheck/build and strict lint in session47601, including the final erasure/scanner edits. Formatting, shell syntax and customer-skill validation passed. A new JS fixture exposed the lint config's missing .mjs extension; its existing JS-only rule scope now includes js/mjs/cjs, with TS checking unchanged.

## Runtime and secrets

- Use `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>`. Intended Node 24; system26.5 and pnpm runtime24.10.0. Do not run concurrent builds against shared output.
- Dedicated Docker project agent-cloud-dev: PostgreSQL 17 at 127.0.0.1:55439, DB/user agentcloud, local-development-only password. Tests create/drop isolated databases. Development is migrated through 0007, eight migrations. Last CLI smoke left zero active allocations/simulator VMs/IPs.
- API exec 48784 on127.0.0.1:4319 and worker 33358 run committed enrollment code. No control behavior/migration changed in this guest checkpoint. Inspect command/cwd before stopping owned services.
- Ignored .env uses simulator; admin.credentials.json and hcloud-token are owner-only in .local. Never print secrets or pass values in argv.
- Pinned .local/tools/step-0.30.6; local CA agent-cloud-pki is healthy at https://localhost:9449. State .local/pki/issuer; offline encrypted root key and provisioner password outside mount. Public trust in .local/pki/public. Preserve keys; do not rotate silently.
- step-ca 0.30.2 digest-pinned, NET_BIND_SERVICE only, no-new-privileges, memory 256m / cpu .5. SSH keys Ed25519, CA keys ECDSA-P256, TLS keys P256. Host/TLS 1h and probe 5m. Probe certificate forces identity command without extensions. Current TLS template is server-only. Renewal and client issuance are unfinished.
- No local OrbStack VM remains. smoke:guest records ownership before creating one and deletes after success; on failure inspect only the recorded VM, then delete it and its record before a fresh run. No paid resources exist.

## Hetzner

Account verified. Dedicated project agent-cloud-development ID 15945891; Default untouched. RW token agent-cloud-local-development in .local/hcloud-token. Account USD / 23% VAT. Last saved catalog docs/research/hetzner-catalog-check-2026-09-06.json had zero VMs/IPs, unavailable CX23/33/43, available explicitly selected CPX12 at gross USD0.027798/hour including IPv4. Refresh before any mutation. Current simulated ceiling EUR .02/hour is not live configuration.

Read-only: `PROVIDER_CURRENCY=USD HCLOUD_SERVER_TYPE_SMALL=cpx12 pnpm hetzner:check`. Never silently substitute a more expensive type. Before a live drill set explicit currency/price/deadline and VM/IP/snapshot cleanup. No browser action pending.

## Next concrete work

1. Guest image checkpoint a43cc32 and Linux CI34069508351 are complete. Continue runtime readiness; do not repeat completed enrollment or image tooling work. Do not rerun the finished control integration slice.
2. Implement actual runtime inspection and worker readiness using the persisted identity and host CA. Identity probe credentials force one command; a runtime inspection capability needs its own narrow certificate policy. Never grant the probe Docker/root access broadly.
3. Implement image sanitation and cloned fresh identity proof, owned snapshot cleanup, certificate renewal and explicit operator recovery. Only then enable a bounded cheap Hetzner build/boot/cleanup drill.
4. M2 device/browser auth, CLI grants and customer SSH/gateway access/revocation; M3 transfers/durable commands/Compose/routes; M4 recipes/off-VM backups/isolated restore; M5 usage/traffic/alerts/cost limits; M6 self-hosting; M7 failure drills and end-to-end proof.

Append-only decisions are in docs/DECISIONS.tsv. Architect/how/arena design work is already complete for this guest slice; do not repeat it without evidence. Applied show-me-your-work requires a different-model artifact/trail audit and Attention note before handback. Existing guest_design_judge uses gpt-5.6-sol; report docs/research/m1-guest-image-review.md includes the clean outcome and six-row trail audit. No transcript directory is supplied; do not claim a transcript audit.

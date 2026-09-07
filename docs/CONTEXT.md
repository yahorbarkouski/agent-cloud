# Current handoff context

Updated 2026-09-07. Full cloud goal remains active, excluding Stripe. M0 is complete; M1 and M2–M7 remain open. Work only in this standalone repo. Customers bring their own agents. Implementation, private pushes and bounded cheap Hetzner tests are authorized. No benchmarks, expensive plans, warm pool or automatic provider/type/region fallback.

## Current customer runtime checkpoint

Branch `yahor/agent-cloud`, private origin https://github.com/yahorbarkouski/agent-cloud.git. HEAD is `b16466b9624f98b889f5a41e0a289d4507c5e2a6`, enrollment clock authorization. Exact CI34116511248 passed full checks, fresh PKI/native smokes and cleanup. `.local/enrollment-clock-ci-result.json`. Customer runtime changes are verified locally and ready to commit; exact CI is pending.

Implemented explicit customer mode, signed renewal-capable allocation image selection, original bootstrap rendering, enrollment/renewal/readiness wiring, customer-only jobs, lazy private identity/PKI, and separate image-factory mode. The customer process never loads release.key. Authenticated recovery reads and exact known-resource cleanup remain available after private-material loss. Fresh create checks the configured CA, current image policy/provider snapshot and owned firewall ingress before effects. Customer power-off now requests graceful shutdown, with observed off required. Remaining bootstrap/readiness/scheduling clocks use database time.

GuestProvisioning now takes a prepareBootstrap callback, replacing embedded seal/enrollmentUrl. All existing callers migrated. Renewal/readiness initialization is independent of bootstrap-key recovery; only initial enrollment and fresh creates need the seal. API startup performs preflight only in image_factory. Customer `runtime:check` performs explicit read-only dependency and public-route checks instead. Default release expiry must not prevent customer recovery startup.

Full32555 passed 381 tests/35 files; full96292 passed 382 after firewall error classification. Focused28123 passed seven customer cases after splitting bootstrap dependency from renewal/readiness. Final full37481 passed 383 tests in 35 files, typecheck/lint,85.97s, in `.local/customer-runtime-complete-check.log`. Native58010 passed Smallstep/OpenSSH/TLS enrollment+renewal and cleanup in `.local/customer-runtime-native.log`; it predates the customer-only follow-ups and uses fixture-aged issuance, not elapsed expiry. Actual API subprocess startup with missing bootstrap/PKI files and unavailable provider reads passed in the full suite. No customer Hetzner boot is claimed.

Simulated API34805 and worker45056 replaced15970/63771. CLI smoke1715 passed machine vm_31f24355-065d-4003-a653-1cbda1206fbb through create/inspect/destroy/cleanup. `.local/customer-runtime-local-smoke.log`. Migration check passed all18 hashes; no schema changes. SQL cleanup check at11:52:55Z confirmed zero active allocations, simulated servers/IPs and unfinished image builds; all native VM records are absent. `.local/customer-runtime-cleanup-check.json`. Final formatting and customer skill validation passed; exact-commit CI remains pending. gpt-5.6-sol reviewer found no blocker after startup correction or in the final bootstrap-service split. See `docs/research/m1-customer-runtime-review.md` and append-only `docs/DECISIONS.tsv`. No transcript directory was supplied.

## Costs and real provider proof

No paid resources remain from the prior image drill. A fresh read-only Hetzner check at2026-09-07T11:52:55.769Z found zero servers, Primary IPs, snapshots, firewalls and SSH keys. `.local/customer-runtime-provider-inventory.json`. Customer-runtime work made no provider mutations. No native VM remains active, and all owned VM smoke records are absent. The native enrollment smoke used a disposable local SSH container and removed it.

Corrected real image build `de7d3f33-0f3e-4512-afc6-d163b1cd7359` passed installation, sanitation, graceful shutdown, snapshot boot, verifier enrollment/runtime and signed publication/selection. Full cleanup completed10:35:25.733Z. Post-cleanup inspection confirmed historical signature validity, rejected current selection, exact snapshot absence and cleanup replay. Evidence: `docs/research/m1-hetzner-durability-drill.json` and `m1-hetzner-durability-release.json`. No deployable snapshot is retained. Its seven owned resources and local keys are absent.

First image build `bbb28cd4-aca1-4a94-87cf-364728bf6771` failed verifier enrollment after a hard power cut left installed runtime files empty. Dirty-data loss is a supported inference, not sole-cause block-level proof. Preserve the failure separately in `m1-hetzner-image-drill.json`. The correction flushes the root filesystem, stops the random-seed writer before erasure and uses graceful shutdown without force fallback. Native OrbStack seed behavior has an explicit local virtualization override; it is absent from published inputs.

## Renewal and immutable state

Renewal implementation `7843b036da6f9d3bf968366576549912f183e6af`, exact CI34115440102 passed. Original P-256 signatures, database-time freshness, current VM/IP ownership, pinned SSH proof, persisted four-per-hour signing attempts, immutable identity history, atomic certificate generations, activation retry and persistent timer are implemented. Native3342/VM68924 passed the relevant local proofs and cleanup. See `docs/architecture/guest-renewal.md` and `docs/research/m1-guest-renewal-verification.json`.

All18 migrations0000–0017 are applied and immutable. Latest0017 hashf2039f86b6843aef9a1141fa6d79a56ae2d26dae54403edfcfed254c0a102e56. Do not edit applied SQL. No new migration in this checkpoint.

Current guest manifest212a16f8a29089b2ed0a18c9f9bb91e188411c729f566efcea71d59dadb15424, versiondev-a170e62cde5f91fe03baca10, public input digest a170e62cde5f91fe03baca10cde0c3605769c6632e0eb1ca39e1ca21d57d34e0, transfer checksum86fb552a5714e16f3e9249220836c335e97aae4da7b7082566a8483e16f0f667. `.local/guest-build.json` selects its immutable `.local/guest-builds/<manifest>` tree. Customer runtime code does not change these inputs. The historical real Hetzner release used the older enrollment-only durability image, so it could not satisfy new customer selection even if retained.

## Local services and secrets

Commands use `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>`. Pnpm uses Node24.10.0; system Node26.5. TS scripts importing src/\*.js need tsx, for example `node --env-file=.env --import tsx scripts/check-hetzner.ts`.

PostgreSQL17 listens127.0.0.1:55439 with database/useragentcloud and passwordlocal-development-only. Smallstep CA https://localhost:9449 uses256MiB/.5CPU and pinned step0.30.6/step-ca0.30.2. Current simulated API34805/worker45056 serve4319. `.env` remains simulated. `.local/admin.credentials.json`, `.local/hcloud-token` and identity/PKI secrets are0600. Never print them or put tokens in argv/guest data. Provider projectagent-cloud-development15945891; Default untouched.

`.local/runtime.json` remains image_factory, not customer. It points to `.local/runtime-identity`, `.local/guest-builds`, `.local/image-access` and local PKI. Preserve original private material. Public release key ID6c4eb920bf75d1b753253c327082b3c1386136928830e50779b9efc2e1c1a481. Policy reloads for every authorization; restart API and worker after private changes. No quick tunnel or image worker/API is running. Do not reuse the stopped tunnel URL.

## Next work

Finish final customer runtime checks, review/evidence, formatting, commit/push and exact CI. Then implement an authorized cancellation/recovery path for blocked customer provisioning. Current lifecycle admission rejects destroy while a create remains blocked. Do not paper over this with a direct SQL mutation or claim unused-IP compensation covers a known/uncertain VM. Preserve effect journals, unknown outcomes and ownership through recovery.

Before a paid customer drill, build and temporarily retain a renewal-capable release, create explicitly owned customer firewall rules, use reachable HTTPS, read fresh inventory/pricing, record CPX12 nbg1 spending/deadline caps and own cleanup throughout. The previous image drill used one build,90minutes,$0.12 VM/IP gross and$1 monthly snapshot caps; these were caps, not invoices. No deployable image or customer firewall exists now. Image recovery remains `pnpm image:build cleanup <build-id>` without private identity/PKI/source/pricing.

Continue M2–M7 customer access/device login, persistent commands/file transfer, Compose, HTTPS/routes, recipes/backups/restore, usage and self-hosting. Image/runtime progress does not complete the application product.

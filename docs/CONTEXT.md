# Current handoff context

Updated 2026-09-07. The full agent-cloud goal remains active, excluding Stripe. M0 is complete; M1 and M2–M7 remain open. This continuation made verified progress and is not blocked. No paid cloud resource has been created. Do not mark the full goal complete after an image checkpoint.

## Scope and repository

Customers bring Codex, Claude Code or another coding agent. We build their CLI/API/skills. TypeScript, ordinary Linux VMs, Compose, SSH and Hetzner. Keep costs low; no benchmarks, expensive plans, warm pool or automatic size/region fallback. Continued implementation, private GitHub pushes and Hetzner setup are authorized.

Work only in `/Users/yahorbarkouski/Documents/ChatGPT/learning/agent-cloud`, standalone Git inside an unrelated workspace. Branch `yahor/agent-cloud`; private origin `https://github.com/yahorbarkouski/agent-cloud.git`. Previous publication implementation `b72f992` passed Linux CI 34097317093. Allocation/scheduling implementation `ba42de027bab4928127a0d98979bb7c1989b9377` is committed and pushed. The gpt-5.6-sol artifact/trail review found no blocker. Exact-commit Linux CI 34101902876 passed in 3m41s, including frozen install, full checks, formatting, fresh PKI and all three native smokes with cleanup. Final documentation records that proof. Continue production configuration next.

## Implemented foundation

Contracts/Zod, PostgreSQL/Drizzle, Hono/Graphile, SDK and JSON CLI. Tenant grants/delegation/revocation, idempotency, quotas, gross currency/VM/IPv4 prices and pinned offers. Customer journals own IP before VM, persist intent before I/O, never retry unknown creates, and release reservations only after authoritative VM/IP absence. Catalog refresh stays outside admission transactions.

Encrypted customer bootstrap, immutable claimed/issued identities, durable signing budgets, pinned provider-address SSH proof and atomic certificate/token-erasure/runtime handoff. Restricted readiness checks image/keys, components, disk, proxy and boot ID; reboot/power-on require a changed boot ID. Thirty-minute customer operation deadlines gate fresh effects and completion. Production API/worker still reject Hetzner activation; `createTasks` now accepts guest and image ports, but `worker.ts` does not supply them.

Customer wire version 1 is allocation-owned. Verifier version 2 names `{kind:'image_verifier',id:ImageBuildId}`. PKI/SSH APIs use GuestSubject; verifier DNS is `verify-<UUID>.guest.agent-cloud.internal`. Guestctl shares atomic keys/certificates, enrollment and restricted runtime inspection, with metadata at `/var/lib/agent-cloud/guest.json`. Verifier machine ID must differ from its sanitized builder.

Builds use sibling operator journals, never fake customer allocations. Pure planning dispatches to separately locked provider/builder/verifier/cleanup executors. Installation intent precedes SSH; lost completion recovers without reinstalling. Unknown sanitation requests full abort. Snapshotting requires saved sanitation and confirmed shutdown. Effect IDs and provider labels bind ownership. Verifier bootstrap binds the exact confirmed snapshot, server/effect and IP. Cancellation/expiry are rechecked before durable completion.

`image-publication.ts` captures immutable evidence before temporary cleanup. Cleanup preserves the exact snapshot, removes temporary resources and local keys, then signing and retained state commit atomically. Retained reads and replay recheck signature, current key policy and snapshot ownership. A null provider source is accepted only after saved verified provenance and complete temporary cleanup. A different nonnull source is rejected. Signed audit evidence persists after deletion. Retained builds release VM allowance while keeping snapshot storage reserved.

## Allocation and scheduling checkpoint

`allocation-image.ts` verifies signed admission under the source-build row lock, pins the exact release/snapshot/offer/deadline and resolves current trust/provider ownership before fresh IP/VM work. The renderer rechecks it. SQL prevents substituted bootstraps, second creates, mutable pins and reversed retirement. Pin release is derived from original create confirmation or fully retired ownership; pending/unknown creates retain snapshots even beyond retention expiry. Snapshot-delete intent uses the same row lock and checks the pin again.

`image-scheduling.ts` records explicit start, admits deadline-only jobs and schedules retained expiry. Start/cancel/reschedule share the build row lock. `image-tasks.ts` advances the actual controller and reconciles unfinished builds plus cleaned builds lacking access removal. `image:build start` queues durable intent; admission alone cannot rent. `access_removed_at` records successful filesystem removal; SQL refuses publication without it. Filesystem cleanup failure resumes after restart without replacement capacity.

Follow-up tests found two error gaps: plain signature exceptions left allocations retrying, while a busy publication could fail them. Typed trust failures now compensate; retryable provider_unavailable waits for another tick. The resolver and renderer both enforce this boundary. Current key policies are injected arrays; production reload/configuration remains open.

Broader tests exposed ~2 ms host/PostgreSQL skew at the verifier's exact 30-minute limit. The first DB-time helper assumed Drizzle raw timestamps were Date objects; it now requests numeric epoch milliseconds. A subsequent full run exposed the opposite clock mismatch when DB-issued releases were immediately verified against host time. Verifier expiry, release signing/verification, selection and admission now use DB time consistently. Tests cover a five-second controller Date.now offset for bootstrap and host Date offsets in both directions for release publication/selection. No SQL time guard was relaxed.

## Verification and schema

Evidence: `docs/research/m1-image-use-verification.json`. Full check 79451 passed **339 tests in 31 files**, typecheck and lint. Final 32612 passed typecheck/lint and four Graphile cases after invoking the actual start CLI and adding the read-only migration checker. Native enrollment 97118 passed real Smallstep/OpenSSH/TLS with fixture provider observations. Local CLI 91748 passed create/inspect/destroy/cleanup for `vm_ed4c9221-2170-4f2c-b9db-ae18eecb5968` after restart. Base cleanup f2b982 found zero active allocations, simulated VMs/IPs and open image builds.

All **17 migrations through 0016** are applied to development and hashes match 986c26. Latest SHA256 `569599f36dc2807f8c52acda47b867805a7bb8bcfaeeb09a524afd0146e8e048`. **Never edit applied 0016 or older migrations.** Use `pnpm db:check`; it compares recorded migration hashes and timestamps with repository inputs and exits nonzero on mismatch. Application 64a62e ran with the owned API/worker stopped.

Prior native publication proof remains `docs/research/m1-image-publication-verification.json`: native 27055 used an actual Ubuntu builder, sanitation/recovery, two customer clones and a build-owned verifier. Temporary VMs were deleted before signing a retained protocol snapshot, then cancellation cleaned that snapshot. Cleanup 1908e3 found no VMs, records or private fixtures. This continuation changed control-plane code, not guest inputs, and reran composed native enrollment rather than the full builder drill.

Selected public tree remains manifest `06e2977ed433a27bd2e91ac741a126cb791be99f41746966789329b37d296764`, version `dev-842538bfbd610382f2bcb728`, input digest `842538bfbd610382f2bcb7289cde21a97bc157d7428012f1059494020c5ba7c8`, transfer checksum `1f4229064498676568d91be6743affe45dc1993083c94907389e82b91f2c0b3d`. Published input directories are immutable. The SSH startup gate prevents listeners on unseeded sanitized clones; enrollment starts SSH after installing identity.

## Local runtime and ownership

Use `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>`. Target tests with `pnpm exec vitest run tests/file.test.ts`; `pnpm test -- file` forwards poorly. Node 24 intended; system 26.5, pnpm runtime 24.10.0. Adding the root Graphile dev dependency initially left an incomplete peer link; `pnpm install --fix-lockfile` repaired it. Exact-commit CI proved frozen installation.

Docker/OrbStack healthy. PostgreSQL 17 project agent-cloud-dev at 127.0.0.1:55439, db/user agentcloud, password local-development-only. **API 29181** on 127.0.0.1:4319 and **worker 75505** run current simulated code. Inspect process command/cwd before stopping. `.env` uses simulation. `.local/admin.credentials.json` and `.local/hcloud-token` are 0600; never print credentials or put them in argv/guest metadata. No VM smoke is active. Native enrollment process completion was confirmed with exit0 in6b8cf0. A later full formatter finished after slow traversal of ignored SSH fixture state; remaining empty directories under the exact `.local/ssh-smoke-xDhuI1` scratch path were removed with rmdir and absence verified. For documentation-only checks, pass the changed filenames directly. Docker inspection 1378c6 found only the persistent development CA/DB for this project, alongside unrelated containers that must not be touched.

Smallstep `.local/tools/step-0.30.6`, step-ca 0.30.2 digest-pinned, project agent-cloud-pki at https://localhost:9449, 256 MiB / 0.5 CPU. Issuer `.local/pki/issuer`; offline root private/provisioner password stay outside CA mount. Public trust `.local/pki/public`. Preserve keys. Runtime certificates in both namespaces force only guestctl inspect. Certificate renewal and production recovery are unfinished. Publication test keys are ephemeral, not operator production configuration.

VM ownership paths and cleanup rules are in AGENTS.md. Run smokes sequentially and leave VM commands to an active smoke; even diagnostic `orb run` can restart its deliberately stopped source. On failure inspect/delete only recorded machines and exact private fixtures. Operator key store defaults to `.local/image-access/<buildId>`.

Reviewer `/root/image_release_judge`, gpt-5.6-sol, reviewed pin/scheduling code and SQL, then found the remaining signing/verification clock mismatch. Final artifact/trail audit found no blocker; report `docs/research/m1-image-use-review.md`. No transcript directory was supplied; the review must describe itself as an artifact/trail audit.

## Next work

1. Extend the discriminated `readConfig` output in `apps/control/src/config.ts` with mandatory live release/key/enrollment settings, build the operator image worker factory and reconciliation cron, and wire the existing customer GuestProvisioning/enrollment ports in API/worker startup. Add production signing-key setup, reachable enrollment and certificate renewal/recovery before lifting either live gate. Optional internal image injection must not enable live admission.
2. Run one bounded cheap Hetzner drill only after its full lifecycle and cleanup are ready. Last read-only inventory 04:17:12Z found 0 resources; refresh before paid mutations. Project agent-cloud-development 15945891, Ubuntu 24.04 x86 image 161547269. Historical CPX12 + IPv4 price of 27,798 gross micro-USD/hour and snapshot price of 24,477 gross micro-USD/GB-month are not current admission authority. No fallback or benchmark.
3. Continue M2–M7: access/renewal/revocation, deployment/Compose/routes, recipes, backups and isolated restore, platform recovery, self-hosting and affordable failure drills. Passing image tests are not end-to-end application deployment.

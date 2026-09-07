# Current handoff context

Updated 2026-09-07. The active goal is the full agent-operated cloud in `docs/archive/original-plan.md`, excluding Stripe. M0 is complete; M1 and M2–M7 remain open. This turn made progress and is not blocked. Do not mark the goal complete after an image checkpoint.

## Scope and repository

Customers bring Codex, Claude Code or another coding agent. Build their CLI/API/skills, not an agent. Use TypeScript, ordinary Linux VMs, Docker Compose, SSH and Hetzner. Keep costs low: no benchmarks, warm pool or automatic type/region fallback. Continued implementation, private GitHub pushes and Hetzner setup are authorized. No paid resource has been created.

Work only in `/Users/yahorbarkouski/Documents/ChatGPT/learning/agent-cloud`, a standalone repository inside an unrelated workspace. Branch `yahor/agent-cloud`; private origin `https://github.com/yahorbarkouski/agent-cloud.git`. Controller implementation `cbc8cc62184639246c9356a04febfed192c8253a` is committed and pushed. Linux CI run `34089677202` passed in 2m49s with frozen install, full checks, formatting, fresh PKI, all three native smokes and cleanup. The documentation checkpoint records those results; no code changed after that successful run. Preserve the full goal across continuations.

## Implemented foundation

Contracts/Zod, PostgreSQL/Drizzle, Hono/Graphile, SDK and JSON CLI. Tenant grants/delegation/revocation, idempotency, quotas, gross currency/VM/IPv4 prices and pinned offers. Customer journals persist intent before I/O, own IP before VM, reconcile uncertain creates without resubmission and require VM/IP absence before releasing reservations. Catalog refresh runs outside admission transactions.

Encrypted allocation bootstrap and immutable guest identities have durable bounded signing attempts. Enrollment proves the currently owned provider address through pinned SSH before signing. Certificate persistence, bootstrap-token erasure and runtime handoff commit together. Runtime credentials force only `sudo -n -- /usr/local/bin/guestctl inspect --json`; they grant no general sudo or Docker access. Readiness checks pinned image/keys, components, disk headroom and boot ID. Reboot/power-on require a changed boot ID. Fresh paid effects and completion enforce a 30-minute operation deadline. Production `createTasks` still does not supply GuestProvisioning, and live startup is gated.

Guestctl and the pinned Ubuntu installer have real local cloud-init/systemd enrollment, sanitation, service-failure recovery, reboot and distinct-clone proof. Full public input provenance is bound to immutable manifest-named trees. A controller-owned transfer preflight validates checksums with base OS tools before uploaded code executes. Signed release metadata authenticates recorded assertions; actual provider snapshot ownership/boot and production promotion remain unfinished.

## Durable image controller checkpoint

Operator builds use sibling SQL journals, never customer allocations. All **14 migrations through 0013 are applied** to the base development DB and their hashes match disk (check `f60973`). Never rewrite an applied migration. Migration 0013 adds `image_builder_work`, immutable builder/effect binding, exact receipt/JSON shapes, forward-only phases and SQL sanitation gates for stop/snapshot effects.

- `image-builds.ts` owns input admission, replay, consistent inspection and cancellation. `image-budget.ts` reserves both VM/IP lifetimes with whole-hour rounding and separate gross snapshot storage. Admission/fresh creates share aggregate allowance lock 78131026. Build deadlines are at most 24 hours, retention at most 30 days; open builds hold their full caps.
- Effect/resource journals persist intent before submission and retain every owned ID. Unknown creates never retry. Exact-ID stop/delete retries preserve original receipts. `imageEffectLabels` binds observations and requests to the persisted effect UUID. Fresh creates verify the exact compatible Ubuntu base image and pinned offer. Missing actions are distinct from failed/running actions.
- `image-access.ts` generates independent native management/host keys in owner-only local directories. Recovery validates owner, mode, symlink boundaries, private/public correspondence and exact admission. Only public keys and secret references enter SQL. The renderer recovers credentials only for the active prepared effect, then rechecks cancellation/deadline before returning cloud-init.
- `image-release-plan.ts` chooses one step from a consistent snapshot. `advance-image-build.ts` dispatches to separately locked provider, builder or cleanup executors. Never call an executor inside another connection's build lock. The runner creates access resources and a builder, installs, sanitizes, stops and creates a snapshot, then returns `verification_required`. No live advancement CLI is exposed.
- `image-builder-work.ts` rechecks owned server/IP before SSH, persists installation intent, recovers completed receipts without reinstalling, and persists sanitation intent before access erasure. Interrupted/unknown sanitation requests full cleanup. Completion evidence may be saved after cancellation; cleanup remains authoritative. SQL requires saved sanitation before stopping and a matching confirmed stop before snapshot creation.
- Full abort covers every implemented stage, including snapshots. Unknown creates retain credentials and reservations. Local keys are removed only after all provider resources are authoritatively absent and SQL is cleaned. Atomic rename plus known-file unlink makes key deletion concurrent and restartable. Missing admission metadata, wrong binding, foreign directory symlinks and unexpected files fail explicitly.

Platform-owned verifier enrollment, retained cleanup, promotion and consumption remain open. The clone smoke still uses the existing customer enrollment/runtime fixture; it is not the future platform verifier lifecycle. `pnpm image:build` supports prepare/admit/inspect/cancel only.

## Current verification

Evidence: `docs/research/m1-image-builder-work-verification.json`. Full check `85297` passed **288 tests in 26 files**, typecheck and lint. Targeted `38406` passed 94 tests. Formatting `14512` and final `18947` passed. Initial validation-order and fixture-lint failures were corrected; Prettier needed a second pass on one method chain. The gpt-5.6-sol reviewer completed code/artifact/trail review with no remaining blocker. Its earlier SQL extra-field finding was fixed before migration application. Report: `docs/research/m1-image-builder-work-review.md`. No active-workspace transcript directory was supplied, so the review is an artifact/trail audit.

Native `smoke:builder` **6670 passed** with actual SSH/SFTP/cloud-init and the durable controller. It deliberately lost a successful installation response, recovered through a fresh DB connection, persisted sanitation, stopped the real builder before protocol snapshot creation, and verified two fresh native clone boots. Both clones passed enrollment, restricted runtime/service/disk checks and reboot with distinct machine/SSH/TLS identities. Builder scan: 64 files / 94,289 bytes, no matches. Clone scans: 125 files each / 598,428 and 599,426 bytes, no matches. Full abort deleted the actual VM and protocol resources before removing keys. Final cleanup `d10d87`/`bf26c2` at 06:07:53Z confirmed empty OrbStack inventory, absent ownership records and empty private fixture directory. **No VM or smoke remains.** This is local native proof, not Hetzner snapshot proof.

Migration was applied with confirmed owned API/worker processes stopped. Restarted CLI/API/worker smoke **68795 passed** for `vm_2078205a-a653-4de6-8b22-7e28daf856ff`. SQL check `45f8f1` confirmed zero active allocations, simulator VMs and simulator IPs. The provider remains simulated.

Selected verified public input tree:

- Manifest: `03ef1c1b04ce408d298922c4d299d076a7ec8dd9b6e54a0d7dcf303656568474`
- Version: `dev-42712ace9ccfcbdc546de157`
- Inputs: `42712ace9ccfcbdc546de15745da6feabaeb6a06131e421070320ac7ccdd91a0`
- Transfer checksum: `be4a1d280b645a7c31c3620cb87a4effd77997be3a74480da93b1ab1297eb72d`

Only `guestctl.mjs` changed from the previous tree because new shared contracts enter its bundle. Inputs under `.local/guest-builds/<digest>` are immutable: files 0444, directories 0555. Capture `.local/guest-build.json` once and validate before use. Prior access proof and native findings are retained in PROGRESS, DECISIONS and `research/m1-image-access-verification.json`.

## Local runtime and credentials

- Run `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>`. Intended Node 24; system 26.5, pnpm runtime 24.10.0. Avoid concurrent builds sharing outputs.
- Docker/OrbStack healthy. PostgreSQL 17 project `agent-cloud-dev`, `127.0.0.1:55439`, database/user `agentcloud`, password `local-development-only`. Tests create/remove isolated databases. Current API **62811** on `127.0.0.1:4319`, worker **28742**. Inspect process command/cwd before stopping either.
- `.env` selects the simulator. `.local/admin.credentials.json` and `.local/hcloud-token` are owner-only. Never print their contents or put credentials in argv/guest data.
- Pinned Smallstep `.local/tools/step-0.30.6`; step-ca 0.30.2 digest-pinned project `agent-cloud-pki`, `https://localhost:9449`, 256 MiB / 0.5 CPU. Issuer state `.local/pki/issuer`; root private key/provisioner password stay outside its container mount. Public trust `.local/pki/public`. Preserve existing keys. Host/TLS certificates last one hour; probes five minutes; TLS leaves are server-only. Renewal and production recovery are unfinished.
- VM ownership records: `.local/guest-image-builder.json`, `guest-image-refusal.json`, `guest-image-machine.json`. Builder/image/guest smokes share them and must run sequentially. While a smoke is active, leave VM commands to it: even diagnostics can restart a sanitized source. On failure inspect/delete only recorded machines and exact private fixture directories before retrying.
- Operator key store defaults to `.local/image-access/<buildId>`; native fixture store is `.local/image-builder-access/<builderId>`. No private fixture material remains after the passed smoke.

## Hetzner and next work

The verified account has dedicated project `agent-cloud-development` 15945891; Default was left untouched. RW token is saved privately. Last read-only account check at 04:17:12Z found compatible x86 Ubuntu 24.04 image 161547269 (5 GB) and zero servers/IPs/snapshots/firewalls/keys. Evidence: `research/hetzner-image-transport-read-check-2026-09-07.json`. Historical USD pricing with 23% VAT: CPX12 in nbg1/fsn1/hel1 at 27,798 gross micro-USD/hour including IPv4; snapshot 24,477 micro-USD/GB-month. Refresh before paid mutation; these are not current admission authority. A 90-minute two-machine test reserved four billable VM/IP hours plus 40 GB full-month storage, USD 1.090272 before margin. A deadline cannot force deletion during a provider outage.

1. Implement platform-owned verifier bootstrap/enrollment and actual stopped-snapshot boot proof, then signed retained release promotion/consumption. Reuse proof/signing functions without fabricating customer allocation records. The current guest bootstrap/proof/runtime schemas are allocation-specific; trace that identity boundary before adding verifier support. Separate successful retention cleanup from full abort.
2. Finish certificate renewal, operator recovery and production GuestProvisioning wiring. Then perform one bounded cheap Hetzner drill with exact resource ownership and cleanup. No paid resource until its complete bounded lifecycle is ready.
3. Continue M2 login/customer SSH, M3 transfer/durable commands/Compose/routes, M4 recipes/off-VM backup/isolated restore, M5 usage/traffic/alerts/cost limits, M6 self-hosting and M7 end-to-end/failure proof. Keep the full goal active.

# Current handoff context

Updated 2026-09-07. The full agent-cloud goal remains active, excluding Stripe. M0 is complete; M1 and M2–M7 remain open. This continuation is making progress, not blocked. No paid cloud resource has been created. Do not mark the full goal complete after an image checkpoint.

## Scope and repository

Customers bring Codex, Claude Code or another coding agent. We build their CLI/API/skills. TypeScript, ordinary Linux VMs, Compose, SSH and Hetzner. Keep costs low; no benchmarks, expensive plans, warm pool or automatic size/region fallback. Continued implementation, private GitHub pushes and Hetzner setup are authorized.

Work only in `/Users/yahorbarkouski/Documents/ChatGPT/learning/agent-cloud`, standalone Git inside an unrelated workspace. Branch `yahor/agent-cloud`; private origin `https://github.com/yahorbarkouski/agent-cloud.git`. HEAD before this continuation is `f17c376`; prior implementation `ba42de027bab4928127a0d98979bb7c1989b9377` passed exact-commit Linux CI 34101902876 with 339 tests, frozen install, formatting and native PKI/SSH/enrollment smokes. Current production runtime work is **uncommitted**. No migrations changed.

## Current implementation

The established foundation includes tenant authentication/grants, JSON CLI/SDK, PostgreSQL/Drizzle/Hono/Graphile, simulated and Hetzner transports, pinned gross prices, durable customer/image journals, encrypted bootstrap, restricted SSH proof, guestctl, signed image publication, allocation pins and durable image scheduling. Architecture docs own detailed invariants. Unknown creates never retry; reservations remain until authoritative cleanup. All 17 migrations through 0016 are immutable and applied. Run `pnpm db:check` to verify hashes. Latest migration SHA256 is `569599f36dc2807f8c52acda47b867805a7bb8bcfaeeb09a524afd0146e8e048`.

New `runtime-config.ts`, `runtime-identity.ts` and `image-runtime.ts` compose real Hetzner image transport, PKI, SSH/SFTP, boot renderer, verifier enrollment/runtime and publication. Hetzner startup now accepts only strict `image_factory` mode. API `/v1/*` returns 403; customer `/guest/enroll` and customer jobs are absent. Simulation remains default. Cloud/customer activation is still open.

`setup:runtime <absolute-directory>` preserves one bootstrap AES key and independent Ed25519 release key. Exclusive directory creation and owner-only files fail on partial/corrupt setup rather than replacing keys. Metadata binds both key identities. Public policy initially permits signing for 90 days and verification for 120 days. `readKeys` is now an async source at every publication/selection/allocation authorization. File policy reload supports immediate revocation and fails closed if unavailable. Private identity/CA/provisioner material and short-lived credential caches are process-local; restart API and worker after changing private material. Original keys are needed for recovery; a new CA needs new image inputs.

`createImageTasks` now accepts an `advance(build)` callback, letting runtime choose credential-free cleanup before constructing PKI ports. `cleanupImageBuild` needs only DB/provider/access store; delete-only `runImageEffect` accepts no spending ports. `image:build cleanup <build-id>` runs one direct recovery pass without runtime JSON, identity, PKI, source or pricing. Repeat or leave the worker running until provider absence and `accessRemovedAt` are confirmed. Cleanup planning avoids enqueuing another cancellation when state is already cleaning/cleaned, preserving Graphile retry evidence.

Runtime validates CA/manifest trust, active signer policy, full input tree and builder access before the first resource; remote upload rechecks inputs before transfer. It reloads policy again at VM boot rendering. No provider I/O occurs when constructing image runtime or advancing an unstarted admission. Catalog startup does perform read-only provider refresh.

Independent review found host-clock expiry could delete valid builds. Runtime/controller/builder cleanup, effect admission, renderer and verifier bootstrap/enrollment checks now use PostgreSQL time. Probe/runtime credential cache eviction also uses DB time. Pure plan tests can supply an instant; real expiry tests use five-second admissions and wait on PostgreSQL time. Scheduling uses DB time for durable start/delays. Host Date remains for process-local polling/cache housekeeping where it does not authorize deletion; continue checking concrete clock boundaries before customer activation.

## Verification in this continuation

`.local/runtime-focused-second.log`: 31 focused tests passed across identity/runtime/publication/scheduling. First full run `.local/runtime-check.log` passed typecheck/lint and 346/349 tests; three old expiry tests only mocked Node Date.now. They now wait for actual DB expiry. Second `.local/runtime-check-final.log` reached 348/349; the remaining expectation was old 401 token expiry versus actual 403 SQL active-build expiry. Corrected status while preserving claimed identity and sealed-token assertions.

Full check66763 exposed two real immediate-queue timing races and a fixture at the exact five-second price-skew allowance. Immediate enqueues now use SQL clock_timestamp; the fixture uses four seconds without relaxing the price policy. Focused21 cases passed. Final full check **7302**, `.local/runtime-check-verified.log`, passed **351 tests in33 files**, typecheck and lint in88.18s; exit0 confirmed6bfd3e. Full formatter50819 passed. Native enrollment **23398** passed actual Smallstep/OpenSSH/TLS with fixture provider observations; exit0 confirmed159ac1. Durable evidence is `docs/research/m1-image-runtime-verification.json`. No native guest input changes; the previous full builder smoke remains applicable. Public readiness is not native enrollment or live cloud proof.

Real development identity initialized by tool277165 and repeat setup verified by842a33. Directory `.local/runtime-identity`, public release key ID `6c4eb920bf75d1b753253c327082b3c1386136928830e50779b9efc2e1c1a481`. Preserve files, never print keys. `.local/runtime.json` is owner-only and points at this identity, `.local/guest-builds`, `.local/image-access` and existing local PKI. Caps are USD120000 VM micro-units and1000000 monthly snapshot micro-units with one open build.

Fresh Hetzner read-only evidence `.local/hetzner-runtime-check.json`,09:23:11Z, found zero servers/IPs/snapshots/firewalls/SSH keys. CPX12 nbg1/fsn1/hel1 available, USD27798 gross micro/hour including IPv4, Ubuntu24.04 x86 image161547269. Project remains agent-cloud-development15945891. Refresh before paid effects; historical prices are not admission authority. No build admitted or started in the development DB; tool717b40 found zero builds needing work.

## Active processes and public readiness

Use `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>`. Intended Node24; system26.5; pnpm runtime24.10.0. Target tests with `pnpm exec vitest run tests/file.test.ts`.

Persistent development PostgreSQL17 on127.0.0.1:55439, db/user agentcloud, password local-development-only. Smallstep CA at https://localhost:9449, projectagent-cloud-pki,256MiB/.5CPU, step0.30.6 and pinned step-ca0.30.2. Offline root/provisioner password outside CA mount; public trust in `.local/pki/public`. `.env` stays simulated. `.local/admin.credentials.json` and `.local/hcloud-token` are0600, never print or pass credentials in argv/guest metadata.

Existing simulated API **29181** at127.0.0.1:4319 and worker **75505** still run prior committed code. Separate image-factory API **46362** at127.0.0.1:4320 and image-only worker **82147** started from compiled code before the last credential-cache edit; rebuild/restart before any paid start. Logs `.local/image-factory-api.log` and `.local/image-factory-worker.log`. Inspect command/cwd before terminating owned processes. Image worker has completed empty reconciliation only.

Temporary Cloudflare quick tunnel **67714** points only to127.0.0.1:4320. Log `.local/runtime-tunnel.log`; public origin `https://main-improvements-perform-signal.trycloudflare.com`. Local binary `.local/tools/cloudflared-2026.8.3`, downloaded from official release and verified SHA256`40c9144d86df8937c5b43293a1f7d2d2107029aa74725023dd46b1b27154352f`. No Cloudflare account/domain setup. `--config /dev/null --no-autoupdate --protocol http2` isolates this test from user tunnel config. Stop it after the bounded drill or before an inactive handoff; do not leave paid work without reachable enrollment/worker.

Committed reproducible `scripts/check-runtime.ts` / `pnpm runtime:check` uses PUBLIC_URL. Actual public proof `.local/image-factory-public-check.json` passed health200, customer403, invalid image enrollment400 and absent guest enrollment404 at09:28:20Z. It does not prove a verifier can enroll from Hetzner or that SSH/SFTP can reach a VM. Public Cloudflare quick tunnels are development-only; official reference is linked in runtime documentation.

No native VM smoke is active. Follow exact VM ownership records and cleanup rules in AGENTS.md. Previous scratch `.local/ssh-smoke-xDhuI1` was fully removed. Latest selected immutable public input manifest remains `06e2977ed433a27bd2e91ac741a126cb791be99f41746966789329b37d296764`, version`dev-842538bfbd610382f2bcb728`, transfer checksum`1f4229064498676568d91be6743affe45dc1993083c94907389e82b91f2c0b3d`. Do not rebuild or alter the captured input tree during a drill.

Reviewer `/root/image_release_judge`, gpt-5.6-sol, is rechecking clock/cache corrections, docs and trail; report `docs/research/m1-image-runtime-review.md`. No transcript directory supplied; this is an artifact/trail review. No proactive agents except skill-required reviewer.

## Next concrete work

1. Full checks, formatting and native enrollment passed. Finish reviewer follow-up, commit/push this runtime checkpoint and verify exact CI. Keep errors and corrections in append-only DECISIONS.tsv.
2. Restart image-factory processes on final compiled code. Prepare one explicit low-cost Hetzner build using current inventory/pricing, actual public enrollment URL, current management IPv4 and immutable input tree. Before start verify local native PKI availability, input/CA matching and reachable public endpoint. Preserve exact owned build ID, caps and cleanup. The worker can create resources when started; no paid action has yet occurred.
3. Complete bounded builder/snapshot/verifier proof and cleanup, then wire mandatory customer release selection, enrollment/readiness, renewal and operator recovery before enabling customer mode. Continue M2–M7 access, deployment, routes, recipes, backups/restoration, self-hosting and affordable failure drills. Passing runtime checks is not end-to-end application deployment.

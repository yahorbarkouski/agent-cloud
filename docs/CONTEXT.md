# Current handoff context

Updated 2026-09-07. The full cloud goal remains active, excluding Stripe. M0 is complete; M1 and M2–M7 remain open. Work only in this standalone repository. Customers bring their own agents. Use TypeScript, ordinary Hetzner VMs, Compose and SSH. No benchmarks, warm pool, expensive plans or automatic fallback. Implementation, private pushes and bounded cheap cloud testing are authorized.

## Current checkpoint

Branch `yahor/agent-cloud`; private origin https://github.com/yahorbarkouski/agent-cloud.git. HEAD before the pending durability commit is `9913342643ae10f8dadbd400cd0a1270cf902ba0`, whose exact CI34107140639 passed351 tests and native PKI/SSH/enrollment. All17 immutable migrations0000–0016 are applied, latest hash569599f36dc2807f8c52acda47b867805a7bb8bcfaeeb09a524afd0146e8e048. No migrations changed.

The first actual Hetzner drill reached a snapshot and verifier. Cloud-init could not start its enrollment unit because installed guest files were empty. After cancelling publication, read-only rescue inspection found zero-byte bundle, manifests, trust, units and wrapper; the fsynced sanitation record survived. The adapter had used hard poweroff immediately after sanitation. Dirty-data loss is a supported inference, not a block-level sole-cause proof. No image was published. See `docs/research/m1-hetzner-image-drill.json`.

Build `bbb28cd4-aca1-4a94-87cf-364728bf6771` is fully cleaned at09:59:14.223Z, accessRemovedAt09:59:14.236Z. Actual provider inventory at10:00:18.634Z was zero servers/IPs/snapshots/firewalls/SSH keys. `.local/live-image-drill.json` and `.local/live-image-build.latest.json` preserve ownership. Rescue actions653805698256132/653805698256263 were recorded after worker stop and cancellation. No replacement was created during diagnosis.

## Verified correction

Guest sanitation now stops the random-seed writer before removal, requires an inactive writer and absent seed on every receipt/replay, then flushes the root filesystem using `sync --file-system /` after publishing its private record and before returning evidence. Error returns no receipt. The historical `power_off` journal command means desired off state; fresh transport submissions call graceful `/actions/shutdown`. An acknowledged action alone cannot authorize a snapshot; the controller requires actual off observation. No force-off fallback.

Final production check29401 passed352 tests/33files, typecheck/lint (82.57s test run), log `.local/snapshot-durability-seed-check.log`. Final fixture script typecheck/lint passed after its changes. Final native57208 passed exit0 with two distinct clone identities, injected flush failure/retry, seed service lifecycle, restricted SSH, unhealthy-runtime/reboot checks, token scans and complete cleanup. Log `.local/snapshot-durability-native-final.log`; all exact VM ownership records absent. No native VM smoke remains active.

Earlier flush-only native47000 passed; seed-native73407 later failed after successful enrollment because OrbStack reports lxc and skips the stock seed unit. Its exact clone/builder were deleted. The local-only `scripts/support/vm-seed.ts` fixture now clears that virtualization condition on source and clones, starts the actual unit before sanitation, and requires clone boot to reactivate it without manual start. This is unit-lifecycle proof under a documented environment override, not stock virtualization or identical production snapshot proof. Published inputs and Hetzner installation contain no override. Reviewer `/root/image_release_judge` accepted that limit; report `docs/research/m1-snapshot-durability-review.md`. Artifact/trail review only; no transcript directory supplied.

Evidence `docs/research/m1-snapshot-durability-verification.json` keeps intermediate and failed runs separately. Final docs/formatting and coherent commit/push are in progress. Exact-commit CI and a fresh positive provider lifecycle are still required.

## Prepared next drill

No cloud resources are active. Final build `de7d3f33-0f3e-4512-afc6-d163b1cd7359` is prepared only, not admitted or started. Record `.local/live-durability-final-drill.json`; input/prepared configs use prefix `.local/live-durability-final-build`. Keys `.local/image-access/de7d3f33-0f3e-4512-afc6-d163b1cd7359`. Earlier unadmitted d2522957 preparation was abandoned and its keys removed; do not reuse it.

Final immutable public input manifest `61b1e3972798d86ebba0d8d104912aa9a9158d98e1f91ef76bb3d3ac8ec62329`, version`dev-d71c36cede486069faa8e373`, input digest`d71c36cede486069faa8e373ba98dff20a11677d63660066b8db620bd601cc8d`, checksum`8632f4ea2d009b3a3cec885d607c7d6493567935ac79cdd1c65cff7a0f0476de`. Captured native selection and prepared cloud configuration match. Keep its `.local/guest-builds/<digest>` tree immutable.

Next drill must use current inventory/prices, current management IPv4, reachable HTTPS enrollment and the prepared cheap caps: CPX12 nbg1,90minutes, USD120000 VM/IP gross micros,1000000 monthly snapshot micros,40GB maximum, one open build. Complete retained publication, then explicitly cancel and confirm every provider resource absent plus accessRemovedAt. Never replace an unknown create. `node --env-file=.env scripts/image-build.ts cleanup <id>` is recovery without PKI/identity/source/pricing. Preserve ownership and keep worker/tunnel reachable until cleanup is complete.

## Local processes and private state

Use `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>`. Native TS tools importing src/\*.js require tsx: `node --env-file=.env --import tsx scripts/check-hetzner.ts`. Node24.10.0 is used by pnpm; system26.5. Target tests with `pnpm exec vitest run <paths>`.

PostgreSQL17 at127.0.0.1:55439, db/useragentcloud, local-development-only password. Smallstep CA https://localhost:9449,256MiB/.5CPU, pinned step0.30.6/step-ca0.30.2. `.env` stays simulated. `.local/admin.credentials.json`, `.local/hcloud-token`, runtime identity/PKI secrets are0600: never print or put in argv/guest data. Hetzner projectagent-cloud-development15945891; Default untouched.

Runtime `.local/runtime.json` is image_factory only, pointing to `.local/runtime-identity`, `.local/guest-builds`, `.local/image-access` and local PKI. Persistent bootstrap/release keys must survive; public release key ID6c4eb920bf75d1b753253c327082b3c1386136928830e50779b9efc2e1c1a481. Public policy reloads on every authorization; restart API/worker after private material changes.

Current image API88574 and worker36329 run the final compiled source on4320. Logs `.local/image-factory-api-durability.log` and `.local/image-factory-worker-durability.log`. Old API58603/worker84323 are stopped. Simulated API94916 and worker74632 remain on4319. Tunnel67714 at https://main-improvements-perform-signal.trycloudflare.com points to4320, log `.local/runtime-tunnel.log`. Public readiness and CA health passed after restart. `/healthz`200, `/v1/*`403, invalid `/image/enroll`400, `/guest/enroll`404. Stop temporary tunnel/image processes before an inactive handoff, after all paid work is cleaned.

## Next work

Finish documentation/format and reviewer evidence, commit/push durability correction, verify exact CI, then run and clean the prepared bounded Hetzner build. After positive image proof, wire mandatory customer release selection, enrollment/readiness, renewal and operator recovery before customer mode. Continue M2–M7 deployment/access/routes/recipes/backups/restore/self-hosting. Image success is not full application deployment; keep the goal active.

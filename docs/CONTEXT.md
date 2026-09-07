# Current handoff

Updated 2026-09-08. The original non-Stripe goal is active. The user authorizes implementation, private GitHub pushes and bounded cheap Hetzner tests. Deliver connected customer capabilities in one primary stream; follow AGENTS.md.

## What works

- Live internal deployment on cheap CPX12: frontend/backend/PostgreSQL, public HTTPS, disconnect/reconnect, logs, update preserving data, owned infrastructure cleanup. Source `4d2bffa` + `86b6b1b`, CI passed; `docs/reference-deployment-verification.json`. Historical URL is deleted.
- Customer delegation `055c2e8`, SSH/SFTP `45a3f8a`, durable commands `39c5922`, general Compose/recovery `37c2c32`: committed/pushed, Linux CI passed. Native CLI/API/worker/Smallstep/SSH/systemd/Docker paths passed; data persisted, revoked access closed, interrupted commands did not replay, failed Compose release recovered. These customer paths are not yet Hetzner verified. Evidence `.local/customer-access-native-5.log`, `.local/durable-runs-native-2.log`, `.local/compose-native-2.log`.
- GitHub sign-in `24707e4ce2f2d24db11c8655edad7cc17b068491`, CI `34161023325` passed. Real GitHub device flow with admitted zero-VM account, actual CLI/API identity, delegation/revocation/logout and cleanup passed in `.local/customer-login-live-1.log`. Operator admission/disable/renewal and pending-login recovery are implemented. No user sign-in action remains pending.
- Managed HTTPS routing is now **native verified**. `.local/hosting-native-2.log` exited 0: customer CLI route publication → worker/forced guest hosting SSH → separate public Caddy → mTLS guest proxy → frontend/backend/Postgres. Route changes, app update preserving count, spoofed-header overwrite, foreign-host denial, API outage, gateway restart, guest reboot, removal and exact fixture cleanup passed. No public ACME, custom public DNS or Hetzner routing proof yet.

Signed images, enrollment, lifecycle, renewal, exact cleanup and quota foundations remain working. Guest records are diagnostics, not billing/authorization evidence. Subsystem details live in `docs/architecture/` and the customer skill, not this handoff.

## Current checkpoint and next acceptance

Routing source checks and connected verification pass. Commit/push the checkpoint if it is still staged, then implement protected backup and isolated restore. The next customer outcome: capture the reference application's supported PostgreSQL data and declared files off-VM; restore into an isolated target without changing production; verify data and retention/authorization; retain recovery material after source destruction. Read original plan section 14 before selecting the smallest implementation. No backup implementation or object-storage credentials/bucket has been created yet.

Routing includes contracts/SDK/CLI/API/worker; domain TXT proofs; version CAS/replay; dedicated guest SSH principal; durable versioned guest bindings; authoritative public gateway snapshot/ack; distinct gateway credentials; separate renewable client-only CA provisioner; gateway certificate receipts, renewal and setup CLI. See `docs/architecture/https-routing.md` for setup and recovery semantics. Single public gateway controller only. Old images without the new guest hosting helper cannot host these routes.

Required routing checks passed: `pnpm check` verified typecheck/lint and 586 tests in 54 files, `.local/hosting-check-final.log`, exit 0. Final `format:check` passed `.local/hosting-format-final-2.log`; only lightweight formatting is needed after handoff-only edits. Main DB migration `0022_hosting_routes.sql` is applied; all 23 hashes match `.local/hosting-db-check.log`. Applied migration SQL is immutable. CI will run after the checkpoint push; no result is claimed yet.

Additional evidence: `.local/hosting-pki-smoke-2.log` real CA issue/renew/exact identity, exit 0; `.local/hosting-setup-cli.log` actual setup CLI against CA, retry preserved key/receipt, no issuer credential in runtime config, cleanup. Agent gateway tests: 41 pass including expiry recovery, uncertain issuance/renewal and receipt-to-PEM recovery. PKI helper tests: 5 pass. Do not rerun unchanged suites for reviews/docs.

Last booted image was `9ec179a171adecb103d418e83029b6b9e57095d3fa649edaa283f0046a83b9d2`, built in `.local/hosting-guest-build-2.log`. Native routing passed before the later narrow 2 MiB read/write-bound fix and equivalent formatting. That fix passed a real filesystem regression with 120 retained maximum-length hostnames, then pruning after acknowledgement: `.local/hosting-history-check.log`. Do not claim native boot of a later byte-identical image. Final separate guest build passed `.local/hosting-build-final.log`, digest `3b6a260621659480b828c25be2d4b74d6f93bcb6e5ec7ebb79854006be96ebca`. It was not natively booted. Never patch published/staged inputs.

## Concrete failures resolved

- Native run 1 rejected the newly installed restricted `agent-hosting` user because the SSH readiness allowlist still expected three users. Fixed checker/fixtures; focused checks passed. Failed VM deleted; run 2 passed.
- Lost Caddy reload reply could change a route before control acknowledgement. Guest now retains versioned bindings and gateway overwrites the selected version header. Prepared bindings are durable before reload; superseded command replay gives an explicit conflict. Five persisted attempts/version prevent endless reconciliation.
- Retained configuration could exceed the generic 64 KiB read limit and become unrepairable. Explicit 2 MiB reads/write bounds and >64 KiB pruning regression fixed this.
- mTLS guest proxy needs `strict_sni_host: false` because allocation SNI differs from public HTTP Host. Exact hostname/version matching stays required. The public gateway keeps strict SNI/Host matching.
- Gateway certificate issuance/renewal has its own client-only provisioner. Guest direct CA renewal remains disabled. Expired gateway recovery requires explicit operator `--new-attempt` with the original key; runtime keeps issuer credentials out.

The two bounded reviewer agents have stopped; no broad review is pending. `ci_docs_filter` owns no further work. Root must commit the integrated verified result.

## Remaining original scope

Protected backups/isolated restore; PostgreSQL/analytics recipes; remaining limits/usage/retention; dedicated command HTTP endpoints (current run/Compose CLI uses access API and guest SSH); self-hosting packaging; discoverable API/agent documentation; budget-appropriate operational failures; final customer live Hetzner deployment and cleanup. These checkpoints do not complete the product. Stripe stays excluded.

## Resources, commands and blockers

Repo `/Users/yahorbarkouski/Documents/ChatGPT/learning/agent-cloud`, branch `yahor/agent-cloud`, private origin `yahorbarkouski/agent-cloud`; Previous checkpoint is `24707e4`; use `git log -1` for the routing checkpoint after commit. Use `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>`. Relevant commands: `smoke:hosting`, `smoke:gateway-pki`, `setup:hosting-gateway`, `public-gateway`, `check`, `format:check`, `db:check`. VM smokes must run sequentially and retain exact ownership on failure.

**No paid or local VMs remain.** OrbStack inventory is empty; `.local/guest-image-machine.json` is absent. Both native routing VMs, public gateway processes/state and fixture databases/credentials are cleaned. No provider calls were made during routing. Hetzner development project `15945891` was last verified empty after the internal live scenario; subsequent work made no paid calls. Default project untouched; live reservations zero.

Keep local PostgreSQL container `agent-cloud-dev-postgres-1` on 55439 and CA `agent-cloud-pki-ca-1` on https://localhost:9449. CA was restarted to load hosting SSH policy and dedicated gateway provisioner. Preserve `.local/pki`, including the new private `gateway-provisioner-password`, and `.local/runtime-identity`; never print their contents or raw CA logs. Main simulated API PID 15176 and worker PID 15190 still have older loaded code; restart only when needed.

Intentional GitHub OAuth app: `Agent Cloud Development`, ID `3843400`, public client ID `Ov23liZVS2XqBNSrJQsi`; https://github.com/settings/applications/3843400. Secret `.local/github-oauth.json` mode 0600. Browser device login succeeded. Keep the app and authorization.

Hetzner token `.local/hcloud-token`. Recorded live caps: image VM/IP 120000 µUSD, customer VM/IP 60000 µUSD, snapshot monthly 1000000 µUSD. Internal run VM/IP estimate 83394 µUSD (~$0.0834), excluding storage, not an invoice. No object-storage budget/resource is recorded yet. Prefer local protocol/storage fixtures before any paid backup work.

No external dependency blocks current work. A diagnostic full process listing unexpectedly exposed ambient Anthropic, Braintrust and Apple app credentials in this task's tool output. User was informed that they should be rotated; do not reproduce values or imply rotation happened. AGENTS.md now forbids full process listings and specifies PID/command-name diagnostics. This incident does not block independent product work.

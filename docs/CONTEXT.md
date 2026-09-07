# Current handoff

Updated 2026-09-08. The original non-Stripe goal remains active. Implement connected customer capabilities in one primary stream, with bounded reviews and cheap, owned fixtures. Follow AGENTS.md.

## What works

- Internal reference deployment is Hetzner verified: cheap CPX12, frontend/backend/PostgreSQL, public HTTPS, disconnect/reconnect, logs, update preserving data, exact cleanup. Commits `4d2bffa` + `86b6b1b`; `docs/reference-deployment-verification.json`.
- Customer delegation `055c2e8`, SSH/SFTP `45a3f8a`, durable commands `39c5922`, Compose deployment/recovery `37c2c32` are committed, pushed and Linux CI verified. Native application paths verified persistence, revocation, interrupted commands and failed-release recovery. Evidence `.local/customer-access-native-5.log`, `.local/durable-runs-native-2.log`, `.local/compose-native-2.log`.
- GitHub sign-in `24707e4` passed real device login, identity/delegation/revocation/logout and cleanup in `.local/customer-login-live-1.log`. No user login action remains pending.
- Managed HTTPS routing `64768866fc6a717a1b55940f0e13a07943b8d059` passed Linux CI `34165430509`. Native CLI/API/worker/public Caddy/mTLS guest/application path passed route changes, persisted data, spoofed headers, foreign-host denial, API outage, gateway restart, guest reboot and cleanup. Evidence `.local/hosting-native-2.log`. Public ACME/custom public DNS and customer routing on Hetzner are not yet verified.

Subsystem details belong in `docs/architecture/` and the customer skill. These checkpoints do not complete the product.

## Current work and next acceptance

Manual protected backups and isolated restore are **native verified and staged for commit**. `.local/backup-native-5.log` exited 0: actual customer CLI/API/worker captured PostgreSQL 17 and a declared file into encrypted protected local MinIO, rotated the wrapping key, provisioned a separate VM, restored count `1` and identical files, rejected unfinished target access, replayed admission without a second target, preserved the source, destroyed both allocations with zero reservations, and retained the protected backup after source destruction. Both exact-owned physical VMs were deleted; OrbStack inventory is empty. This is not Hetzner storage proof.

Required checks for this staged checkpoint passed in `.local/backup-check-final.log` with typecheck/lint and 638 tests. Formatting passed `.local/backup-format-final-2.log` before the final README/handoff edits. `smoke:backup-store` was made portable with exact multiarch image pulls and added to code-change CI; its actual local smoke and focused checks passed. No provider calls. Main migration `0023_protected_backups.sql` is applied and immutable; all 24 migration hashes match `.local/backup-db-check.log`.

**Index boundary matters:** the manual backup checkpoint is staged. New **unstaged** source adds `compose promote`, existing-route movement and combined restore/public cutover verification. Commit only the staged manual capability plus its final documentation. Do not accidentally stage the unverified next capability.

Next acceptance: fence the source application's writes, promote the verified target's isolated network while preserving pinned images/volumes/loopback ports, move its existing HTTPS hostname to the new VM, verify count `1`, write count `2`, remove the route and destroy both VMs. `compose promote` reuses the durable Compose release worker with current-release CAS/replay and a distinct network; its bounded review found no blockers and 18 focused checks in `.local/restore-promotion-focused-2.log` passed after rebuilding contracts. `reference_security_review` owns only contracts/control/CLI hosting changes and focused tests for `route move`; no commit or staging. Root owns native fixture changes. Run typecheck, required checks and the combined native scenario after the source converges.

Latest installed/baseline image `ed9987fc593747a12556a7c960785f8c7bf56bf0280cef1bd140fdac505fe245` from `.local/backup-guest-build-4.log` passed native run 5. It predates promotion; build a new immutable bundle for the next run. Never patch installed or published inputs. Run 3 exposed missing shell quotes in the fixture Docker template; the corrected command, recovered HTTP data and customer file permissions were checked on its retained VM before cleanup. Run 4 safely refused reusing an enrolled guest after an interrupted cleanup; run 5 was fresh and passed. The guest restore parent is root-owned 0755; per-restore data remains private until published with captured file ownership/modes.

## Remaining scope

Explicit restore network promotion/public cutover; scheduled backups, retention/pruning, protected provider captures and purge/recovery operations; PostgreSQL/analytics recipes; remaining limits/usage; command HTTP endpoints where CLI currently uses access API and SSH; self-hosting packaging; discoverable API/agent instructions; budget-appropriate operational failures; final customer Hetzner deployment/update/recovery and verified cleanup. Stripe remains excluded.

## Resume commands and ownership

Repo `/Users/yahorbarkouski/Documents/ChatGPT/learning/agent-cloud`, branch `yahor/agent-cloud`, private origin `yahorbarkouski/agent-cloud`. Use `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>`. Relevant: `build:guest`, `smoke:backups`, `smoke:backup-store`, `check`, `format:check`, `db:migrate`, `db:check`. After a separate guest build, run the native scenario without rebuilding via `AGENT_CLOUD_ACCESS_SCENARIO=1 AGENT_CLOUD_BACKUP_SCENARIO=1 node node_modules/tsx/dist/cli.mjs scripts/smoke-guest.ts`. Capture logs under `.local/`. VM smokes are sequential. Do not repeat unchanged full suites for documentation or review.

**No paid or native VMs remain.** `.local/guest-image-machine.json` is absent; retained `.local/backup-target-*.json` records all say `deleted`. Native fixture databases, gateway/processes, MinIO containers and private scratch are cleaned. Hetzner development project `15945891` was last verified empty after the internal scenario; subsequent work made no paid calls. Default project untouched. On a future failure inspect the exact receipt and VM ID before cleanup. Do not start another VM smoke until cleanup completes.

Retain local PostgreSQL `agent-cloud-dev-postgres-1` on 55439 and CA `agent-cloud-pki-ca-1` at https://localhost:9449. CA restarted to load backup SSH template. Preserve `.local/pki` and `.local/runtime-identity`; never print private contents or raw CA logs. Main simulated API PID 15176 and worker PID 15190 have older loaded code; restart only when needed.

Retain GitHub OAuth app `Agent Cloud Development`, ID `3843400`, public client ID `Ov23liZVS2XqBNSrJQsi`, https://github.com/settings/applications/3843400. Secret `.local/github-oauth.json` is 0600. Hetzner token `.local/hcloud-token` is 0600. Live caps: image VM/IP 120000 µUSD; customer VM/IP 60000 µUSD; snapshot monthly 1000000 µUSD. Internal VM/IP estimate 83394 µUSD, excluding storage, not an invoice. No object-storage budget/resource recorded yet; confirm pricing and record a cheap cap before any paid storage fixture.

## Actual blockers

No external dependency blocks current implementation. A previous full process listing exposed ambient Anthropic, Braintrust and Apple app credentials in tool output. User was informed they should rotate them; rotation has not been verified. Never reproduce values or use full process listings. This incident does not block independent work.

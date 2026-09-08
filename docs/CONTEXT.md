# Current handoff

Updated 2026-09-08. The original non-Stripe goal remains active. Follow AGENTS.md; measure progress by working customer capabilities and keep one primary stream.

## What works

- Internal reference deployment is Hetzner verified: cheap CPX12, frontend/backend/PostgreSQL, public HTTPS, disconnect/reconnect, logs, update preserving data and exact cleanup. Commits `4d2bffa` + `86b6b1b`; `docs/reference-deployment-verification.json`.
- Delegation `055c2e8`, SSH/SFTP `45a3f8a`, durable commands `39c5922`, Compose deployment/recovery `37c2c32`, GitHub sign-in `24707e4`, HTTPS routing `6476886` and manual protected backups/isolated restore `00ea07f` are committed, pushed and Linux CI verified. GitHub used the real device flow; later application paths used native Ubuntu guests and local gateways/storage.
- Restore promotion and existing-hostname movement now pass the complete native customer CLI/API/worker scenario in `.local/restore-cutover-native-4.log`, exit 0. A separate VM restored PostgreSQL count `1` and identical files after wrapping-key rotation. The source was fenced, target network promoted, same public HTTPS hostname moved, count `2` written/read, route removed and both allocations destroyed with zero reservations. Protected backup remained available. Both physical VMs were deleted and OrbStack inventory is empty. This is not Hetzner Object Storage/customer restore proof.
- Required checks passed `.local/restore-cutover-check-admission-final.log`: typecheck, lint, 647 tests across 60 files. Formatting passed `.local/restore-cutover-format-admission-final.log` before final documentation. No unchanged comprehensive rerun is needed for these doc edits.

## Current work and next acceptance

Commit the verified promotion/movement checkpoint with its docs, then implement daily backup scheduling and retention handling through customer CLI/API/worker. Acceptance: a configured daily backup runs after the CLI disconnects, exposes its latest recovery point/failure, respects revocation and storage ceilings, and keeps the last good backup when a new capture fails. Retention/purge must preserve exact object ownership and isolate deletion credentials from ordinary workers.

A concrete independent task `/root/ci_docs_filter` is implementing PostgreSQL 17 and Umami recipes, owning only new `recipes/` files and `docs/recipes.md`. No commit requested. It is verifying generated secrets, default-admin replacement before HTTP, visitor instrumentation, resource limits, backup compatibility and exact Docker cleanup. Wait for its result and integrate without mixing unfinished work into the current checkpoint. Other agents are idle; bounded promotion and admission reviews found no blockers.

## Remaining scope

Daily scheduling, retention/pruning, protected provider captures, purge/recovery operations and provider automated backups; PostgreSQL/Umami recipes; remaining limits/usage; command HTTP endpoints where CLI currently uses access API plus SSH; self-hosting packaging; discoverable API/agent instructions; budget-appropriate operational failures; final customer Hetzner deploy/update/recovery and exact cleanup. Stripe excluded.

## Resume commands and evidence

Repo `/Users/yahorbarkouski/Documents/ChatGPT/learning/agent-cloud`, branch `yahor/agent-cloud`, private origin `yahorbarkouski/agent-cloud`. Use `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>`. Required checkpoints: `check`, `format:check` and relevant integration. Validate focused fixtures before broad checks or native/provider runs.

Native backup/cutover: build with `build:guest`, then `AGENT_CLOUD_ACCESS_SCENARIO=1 AGENT_CLOUD_BACKUP_SCENARIO=1 node node_modules/tsx/dist/cli.mjs scripts/smoke-guest.ts`. VM smokes are sequential. Current selected guest image `1093b9f46fef0b9015c987f11f3d30e3aa2eeea168a597e02acc7eec908aa27b`; never patch installed/published inputs. `smoke:backup-store` is portable and runs in code-change CI; latest committed Linux CI `34170770999` passed. Migration `0023_protected_backups.sql` is applied/immutable; all 24 hashes matched `.local/backup-db-check.log`.

Important native fixes: Caddy internal HTTP fixtures must disable automatic redirects; Docker normalizes an isolated network with empty `ipam:{}`. Promotion accepts that exact harmless field and rejects custom IPAM. The complete recovery flow exceeded the former 10-session rolling grant rate; admission now allows 30 per grant/60 per account per five minutes, retaining 4/20 simultaneous reservations and all credential/revocation rules. Focused admission/closure/concurrency/rate tests passed `.local/restore-cutover-admission-4.log`. Earlier failed fixtures were cleaned up by exact VM IDs before the successful run.

## Resources and blockers

**No paid or local VMs remain.** Successful source `agent-cloud-image-4c255884`, ID `01M1Z5WM9CCHFK75ERAJKVKSJM`, and its target were removed by the verified smoke. Source receipt is absent; all `.local/backup-target-*.json` receipts say `deleted`. The recipe task may own separate temporary Docker resources; use its exact receipts. No S3 bucket was created. Hetzner development project `15945891` was last verified empty after internal live proof; later work made no paid calls. Default project untouched.

Retain local PostgreSQL `agent-cloud-dev-postgres-1` on 55439 and CA `agent-cloud-pki-ca-1` on https://localhost:9449. Preserve `.local/pki` and `.local/runtime-identity`. Main simulated API PID 15176 and worker PID 15190 have older loaded code; restart only when needed. Keep raw CA logs and secret contents out of output.

Retain GitHub OAuth app `Agent Cloud Development`, ID `3843400`, public client ID `Ov23liZVS2XqBNSrJQsi`. `.local/github-oauth.json` and `.local/hcloud-token` are 0600. GitHub login is complete. Live caps: image VM/IP 120000 µUSD, customer VM/IP 60000 µUSD, snapshot monthly 1000000 µUSD. Internal VM/IP estimate 83394 µUSD excludes storage and is not an invoice. Obtain current S3 pricing and record a cheap cap before any paid storage fixture.

**Pending external action:** Hetzner browser session expired. An async question asks the user to log in again to tab 5, https://accounts.hetzner.com/login, for scoped S3 credential creation. Existing VM API token still works. This does not block independent implementation. No repeated GitHub login request is needed.

A prior full process listing exposed ambient Anthropic, Braintrust and Apple app credentials in tool output. User was told to rotate them; rotation is not verified. Never reproduce values or use full process/argument/environment dumps. Use PID/command-name diagnostics only.

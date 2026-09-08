# Current handoff

Updated 2026-09-08. The original non-Stripe product goal remains active. Follow AGENTS.md. GitHub sign-in is complete; do not ask for it again.

## What works

- The first internal reference application is **Hetzner verified**: cheap CPX12, frontend/backend/PostgreSQL, public HTTPS, disconnect/reconnect, logs, persistent update and exact cleanup. Commits `4d2bffa` + `86b6b1b`; `docs/reference-deployment-verification.json`.
- Customer GitHub login, delegation/revocation, SSH/SFTP, durable commands, Compose, managed/custom routing, protected encrypted backups, isolated restore, network promotion and hostname movement are committed. Actual GitHub device flow passed. Application proofs after the first internal deployment used native Ubuntu guests and local gateways/MinIO, not final customer Hetzner/public ACME/Object Storage.
- Daily captures continue after CLI exit. Native `.local/backup-schedules-native-1.log` verifies cron, encrypted capture, separate-VM restore, HTTPS cutover and persisted writes. PostgreSQL/Umami Docker recipe checks cover persistence, secure administrator bootstrap and visitor/events. Customer-site/native instrumentation remains.
- Retention/purge preserves seven newer successful UTC scheduled days and releases bytes only after exact-version absence. Operator blocked-upload recovery uses read-only reconciliation, including expired protection, and never repeats PUT. Commits `4ab2ee7` + `d40644b`; latter Linux CI34177467718 passed. `.local/backup-retention-smoke-1.log` and `.local/backup-recovery-smoke-2.log` passed actual CLI/encryption/MinIO/separate operator/cleanup.
- Scratch-capacity guard is committed/pushed `340819c`. Capture/restore refuse transfer without spending attempts, then resume the same work when space returns. Required check676 tests passed; actual `.local/backup-space-smoke-1.log` passed. No guest-image change.

## Current checkpoint

Usage plus self-host packaging is verified and ready to commit. `acld usage` reports account/grant limits, VM rates and retained backup bytes. `usage history` exposes project-scoped, transactional reservation changes with honest migration-time baselines. No invoice calculation. Migration0026 is applied to the main DB; all27 hashes matched `.local/usage-db-check.log`. Applied SQL is immutable.

Actual `.local/usage-smoke-1.log` passed CLI/API/Graphile create→power-off→resize→destroy, rates9600→14400→0 and exact cleanup. `.local/usage-backup-smoke-1.log` passed actual encrypted MinIO capture→retained usage→purge pending→zero bytes→cleanup. Focused lifecycle/pricing/migration tests passed; a wrapped-error assertion was fixed and `.local/usage-focused-2.log` passed. Bounded usage review found no blocker. Required `.local/usage-selfhost-check-final-3.log` passed typecheck/lint and683 tests/64 files. Formatting passed `.local/usage-selfhost-format-final-3.log`. Actual final CLI path passed `.local/usage-smoke-final.log`. Initial lint/format and wrapped-error assertion failures were fixed; no unchanged comprehensive rerun is needed. Commit verified files and push.

Self-host packaging provides a pinned non-root runtime image, loopback simulated Compose, explicit internal bootstrap and private configuration mounts. Agent `ci_docs_filter` delivered six files and two actual packaging proofs, final project `acld-self-host-bbf7906f` cleaned containers/network/volumes/image tags. Final proof includes migration0026, packaged CLI create/restart/reconnect/destroy, rejected public/unscoped bootstrap and unauthenticated access. Bounded packaging review found two blockers, both fixed: sync the password file and directory on fresh/retried initialization, and refuse pre-existing project/image resources before any mutation or cleanup. Four collision protocol cases passed. Rebuilt-image `.local/selfhost-final-4.log` passed with exact cleanup of project `acld-self-host-ea396a1b-7b43-4e91-9b7c-4e84e5d4a948`. `smoke:self-host` and code-only CI step are integrated. This is local simulated packaging; real provider/customer networking and control disaster recovery remain.

Next acceptance: restore the self-host control database and matching private identity/configuration into a separate isolated installation, verify existing identity/machine/reservation history through the packaged CLI, reject incomplete/corrupt backups without touching the source, and verify cleanup. Keep provider workers fenced while restoring old control state. Then customer-site recipes and final provider scenario.

## Remaining scope

Protected Hetzner S3/IAM; provider automated VM backups; customer-site recipe verification; self-host installation with customer runtime/public gateways, control/key disaster recovery; remaining agent/API discoverability and budget-appropriate operational failures; final authorized customer Hetzner deploy/update/restore/cutover/revocation/usage/cleanup. Stripe excluded. Original plan `docs/archive/original-plan.md`; no architecture restart.

## Resume and evidence

Repo `/Users/yahorbarkouski/Documents/ChatGPT/learning/agent-cloud`, branch `yahor/agent-cloud`, private origin `yahorbarkouski/agent-cloud`. Use `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>`. Coherent source checkpoints require `check`, `format:check`, relevant integrations. Do not rerun unchanged comprehensive suites for docs/reviews.

Local provider-free checks: `smoke:usage`, `smoke:self-host`, `smoke:backup-retention`, `smoke:backup-recovery`, `smoke:backup-store`. Native: `build:guest`, then `AGENT_CLOUD_ACCESS_SCENARIO=1 AGENT_CLOUD_BACKUP_SCENARIO=1 node node_modules/tsx/dist/cli.mjs scripts/smoke-guest.ts`; add `AGENT_CLOUD_BACKUP_SCHEDULE_SCENARIO=1` for cron. Native VM smokes are sequential. Selected guest image `1093b9f46fef0b9015c987f11f3d30e3aa2eeea168a597e02acc7eec908aa27b`.

## Resources and blockers

No paid resources or task-owned VMs/recipe/S3/self-host fixtures remain at the reported cleanup checkpoints. No Hetzner bucket exists. Dev project15945891 was last verified empty after internal live proof; subsequent work made no paid calls. Default project untouched. Root usage fixtures cleaned exact databases/private files; Docker build caches remain.

Preserve local PG `agent-cloud-dev-postgres-1` localhost55439, CA `agent-cloud-pki-ca-1` https://localhost:9449, `.local/pki`, `.local/runtime-identity`. Main API PID15176/worker15190 have older loaded code. GitHub app `Agent Cloud Development` ID3843400, public client ID `Ov23liZVS2XqBNSrJQsi`; `.local/github-oauth.json` and `.local/hcloud-token` are0600.

Caps: image VM/IP120000µUSD, customer VM/IP60000µUSD, snapshot monthly1000000µUSD. Prior internal VM/IP estimate83394µUSD excludes storage and is not an invoice. No S3 cap recorded; obtain current price and a cheap cap before paid storage.

**External action pending:** Hetzner browser tab5 is signed out at accounts.hetzner.com/login. An async login question is already pending for scoped S3 credential creation. Existing VM API token works. Continue independent work; do not repeat the question. GitHub login is complete.

Earlier full process output exposed ambient Anthropic, Braintrust and Apple app credentials. User was told to rotate; rotation unverified. Never reproduce values or full process/argument/environment dumps. Use PID/command-name diagnostics only.

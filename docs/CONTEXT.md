# Current handoff

Updated 2026-09-08. Original non-Stripe goal remains active. Follow AGENTS.md and the customer-capability loop. GitHub sign-in is complete; do not ask for it again.

## What works

- First internal reference deployment is **Hetzner verified**: cheap CPX12, frontend/backend/PostgreSQL, public HTTPS, disconnect/reconnect, logs, persistent update and exact cleanup. Commits `4d2bffa` + `86b6b1b`; `docs/reference-deployment-verification.json`.
- Customer GitHub sign-in, delegated access/revocation, SSH/SFTP, durable commands, Compose, managed/custom-hostname routing, encrypted protected backups, isolated restore, network promotion and hostname movement are committed. Actual GitHub device flow passed. Application paths after the first internal deployment used native Ubuntu guests and local gateways/MinIO. See subsystem docs for guarantees; this is not final customer Hetzner/public ACME/Object Storage proof.
- Daily capture and PostgreSQL/Umami recipes are committed/pushed as `70722a43a4be02b5b145033a1f2e39f6b7d1a6d6`, Linux CI `34174591463` passed. `.local/backup-schedules-native-1.log` passed real cron after CLI exit, encrypted capture, separate-VM restore of count1/files, HTTPS cutover, new persisted write and exact cleanup. Daily timing/outage/authorization policy has DB tests; it did not wait24 hours. Recipe Docker checks passed persistence, secure admin bootstrap, visitor/event collection and isolated startup. Customer-site/native recipe verification remains.

## Current checkpoint and next outcome

Retention/purge is implemented and verified across CLI/API/DB and a separate operator process. Explicit `backup purge --id ... --allow-data-loss` stops new restores, waits for Object Lock and survives later grant revocation as accepted cleanup. Only confirmed exact-version absence releases storage. Unfinished restores pin backups until completion or target destruction. Optional automatic pruning keeps seven newer successful UTC days of the same scheduled recipe; failed captures/manual points do not count. Old ineligible recipes cannot starve eligible candidates. Deletion credentials are separate from API/capture/guest credentials.

Local full path passed `.local/backup-retention-smoke-1.log`, exit0: actual CLI capture, real encryption and MinIO, CLI purge/exit, separately spawned retention process without writer/reader/keyring files, retention enforcement, exact-version absence, reconnect/inspect, zero reserved bytes and fixture cleanup. Short Object Lock interval is fixture-only, not production7-day proof. Adapter MinIO tests also prove extension handling, retained other versions, and denied writer deletion/deleter write/bypass/unversioned deletion. MinIO needs both delete actions conditioned on nonempty/non-null lowercase `s3:versionid`; shared fixture policy lives in `packages/backup-store/src/fixture/policies.ts`. Hetzner policy remains unverified.

Required checks passed `.local/backup-purges-check-final-2.log`: typecheck/lint and671 tests across62 files. Focused fixes passed `.local/backup-purges-focused-4.log`; formatting passed `.local/backup-purges-format-final-3.log` plus the final typed-query formatting check. Migration0025 is applied and all26 hashes matched `.local/backup-purges-db-check.log`. The final regression prevents ordinary capture reconciliation from requeueing a purged source with old staging state. Its queue assertion waits for Graphile's asynchronous completion. A bounded independent security/concurrency review found no blockers. Do not repeat broad reviews or unchanged comprehensive suites. This verified checkpoint is ready to commit/push; no fixture resources remain.

Next customer outcome after this checkpoint: recover a blocked upload by verifying its recorded object version, including after the protection interval expires, without repeating its PUT or losing storage ownership; diagnose/refuse insufficient control-worker scratch before data transfer. Then continue the remaining product scope.

## Remaining scope

Protected provider captures and IAM; backup operator recovery and provider automated VM backups; native/customer-site recipe verification; remaining resource limits and explainable usage intervals; HTTP command endpoints where CLI currently uses API plus SSH; self-host installation/upgrade/control-database recovery and independent key recovery; discoverable API/agent instructions; budget-appropriate operational failures; final authorized customer Hetzner deploy/update/restore/cutover/revocation and cleanup. Stripe excluded. Original plan is `docs/archive/original-plan.md`; do not restart its architecture work.

## Resume commands

Repo `/Users/yahorbarkouski/Documents/ChatGPT/learning/agent-cloud`, branch `yahor/agent-cloud`, private origin `yahorbarkouski/agent-cloud`. Use `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>`. Checkpoints require `check`, `format:check` and relevant integrations. New `smoke:backup-retention` runs without VMs; `smoke:backup-store` verifies storage permissions. Both run only for code changes in CI.

For native backup/cutover: `build:guest`, then `AGENT_CLOUD_ACCESS_SCENARIO=1 AGENT_CLOUD_BACKUP_SCENARIO=1 node node_modules/tsx/dist/cli.mjs scripts/smoke-guest.ts`. Add `AGENT_CLOUD_BACKUP_SCHEDULE_SCENARIO=1` for real cron. VM smokes are sequential. Selected image `1093b9f46fef0b9015c987f11f3d30e3aa2eeea168a597e02acc7eec908aa27b`; do not patch published inputs. Main DB has0025 applied and26 hashes matched `.local/backup-purges-db-check.log`. Applied SQL is immutable.

## Resources and blockers

**No paid or local VMs, recipe resources or S3 fixture containers remain.** All backup-target receipts say deleted, source receipt absent, OrbStack inventory previously empty. Local retention smoke cleaned its exact container/database/private files. No Hetzner bucket was created. Dev project15945891 was last verified empty after live internal proof; subsequent work made no paid calls. Default untouched.

Retain local PG `agent-cloud-dev-postgres-1` on55439 and CA `agent-cloud-pki-ca-1` on https://localhost:9449, `.local/pki`, `.local/runtime-identity`. API PID15176/worker15190 have older loaded code; restart only when needed. Never print raw CA logs. Retain GitHub OAuth app `Agent Cloud Development`, ID3843400, public client ID `Ov23liZVS2XqBNSrJQsi`; `.local/github-oauth.json` and `.local/hcloud-token` are0600.

Caps: image VM/IP120000µUSD, customer VM/IP60000µUSD, snapshot monthly1000000µUSD. Prior internal VM/IP estimate83394µUSD excludes storage and is not an invoice. No S3 cap is recorded: obtain current pricing and record a cheap cap before paid storage.

**External action pending:** Hetzner browser tab5 remains signed out at https://accounts.hetzner.com/login, reconfirmed this checkpoint. An async login question is already pending for scoped S3 credential creation. Existing VM API token works. Continue independent work; do not repeat the question or request GitHub login.

Earlier, a full process listing exposed ambient Anthropic, Braintrust and Apple app credentials in tool output. The user was told to rotate them; rotation is unverified. Never reproduce values or use full process/argument/environment dumps. Use PID/command-name diagnostics only.

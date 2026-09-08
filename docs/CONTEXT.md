# Current handoff

Updated 2026-09-08. Continue the original non-Stripe product goal on `yahor/agent-cloud`. Follow AGENTS.md and working customer acceptance scenarios. GitHub sign-in is complete; do not ask again. The goal tool's old blocked state is stale, and implementation is progressing.

## What works

- **Hetzner live:** internal CLI deployment on cheap CPX12, frontend/backend/PostgreSQL, public HTTPS, disconnect/reconnect, logs, persistent update and exact VM/IP/snapshot/firewall/SSH cleanup. Commits `4d2bffa` + `86b6b1b`; `docs/reference-deployment-verification.json`.
- **Customer access:** actual GitHub device login. Delegation/revocation, SSH/SFTP, durable commands, Compose updates/recovery and managed/custom routes are implemented. Native Ubuntu checks verified revocation/API-outage closure, guest restart and persisted application updates. Later proofs use local gateways, not final customer Hetzner/public ACME.
- **Application data:** encrypted exact-version Object Lock backups, daily capture, retention/purge, uncertain-upload recovery, low-scratch pause/resume, isolated PostgreSQL/file restore, promotion and HTTPS route movement. Actual local MinIO/native proof includes count1 restored and count2 written after cutover. No Hetzner bucket has been provisioned.
- **Recipes/analytics:** production CLI bundles versioned PostgreSQL/Umami recipes and works offline outside the checkout. Actual Docker persistence/security/isolation verified. Native fresh Chrome clicked the reference frontend and produced a pageview/visitor/event. Commits `1d43b8f` and `12fd956`; `.local/recipes-packaged-smoke-2.log`, `.local/analytics-native-4.log`.
- **Usage:** CLI/API limits, active VM rates, retained bytes and append-only reservation history. Actual create→power-off→resize→destroy and purge→zero verified. Commit `3cc16e2`; migration0026 applied to main DB and all27 migration hashes match `.local/usage-db-check.log`.
- **Self-host recovery:** pinned non-root runtime, persistent loopback simulated installation, isolated dump/private-identity restore and encrypted pgBackRest WAL/PITR. `9d21763cfd38ecbc73ca7db9176cc3a24809e5f7` passed Linux CI34184253818. Native Docker proof `.local/selfhost-wal-4.log` restored a selected earlier CLI project, excluded a later write, preserved source/key/repository and checked missing/wrong keys, competing lock, nonempty-target refusal and exact cleanup. This does not prove off-host storage or real-provider fencing.

## Current capability checkpoint

Backup wrapping-key recovery is committed/pushed as `2dedb88`; Linux CI34185706847 passed. Native `.local/backup-key-native-1.log` restored the same UUID after six missing-key and six wrong-key refusals without consuming preparation attempts, then verified PostgreSQL/files, HTTPS cutover and exact cleanup. Its required check passed698 tests/68 files. Matching private key recovery resumes pending `waitingFor: backup_key`; submitted SQL never replays.

Provider daily VM backups are verified and ready to commit. New catalog offers include the current quoted surcharge before admission, while historical offers/reservations retain their rates. Separate `enable_backup` uses the durable journal and exact ownership. Readiness requires observed enablement. Unknown replies never resubmit; exact VM absence during cleanup settles an unresolved enable without freeing the reservation before IP cleanup. Resize enables only after confirmed type change, so a costlier historical VM cannot accrue an unreserved surcharge. Bounded review found that ordering bug; the corrected delta has no remaining review blockers.

Local evidence: `.local/provider-backup-lifecycle-4.log`23 tests passed, `.local/provider-backup-runtime-3.log`8 passed, catalog and transport fixtures passed. Actual CLI/API/Graphile `.local/provider-backup-cli-2.log` passed create→backups enabled→power-off→resize→destroy with synthetic rates11280→17040→0. `.local/provider-backup-cleanup-1.log` passed lost-create-reply cancellation and exact VM/IP cleanup. Required `.local/provider-backup-check-1.log` passed typecheck/lint and713 tests/68 files in182.25s. `.local/provider-backup-format-1.log` passed. Commit/push this verified change; no rerun for handoff edits. No provider mutations or migration changes. Live backup activation remains pending.

## Next acceptance and remaining scope

Commit the verified checkpoint. Next connected outcome: an installed CLI supplies the same agent instructions without a checkout and reports configured service capabilities through authenticated API/SDK, without implying a supported command grants permission or that a configured service is healthy. Reuse existing recipe packaging and scope enforcement.

Remaining original scope: protected Hetzner S3/IAM; live provider automated backups; self-host installation with customer runtime/public gateways; independent provider/signing/bootstrap credential recovery and external inventory/revocation reconciliation before restored mutators; agent/API discoverability/OpenAPI/llms/distribution; operational failure drills; final authorized customer Hetzner deploy/update/restore/cutover/revocation/usage/cleanup. Stripe is excluded. Old DB restore also restores stale intents/leases/revocations: keep real mutators externally fenced until reconciliation. Do not turn the simulated quickstart into a public internal-access shortcut.

## Resume commands and durable lessons

Repo `/Users/yahorbarkouski/Documents/ChatGPT/learning/agent-cloud`, private origin `yahorbarkouski/agent-cloud`. Use `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>`. Source checkpoints require `check`, `format:check` and relevant integrations. Native backup: after `build:guest`, `AGENT_CLOUD_ACCESS_SCENARIO=1 AGENT_CLOUD_BACKUP_SCENARIO=1 node node_modules/tsx/dist/cli.mjs scripts/smoke-guest.ts`. Native VM smokes run sequentially. `smoke:self-host-wal` includes base packaging, dump restore and WAL once; `smoke:recipes` exercises packaged CLI/Docker recipes.

Package production output in a temporary allowlisted workspace: pnpm12 deploy can prune root devDependencies. Fixtures must use OS tmpdir when no ignored `.local` exists. Applied migrations and published images are immutable. Keep docs in their subsystem files, historical evidence in git/archive, and this as the only current handoff. All subagents are idle.

## Resources, caps and blockers

No active task-owned native VM or backup store remains. Source `agent-cloud-image-32107b88` and restore `agent-cloud-backup-3ea58b36-0583-48b9-ae88-120c53e6c408` were removed and absence independently verified. Historical backup-target receipts marked deleted are not active resources. No paid resources were created. WAL/recipe fixtures and image tags were cleaned; shared caches remain.

Preserve local PG `agent-cloud-dev-postgres-1` localhost55439, CA `agent-cloud-pki-ca-1` https://localhost:9449, `.local/pki`, `.local/runtime-identity`. Main API15176/worker15190 have older loaded code. Live published guest input remains1093b9f46fef0b9015c987f11f3d30e3aa2eeea168a597e02acc7eec908aa27b. This native run built bde4feb6ec154416502ac8269a25980af2f0b499ef31656856fbd19ef858f012 without modifying the prior artifact.

Hetzner dev project15945891, `.local/hcloud-token`0600; default project untouched. GitHub app Agent Cloud Development ID3843400, public clientID`Ov23liZVS2XqBNSrJQsi`, `.local/github-oauth.json`0600. Caps: image VM/IP120000µUSD, customer VM/IP60000µUSD, snapshot monthly1000000µUSD. Prior internal VM/IP estimate83394µUSD excludes storage and is not an invoice. No S3 cap yet; get an actual current hourly quote before paid storage. September8 public page showed€6.49/month excludingVAT but blank hourly field. Runtime S3 keys must be in a separate project from bucket/admin with exact cross-project principal policy.

External blockers: Hetzner browser session expired, and CUA reconfirmed the Mac locked this turn. One login and one unlock question are already pending; do not repeat. VM API token works. Browser MCP disconnected; do not repeatedly retry. GitHub is already logged in. Earlier full process output exposed ambient Anthropic/Braintrust/Apple credentials; user was told to rotate, status unverified. Never reproduce values or full process arguments/environment; use PID/command-name diagnostics only.

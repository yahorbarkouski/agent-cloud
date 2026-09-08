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

Fenced control recovery is verified and ready to commit. Migration0027 adds external control generations, immutable recovery receipts and exact `control_closed` attempt resolution. Real-provider API, worker and operator mutations require a ready generation and a live shared database lease. Losing that lease terminates the process. Offline recovery uses an exclusive lease, and recovery transactions run on that exact session. The bounded review's two blockers, ungated operator repairs and admitted work surviving lease loss, are fixed and verified.

The packaged `control-recover` command creates private generations, initializes empty databases, revokes all restored grants and customer admission anchors, disables schedules, verifies current ownership and retained backup/image receipts, explicitly closes externally settled abandoned operations and resumes only with matching state/inventory digests. It performs no provider mutations. See `docs/control-recovery.md` for commands, attestations and supported states.

Evidence from this source:

- `.local/control-recovery-check-4.log`: required typecheck/lint/build and743 tests in74 files passed. `.local/control-recovery-format-2.log`: format passed; subsequent fixture/docs edits were scoped-formatted.
- `.local/control-recovery-dump-smoke-2.log`: actual pg_dump/pg_restore, source revocation after checkpoint, restored API/worker refusal, operator CLI begin/resume, stale token401, retained project, fresh internal fixture CLI access and exact cleanup.
- `.local/control-recovery-packaged-1.log`: production container/CLI, host-loopback API, trusted HTTPS gateway/mTLS/restart/outage, isolated dump restore and WAL recovery passed with exact cleanup. No provider proof.
- `.local/control-recovery-tests-6.log`: actual operator CLI, delayed provider in a separate database, unchanged live ownership, private files and exclusive transaction connection loss passed. Gate11 and actual API/worker lease-loss tests passed. Real HTTP-decoded image verification rejects ownership changes, reappeared tombstones and signing-key revocation.
- `.local/control-recovery-backup-retention-1.log` and `-backup-repair-1.log`: actual MinIO read-only retained-backup verification, missing reader refusal, retention and uncertain-upload repair passed with exact cleanup.
- `.local/control-recovery-uncertain-attempt-1.log`: an unknown create attempt closed only through an immutable receipt; forged closure was rejected. Separate control/provider databases and private files were cleaned.

Prior commit `a902bad09427d460ba53bbef6b03140bd87a88ee`, packaged HTTPS gateway and host-loopback API, passed Linux CI34189304610. The prior provider-backup and offline skill/capability commits are also green.

## Next acceptance and remaining scope

Commit/push the verified recovery capability without repeating unchanged suites. Then let a customer install a standalone CLI release outside the repository, verify its checksum, read bundled agent instructions/recipes and use authenticated commands. Reuse `scripts/support/packaged-cli.mjs`; do not add a packaging framework or publish private history blindly.

Remaining original scope: protected Hetzner S3/IAM; live provider automated backups; full self-host customer configuration; independent provider/signing/bootstrap credential recovery; OpenAPI/llms/distribution; operational failure drills; final authorized customer Hetzner deploy/update/restore/cutover/revocation/usage/cleanup. Pending SQL/route/image recovery may still need dedicated reconciliation. A new generation cannot fence processes using an independent old database; external credential/process fencing and delayed-request accounting remain required. Stripe is excluded; simulated/internal access stays private.

## Resume commands and durable lessons

Repo `/Users/yahorbarkouski/Documents/ChatGPT/learning/agent-cloud`, private origin `yahorbarkouski/agent-cloud`. Use `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>`. Source checkpoints require `check`, `format:check` and relevant integrations. Native backup: after `build:guest`, `AGENT_CLOUD_ACCESS_SCENARIO=1 AGENT_CLOUD_BACKUP_SCENARIO=1 node node_modules/tsx/dist/cli.mjs scripts/smoke-guest.ts`. Native VM smokes run sequentially. `smoke:self-host-wal` includes base packaging, dump restore and WAL once; `smoke:recipes` exercises packaged CLI/Docker recipes.

Package production output in a temporary allowlisted workspace: pnpm12 deploy can prune root devDependencies. Fixtures must use OS tmpdir when no ignored `.local` exists. Applied migrations and published images are immutable. Keep docs in their subsystem files, historical evidence in git/archive, and this as the only current handoff. All three bounded helpers/reviewers are finished and idle. Continue in the primary implementation stream.

## Resources, caps and blockers

No active task-owned native VM or backup store remains. Source `agent-cloud-image-32107b88` and restore `agent-cloud-backup-3ea58b36-0583-48b9-ae88-120c53e6c408` were removed and absence independently verified. Historical backup-target receipts marked deleted are not active resources. No paid resources were created. Control-recovery isolated databases/files were cleaned after tests, dump smoke and the uncertain-attempt smoke. Migration0027 is not applied to the preserved main DB. WAL/recipe fixtures and image tags were cleaned; shared caches remain.

Preserve local PG `agent-cloud-dev-postgres-1` localhost55439, CA `agent-cloud-pki-ca-1` https://localhost:9449, `.local/pki`, `.local/runtime-identity`. Main API15176/worker15190 have older loaded code. Live published guest input remains1093b9f46fef0b9015c987f11f3d30e3aa2eeea168a597e02acc7eec908aa27b. This native run built bde4feb6ec154416502ac8269a25980af2f0b499ef31656856fbd19ef858f012 without modifying the prior artifact.

Hetzner dev project15945891, `.local/hcloud-token`0600; default project untouched. GitHub app Agent Cloud Development ID3843400, public clientID`Ov23liZVS2XqBNSrJQsi`, `.local/github-oauth.json`0600. Caps: image VM/IP120000µUSD, customer VM/IP60000µUSD, snapshot monthly1000000µUSD. Prior internal VM/IP estimate83394µUSD excludes storage and is not an invoice. No S3 cap yet; get an actual current hourly quote before paid storage. September8 public page showed€6.49/month excludingVAT but blank hourly field. Runtime S3 keys must be in a separate project from bucket/admin with exact cross-project principal policy.

External blockers: Hetzner browser session expired, and CUA reconfirmed the Mac locked this turn. One login and one unlock question are already pending; do not repeat. VM API token works. Browser MCP disconnected; do not repeatedly retry. GitHub is already logged in. Earlier full process output exposed ambient Anthropic/Braintrust/Apple credentials; user was told to rotate, status unverified. Never reproduce values or full process arguments/environment; use PID/command-name diagnostics only.

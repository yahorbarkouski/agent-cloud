# Current handoff

Updated 2026-09-08. Work on `yahor/agent-cloud` under AGENTS.md. The original TypeScript/Hetzner/Compose cloud goal remains, with no Stripe. GitHub sign-in is complete; do not ask again. The goal tool's old blocked state is stale.

## Current task and next acceptance

The user asked whether they can deploy their own project today. The answer is **not through a ready customer service yet**. They do not want local scenarios presented as the product. They then requested a comprehensive remaining plan. [COMPLETION_PLAN.md](COMPLETION_PLAN.md), based on source `705101e`, now owns delivery order, acceptance scenarios, files and budgets. This checkpoint changes documentation only; no runtime or infrastructure work was performed. Historical detail remains in git and subsystem docs.

**Next:** milestone 1 of that plan. Publish an ordinary `examples/full-stack` context independent of test helpers; connect repeatable customer installation; configure a stable public endpoint and current retained guest image; then use real GitHub/customer authority to deploy, disconnect, reconnect, update persistent data and verify cleanup. Deliver actual customer commands and HTTPS when usable. S3 is later and must not block first deployment.

Concrete gaps: customer Compose lacks restart policy and CA setup; API/worker mount the same control-secret directory; installation ordering/configuration remain manual; the current Compose example copies guestctl from `.local`. Fix these connected gaps using existing foundations. Prepare a continuing host/demo quote and lifetime because only disposable test caps are recorded. Domain choice and independent recovery-copy destination are also unresolved.

## What works and evidence

- **Real internal Hetzner app:** `4d2bffa` + `86b6b1b`, [verification record](reference-deployment-verification.json). CPX12 ran frontend/backend/PostgreSQL, public HTTPS, disconnect/reconnect, logs and persistent update. Exact cleanup passed. Its URL is historical and snapshot deleted.
- **Customer operations:** real GitHub device login, delegation/revocation, SSH/SFTP, durable commands, Compose recovery, limits/usage and managed/custom routing. Native proofs cover access closure, restarts and persistence. Final customer Hetzner/public ACME evidence remains.
- **Recipes/data:** PostgreSQL/Umami, browser pageview/event, encrypted versioned Object Lock backups, daily capture, retention/purge, uncertain upload/scratch recovery, isolated PostgreSQL/file restore and HTTPS cutover. Native MinIO restored count1 and persisted count2 after promotion. Actual Hetzner storage permissions and automated VM backups remain unverified.
- **Control recovery:** `6a74f2e`, CI34192771022. External generation/execution leases, revoked restored authority, exact inventory/image/backup checks and explicit delayed-effect closure. Dump/WAL/lease-loss proofs passed. [Recovery guide](control-recovery.md) owns unsupported states and external fencing requirements. Migration0027 ran in isolated fixtures only.
- **Customer packaging:** `da9af343aa45c18482898e4292864fbf344c9be2`, admission/disable/renew and customer Compose/gateways. `.local/selfhost-customer-packaged-2.log` records packaged CLI/operator, fixture login, trusted HTTPS/mTLS, Host isolation, outage/restart, dump/WAL and cleanup. `-recipes-1.log` and `-ssh-smoke-1.log` record recipes/native trust. Provider is simulated and CA private in packaging proof.
- **Signed public CLI:** [cli-v0.1.0](https://github.com/yahorbarkouski/agent-cloud/releases/tag/cli-v0.1.0) at `ce9a0d8264ab3b10352fe82860e150fd8e75832c`; source CI34198076587 and release CI34199568712 passed. `.local/public-cli-download-verification-1.log` proves anonymous download, attestations, tamper/ref refusal, extraction outside checkout, offline skill/recipes and cleanup. This is not a hosted-service launch.

Published tags/assets are immutable. Public artifact `.local/releases/cli-0.1.0-github-ce9a0d8/agent-cloud-cli-0.1.0.tar.gz` is1355571bytes, SHA256`9b47030be2db94369f691891bedd69c6f274a8f5a497a853931ee72a6fd3c4da`; its directory includes release.json, SHA256SUMS and provenance.jsonl. Older `.local/releases/cli-0.1.0-44f1662/` is unsigned and distinct. Public source has Apache-2.0, security reporting, original licenses and reviewed secret-scan evidence.

## Remaining work and commands

Follow the completion plan: real customer deployment; operations/limits; domains/analytics; protected Hetzner source-loss restore; platform recovery/self-hosting; fresh-agent acceptance from public artifacts. Independent CA/bootstrap/backup-key recovery, monitoring and supported pending-state reconciliation need operating evidence. Never call a required blocked capability complete.

Use `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>`. Source checkpoints require `check`, `format:check` and relevant integration. Existing engineering checks include `node scripts/self-host-smoke.mjs --restore --wal --gateway` and `node --import tsx recipes/smoke.mjs`. Native scenarios use `scripts/smoke-guest.ts` flags and run sequentially. Never build concurrently in one checkout. Production-only packaging uses an isolated copy; `pnpm deploy` can prune source development dependencies. New fixtures must work without ignored state. Documentation changes use formatting/link checks and lightweight CI, not unchanged source suites.

Durable lessons: wait for an actual SSH banner before trust scanning; check fixture ownership before expensive packaging and immediately before mutation; private scratch needs correct UID/tmpfs permissions; DB leases do not fence processes using an independent old database. Detailed fixes/reviews remain in git and subsystem docs. Previous helpers are idle; `.local/worktrees/http-discovery-mtsa70fb` is retained and inactive.

## Resources, costs and cleanup

No paid resources were created by this plan. Last recorded inventory `.local/hetzner-customer-read-check-2026-09-08.json` at06:53:23Z reports zero servers/IPs/snapshots/firewalls/SSH keys. Recheck before paid execution. Previous owned Docker/native fixtures were cleaned; shared caches remain.

Preserve development PG `agent-cloud-dev-postgres-1` localhost55439, CA `agent-cloud-pki-ca-1` https://localhost:9449, `.local/pki` and `.local/runtime-identity`. API15176/worker15190 were running older code at the prior checkpoint; recheck PID/command-name only. Main DB is through0026. Do not silently migrate it or replace its identity.

Owner-only credentials: `.local/hcloud-token` for Hetzner dev project15945891; `.local/github-oauth.json` for GitHub app Agent Cloud Development ID3843400. Default Hetzner project remains untouched. Never print credentials or put them in arguments/logs. Public guest input1093b9f46fef0b9015c987f11f3d30e3aa2eeea168a597e02acc7eec908aa27b is immutable. Native bundlebde4feb6ec154416502ac8269a25980af2f0b499ef31656856fbd19ef858f012 is not provider-published. Fresh bounded publication is needed because old snapshots were deleted.

Caps: image VM/IP120000µUSD; customer VM/IP60000µUSD; snapshot monthly1000000µUSD. Preserve admission semantics and refresh quotes including automated backups. Prior internal VM/IP estimate83394µUSD excludes storage and is not an invoice. No ongoing host/demo budget/lifetime, S3 cap/billing-minimum quote, permanent domain or verified independent recovery destination is recorded. Prepare concrete choices before asking only for missing spend/domain decisions. Routine work remains authorized. Locked object versions can require delayed cleanup and retained cost tracking.

## External blockers

Prior execution observed expired Hetzner console and locked Mac; this plan did not recheck. One login/unlock request was pending; avoid repeated questions/browser loops. VM API worked. GitHub sign-in is complete, but fresh device authorization still needs customer approval in GitHub. Continue independent example/install work while dependent setup is unavailable.

No storage bucket is recorded. Runtime storage keys need a different project from bucket/admin keys and exact scoped principals; separate files alone do not enforce IAM. S3 blocks protected recovery, not first deployment.

Previously exposed unrelated ambient credentials were reported; rotation remains unverified. Never reproduce values or full process arguments/environment. Source history/tracked blobs were scanned before publication; exact reviewed false positives are in `.gitleaksignore`. Private tools/evidence remain under `.local`.

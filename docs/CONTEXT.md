# Current handoff context

Updated: 2026-09-06. Active goal: implement the researched agent-cloud plan end to end with TypeScript, excluding Stripe. M0 works locally; the overall goal is not complete.

## Constraints and repository

Low infrastructure budget; no expensive VMs or provider benchmarking. User is completing Hetzner verification. Customers bring their own Codex/Claude Code; do not build an AI agent. Keep instructions, progress, decisions, and this summary current.

Repository: `/Users/yahorbarkouski/Documents/ChatGPT/learning/agent-cloud`, branch `yahor/agent-cloud`. It is a standalone Git repository within an unrelated parent workspace. Work and commit only here. Private GitHub repository `yahorbarkouski/agent-cloud` has been created and configured as origin. First push/CI verification is pending. Check Git for current commit state; do not create a second remote repository.

The original comprehensive research plan lives at `docs/archive/original-plan.md`. `docs/architecture/overview.md` describes the chosen lifecycle design; three independent sketches and their judgment are preserved in `docs/research/`.

## Implemented and verified

- Six TypeScript workspace packages/apps: contracts, db, Hetzner transport, SDK, control API/worker, CLI.
- Drizzle PostgreSQL schema/migrations with tenant composite keys, unique idempotency, one active operation/allocation per machine, and an effect journal.
- Account/global admission serialization, version checks, quota reservations, explicit data-loss deletion, durable Graphile jobs.
- Persistent simulator with lost responses, delayed visibility, failed actions, duplicate creates, and timeout-before-submit scenarios.
- Worker reconciliation avoids blind create retries. Revocation blocks fresh effects; reconciliation continues after submitted effects.
- Scoped opaque credentials, parent delegation bounds and revocation, token hashes, bootstrap, local token CLI login.
- JSON CLI supports project/machine operations, waiting, catalog, and usage. Lifecycle flags use `--expected-version` because Commander reserves `--version`.
- 19 isolated PostgreSQL integration tests passed. Full build, tooling/test typecheck, strict ESLint passed. CLI → API → PostgreSQL → Graphile smoke passed through creation and deletion. All smoke allocations were cleaned up; usage returned zero reservations. The custom 0001 migration structurally guards attempt history, and a subprocess crash verifies recovery after provider commit before the journal response write.
- Customer skill exists at `skills/agent-cloud/SKILL.md` and passed the skill validator. Apache 2.0 license and a pinned GitHub Actions workflow exist. Remote CI has not yet been verified.

## Runtime and commands

- Intended Node 24 LTS; `.nvmrc` selects 24. System node is 26.5.0; pnpm/tsx may select an installed Node 24 runtime. Node 24.16.0 also exists under the user's nvm versions.
- Use `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>` because the global pnpm is older. Dependencies are installed. Frozen install passed.
- `pnpm check`, `pnpm format:check`, `pnpm smoke:local` are documented in README. Tests create and drop unique databases; they do not truncate the development database itself.
- Docker Compose project `agent-cloud-dev`, PostgreSQL on `127.0.0.1:55439`, healthy. Dedicated database volume; do not touch other local Docker databases.
- `.env` exists and points at local simulated services. `.local/admin.credentials.json` exists with mode 0600; never print its token. Bootstrap project ID is available from the file or CLI.
- API listens at `127.0.0.1:4319`, started via exec session 93239. Worker started via session 11801. They may need restarting to load the latest compiled files; inspect only these owned processes before stopping them.
- Skill validation: `uv run --no-project --with PyYAML==6.0.3 python /Users/yahorbarkouski/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/agent-cloud`. System and bundled Python lacked PyYAML; the isolated uv invocation passed.

## External status and remaining work

Hetzner browser variable `hetznerTab` may still exist in the persistent CUA session, tab 1 / browser 1. Last page: `https://accounts.hetzner.com/account/verification`. User was handling credit-card/document verification. No project, provider token, VM, bucket, or paid resource has been created. Recheck once useful; local work remains available regardless.

Live API/worker activation intentionally refuses `PROVIDER=hetzner`. The transport currently supports create/actions/get/list using the official current API schema, but is not a complete provisioner and has no live validation yet. API notes and spec hash are in `docs/research/hetzner-contract-notes.md`.

Next concrete work:

1. Finish the M0 Git/CI checkpoint, preserving precise evidence in progress/decisions. Verify any newly created remote CI instead of merely adding a workflow.
2. Complete M1: current account prices/availability and reservation ceilings, ownership and cleanup of Primary IPs, guest bootstrap/template, real host/guest verification, and operator resolution of unknown/duplicate effects. Do not enable live creates before these are wired.
3. M2: browser/device auth without Stripe, CLI grant management, SSH CA/gateway/access revocation. Existing local token login is a development path.
4. M3–M7: transfers and durable runs, Compose deploy, HTTPS routes, database/analytics recipes, off-VM backups and proven restores, self-hosting, operational metrics and bounded failure drills.

Known limits to address: pagination is currently a fixed 100 records in several API lists; failed resize reservations are retained conservatively; unknown reboot cannot be proven from a running server; duplicate-resource operator handling is not implemented; live guest readiness is pending even after provider allocation. Never report these as solved by simulated tests.

## Working rules

Keep the goal active while useful work remains. Do not ask for credentials or approval already authorized. Do not rent expensive infrastructure. The show-me-your-work skill requires a different-model review and an Attention note before handback. Reviewer `m0_checkpoint_review` (`gpt-5.6-sol`) completed the M0 review and follow-up: attempt immutability was strengthened in SQL, the crash test now uses a real exiting subprocess, and evidence/status pointers were corrected. No material regression remained in the bounded reviewed behavior. Re-review later implementation before final handback.

Maintain `docs/DECISIONS.tsv` append-only. Original temporary package-version evidence was copied to `docs/research/package-versions.json`; a later row records that durable location. The pnpm optional-peer resolution issue was fixed with `--fix-lockfile`, not a manual symlink. Resume from the actual Git and process state; do not redo completed research or M0 work.

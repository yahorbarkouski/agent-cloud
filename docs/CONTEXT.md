# Current handoff context

Updated: 2026-09-06. Active goal: implement the researched agent-cloud plan end to end with TypeScript, excluding Stripe. M0 works locally; the overall goal is not complete.

## Constraints and repository

Low infrastructure budget; no expensive VMs or provider benchmarking. Hetzner verification and project token setup are complete. Customers bring their own Codex/Claude Code; do not build an AI agent. Keep instructions, progress, decisions, and this summary current.

Repository: `/Users/yahorbarkouski/Documents/ChatGPT/learning/agent-cloud`, working branch `yahor/agent-cloud`. It is a standalone Git repository within an unrelated parent workspace. Work and commit only here. Private GitHub repository `yahorbarkouski/agent-cloud` is origin. Initial implementation commit `bbd33adfa34a76169a81e9f1def35e21aefcdae1` is pushed on main; local main and the working branch both pointed to it at that checkpoint. CI run 34056857441 passed on Linux. Later progress/context edits may be uncommitted; inspect Git rather than recreating a repository or repeating the initial commit.

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
- Customer skill exists at `skills/agent-cloud/SKILL.md` and passed the skill validator. Apache 2.0 license and a pinned GitHub Actions workflow exist. The initial remote CI passed frozen install, full checks, and formatting on Linux.

## Runtime and commands

- Intended Node 24 LTS; `.nvmrc` selects 24. System node is 26.5.0; pnpm/tsx may select an installed Node 24 runtime. Node 24.16.0 also exists under the user's nvm versions.
- Use `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>` because the global pnpm is older. Dependencies are installed. Frozen install passed.
- `pnpm check`, `pnpm format:check`, `pnpm smoke:local` are documented in README. Tests create and drop unique databases; they do not truncate the development database itself.
- Docker Compose project `agent-cloud-dev`, PostgreSQL on `127.0.0.1:55439`, healthy. Dedicated database volume; do not touch other local Docker databases.
- `.env` exists and points at local simulated services. `.local/admin.credentials.json` exists with mode 0600; never print its token. Bootstrap project ID is available from the file or CLI.
- API listens at `127.0.0.1:4319`, started via exec session 52577. Worker started via session 45180. They may need restarting to load the latest compiled files; inspect only these owned processes before stopping them.
- Skill validation: `uv run --no-project --with PyYAML==6.0.3 python /Users/yahorbarkouski/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/agent-cloud`. System and bundled Python lacked PyYAML; the isolated uv invocation passed.

## External status and remaining work

Hetzner setup succeeded. Project `agent-cloud-development` ID `15945891` exists; Default was untouched. Read/write API token `agent-cloud-local-development` is saved at ignored `.local/hcloud-token`, mode 0600. Read it directly from disk inside API code; never print it or put it into command arguments. Authenticated GET servers/primary_ips/pricing/server_types succeeded: zero servers and zero Primary IPs. No VM, bucket, or paid resource has been created.

The live account catalog uses **USD with 23% VAT**, and CX23/CX33/CX43 reported unavailable across fsn1/nbg1/hel1. The EUR-only model has now been replaced with explicit currency and account gross offer prices, including IPv4. `pnpm hetzner:check` performs authenticated read-only verification. At 20:40 UTC, explicitly configured CPX12 was available at USD 0.027798/hour including IPv4 and VAT. No fallback is automatic. Raw catalog evidence is stored privately at `.local/hetzner-catalog.json` (contains no token); inspect its pagination before treating it as a complete offer inventory.

CUA binding `hetznerTab` is tab 1 / browser 2, now at the project's security/tokens page. Token creation and its Read/Write list entry were verified. It was captured into private REPL variables with output redaction and transferred through a one-use localhost form; those secret variables were cleared and the form tab closed. `scripts/receive-hetzner-token.ts` implements that bounded loopback intake and is committed in the pricing checkpoint. It passed the actual browser flow and isolated fake-token tests for overlapping submissions, host/origin/body checks, overwrite refusal, token redaction, and file mode. `pnpm setup:hetzner` starts it. The helper session 75535 has exited successfully. Browser export was unsupported and Terminal computer-use access was blocked, so neither was used to transfer the credential. The unrelated node_repl runtime did not share the CUA binding. No approval remains pending.

Live API/worker activation intentionally refuses `PROVIDER=hetzner`. Catalog transport reads are verified against the live account. Create/actions/get/list mutations remain unverified, and the transport is not a complete provisioner. API notes and spec hash are in `docs/research/hetzner-contract-notes.md`.

Next concrete work:

1. Pricing checkpoint df11926d54d23cee06f21f9705c83fdb3cba5345 is committed and pushed on yahor/agent-cloud; CI run 34059794570 passed on Linux. Final migrations, restart, smoke, and formatting passed. Legacy queued/interrupted upgrade tests pass. That checkpoint includes currency contracts/migrations 0002–0004, pinned offers, gross live catalog/transport reads, credential intake and read-only setup commands, 41 passing tests, and docs. Full check/format/skill validation and CLI smoke passed after local migration. All paid resources remain absent.
2. Complete M1: money/catalog and pinned admission offers are implemented and verified, but the live API still needs a catalog refresh loop; ensure offer architecture matches the guest image; track and clean Primary IPs with journaled effects; build/verify the guest template and host identity; implement operator resolution of unknown/duplicate effects. Do not enable live creates before these are wired. Provider credentials are now available, so account verification is no longer a blocker.
3. M2: browser/device auth without Stripe, CLI grant management, SSH CA/gateway/access revocation. Existing local token login is a development path.
4. M3–M7: transfers and durable runs, Compose deploy, HTTPS routes, database/analytics recipes, off-VM backups and proven restores, self-hosting, operational metrics and bounded failure drills.

Known limits to address: pagination is currently a fixed 100 records in several API lists; failed resize reservations are retained conservatively; unknown reboot cannot be proven from a running server; duplicate-resource operator handling is not implemented; live guest readiness is pending even after provider allocation. Never report these as solved by simulated tests.

## Working rules

Keep the goal active while useful work remains. Do not ask for credentials or approval already authorized. Do not rent expensive infrastructure. The show-me-your-work skill requires a different-model review and an Attention note before handback. Reviewer `m0_checkpoint_review` (`gpt-5.6-sol`) completed the M0 review and follow-up: attempt immutability was strengthened in SQL, the crash test now uses a real exiting subprocess, and evidence/status pointers were corrected. No material regression remained in the bounded reviewed behavior. Re-review later implementation before final handback.

Maintain `docs/DECISIONS.tsv` append-only. Original temporary package-version evidence was copied to `docs/research/package-versions.json`; a later row records that durable location. The pnpm optional-peer resolution issue was fixed with `--fix-lockfile`, not a manual symlink. Resume from the actual Git and process state; do not redo completed research or M0 work.

Latest checkpoint details: `priceBasis` distinguishes account_gross, simulated, and legacy_estimate offers. Migration 0003 removes currency defaults and enforces account/allocation currency agreement; 0004 labels old estimates. Workers now take explicit deployment limits, lock global admission before the account, and recheck current limits before fresh create/resize. Accepted create type/region/ownership mismatches block with reason `provider_resource_mismatch`, retaining cost reservations and using 30-second reconciliation. `m1_pricing_review` (gpt-5.6-sol) completed its report in docs/research/m1-pricing-review.md; no hard issue remained in its bounded review after fixes. Its remaining coverage note is the untested legacy resize migration branch; no transcript was available to independently audit earlier browser/smoke claims. Latest check passes 41 tests. The current live artifact at docs/research/hetzner-catalog-check-2026-09-06.json is from 20:56:14 UTC and schema-valid. Migrations 0003–0004 were applied locally and API/worker restarted. The latest CLI smoke passed creation/deletion/cleanup for vm_7f5d518f-1e8d-4425-8840-6dab13c63d2e.

Next resource design is recorded in docs/architecture/provider-resources.md. It is a sketch, not an implemented feature. Prefer explicitly owned IPv4 creation before VM creation, auto_delete plus verified absence, a generalized resource receipt in the existing journal, compensation only when VM non-submission/absence is established, and explicit legacy handling for old simulator allocations. The official spec exposes two parser requirements: Primary IP deletion is bodyless HTTP 204, and unassigned IPs may say assignee_type=unassigned despite an outdated enum. Do not add IP mutations until their journal/cleanup path is ready. The reviewer noted legacy resize migration coverage is still absent, so add that when extending the lifecycle.

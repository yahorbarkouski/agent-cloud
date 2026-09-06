# Current handoff context

Updated 2026-09-06. The active goal is the full agent-operated cloud in `docs/archive/original-plan.md`, excluding Stripe. M0 is complete; M1 resource lifecycle is implemented locally. The overall goal remains active and substantial product work remains.

## Constraints and repository

Customers bring Codex or Claude Code. Build their cloud interface, not an AI agent. Use TypeScript, ordinary Linux VMs, Docker Compose, SSH, and Hetzner. Keep cloud costs low, avoid expensive fallback types and provider benchmarking, and maintain AGENTS.md, customer skills, decisions, progress, and this summary. Useful authorized work must continue without repeatedly asking for approval.

Repository: `/Users/yahorbarkouski/Documents/ChatGPT/learning/agent-cloud`, a standalone Git repository inside an unrelated parent workspace. Only work here. Branch `yahor/agent-cloud`, private origin `https://github.com/yahorbarkouski/agent-cloud.git`. Main has initial M0 commit `bbd33ad`; pricing checkpoint `df11926` and resource sketch `a5572db` are pushed on the working branch. Their Linux CI passed. Resource checkpoint `8f416ba194bab4b31229426873d4a91e1e2c253e` is also committed and pushed; Linux CI run `34061962745` passed frozen installation, all checks, and formatting. Inspect current Git state for later documentation or implementation changes rather than repeating setup.

## Implemented and verified

Six workspace packages/apps contain Zod contracts, PostgreSQL/Drizzle persistence, Hetzner transport, SDK, Hono API/Graphile worker, and JSON CLI. Tenant isolation, opaque hashed credentials, scoped delegation/revocation, idempotency, optimistic versions, admission locks, and full allocation reservations work locally. Persist intent before provider mutation; an unknown create is never blindly resubmitted.

Money has explicit currency and integer micro-units. Gross catalog offers include VM plus IPv4 and pin exact type/region/architecture/prices. Fresh billable effects recheck current prices, deployment/account/grant limits, and authorization. Submitted effects reconcile without current capacity. Legacy estimates retain provenance. Live catalog GETs are verified, but the running API still lacks its catalog refresh loop.

The resource slice adds an explicitly owned IPv4 before VM creation and records both under the allocation. New allocations use `managed_ipv4`; old simulator allocations use `legacy`. `advance-operation.ts` selects effects; `effect-journal.ts` journals and resolves them; `resource-journal.ts` stores ownership and observed absence. Provider receipts use `{kind,id}` resource references. Attempt commands/receipts are immutable; resolutions change once. An unused IP can be compensated only when VM non-submission or definitive rejection is established. Destroy releases the allocation only after VM and IP absence. Unknown outcomes, duplicates, foreign labels, or conflicting IDs remain blocked with their reservation retained.

Migration 0005 upgrades legacy receipts/progress and backfills server resources. Its unique key precedes its dependent foreign key. Tests migrate queued, prepared, accepted, and completed creates and resizes from the actual M0 schema and continue without replaying submitted effects.

Latest full `pnpm check` passed **67 tests in eight files**, build/typecheck, and strict lint. Focused tests cover lost responses, delayed/duplicate IP inventory, revocation between IP/VM effects, rejected versus uncertain VM creation, cleanup after auto-delete fails, conflicting receipts, immutable resolution, tenant keys, and real subprocess exits after VM/IP commits. Transport fixtures cover HTTP 204, assignment consistency, paging, and uncertainty. These are simulated or mocked results, not live VM proof.

Migration 0005 applied locally with the old API/worker stopped. Restarted services passed CLI → API → PostgreSQL → Graphile create/inspect/destroy. Smoke machine `vm_3605fdec-d4f6-4fce-b77c-f53fb4173928` has a retired allocation, zero live owned resources, zero simulator VMs and zero simulator IPs. Customer skill validation passed. Check `docs/PROGRESS.md` for final formatting, commit and CI evidence.

## Runtime and commands

- Intended Node 24 LTS; `.nvmrc` selects 24. System Node is 26.5.0; pnpm may select installed Node 24.
- Use `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>` because global pnpm is older. Dependencies are installed.
- `pnpm check`, `pnpm format:check`, `pnpm smoke:local`. Tests create/drop unique databases on the dedicated PostgreSQL service and do not truncate the development DB.
- Docker Compose project `agent-cloud-dev`, PostgreSQL on `127.0.0.1:55439`, dedicated volume. Do not touch unrelated databases.
- Ignored `.env` selects the simulated provider. Ignored `.local/admin.credentials.json` contains the local CLI root token, mode 0600. Never print it.
- API `127.0.0.1:4319`, exec session 66250; worker session 53871. Both run compiled resource checkpoint code. Inspect their command/cwd before restarting only these owned processes.
- Skill validation: `uv run --no-project --with PyYAML==6.0.3 python /Users/yahorbarkouski/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/agent-cloud`.

## Hetzner state

Verification and credential setup are complete. Dedicated project `agent-cloud-development`, ID `15945891`; Default is untouched. Read/write token `agent-cloud-local-development` is in ignored `.local/hcloud-token`, mode 0600. Read directly from disk; never print it, put it in command arguments, or send it to a customer guest. The supported one-use loopback intake is `scripts/receive-hetzner-token.ts`; no token regeneration is needed.

No paid resource has been created. Read-only servers/primary_ips checks returned zero. The account uses USD with 23% VAT. At the last inspection, CX23/CX33/CX43 were unavailable in fsn1/nbg1/hel1; explicitly configured CPX12 was available at gross USD 0.027798/hour including IPv4. Refresh before any bounded live test, with a cleanup deadline. Do not silently substitute a more expensive type.

Read-only check: `PROVIDER_CURRENCY=USD HCLOUD_SERVER_TYPE_SMALL=cpx12 pnpm hetzner:check`. Durable catalog evidence: `docs/research/hetzner-catalog-check-2026-09-06.json`. Official API notes: `docs/research/hetzner-contract-notes.md`; saved spec `/tmp/agent-cloud-hetzner-openapi.json`. IP delete is bodyless 204. Current documented unassigned IPs have type `unassigned` and null ID; contradictory assignment states are rejected. Transport mutation tests have not touched Hetzner.

CUA previously had `hetznerTab`, tab 1/browser 2, at project security/tokens. Credential transfer completed without printing it; private REPL variables were cleared. No browser action or credential approval is pending.

## Next concrete work

1. The reviewed resource checkpoint `8f416ba` is committed and pushed, and CI run `34061962745` passed. Final formatting and customer-skill validation also passed. Resume M1 implementation rather than repeating the resource checkpoint. The detailed report and configured `gpt-5.6-sol` trail audit are in `docs/research/m1-resources-review.md`.
2. Finish M1. Build guest cloud-init/image configuration, host identity and readiness verification; wire runtime catalog snapshots; implement explicit operator resolution for unknown/duplicate effects. Live API/worker activation intentionally rejects `PROVIDER=hetzner` until these paths and bounded spending/cleanup are ready. Verification is no longer externally blocked by the account.
3. M2: device/browser auth without Stripe, CLI grant management, SSH CA/gateway and access revocation. Existing local token login is the development path.
4. M3: transfers, durable command runs, Compose deploy, Caddy HTTPS routes/domains. M4: PostgreSQL/analytics recipes, off-VM backup and proven isolated restore. M5: usage/alerts/traffic and other cost limits. M6: self-hosting. M7: low-cost failure drills and end-to-end proof.

Known limits remain explicit: unknown empty inventory is inconclusive, duplicate-resource operator handling is unfinished, unknown reboot cannot be inferred from a running server, failed resize holds its larger reservation, several API lists cap at 100 records, hourly VM/IP limits do not bound traffic or total lifetime spend. Live guest readiness stays pending.

## Review and preservation

Keep `docs/DECISIONS.tsv` append-only. The show-me-your-work skill requires a different-model audit and an Attention note before handback. The resource review found no remaining high-confidence correctness/security issue after post-submit stale-history cleanup and contradictory assignment parsing were fixed. No transcript directory is available; do not claim an independent transcript audit. Preserve the distinction between local test evidence and live provider evidence.

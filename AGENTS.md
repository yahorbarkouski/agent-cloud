# Working on agent-cloud

Build an open-source cloud operated by customers' existing coding agents. We do not build a coding agent. Read `README.md`, then `docs/CONTEXT.md` for the current state and next work. `docs/PROGRESS.md` owns milestone status; `docs/architecture/overview.md` will own the implemented design. Historical plans under `docs/archive/` are reference material, not claims that features exist.

## Current constraints

- TypeScript, ordinary Linux VMs, Docker Compose, SSH, and Hetzner. Stripe and payment integration are deferred until the product works.
- Keep costs low. Use local services and a simulated provider first. Do not rent servers until Hetzner verification is complete and a bounded inexpensive test is ready. No expensive plans, warm pool, or load generation against shared provider infrastructure.
- All external resources must have recorded ownership, a cleanup path, and explicit spending limits. Never put provider credentials in a customer guest.
- Keep all work inside this repository. The parent workspace contains unrelated projects.

## Code and verification

- `packages/contracts` owns schemas; `packages/db` owns schema/migrations; `apps/control` owns auth, admission and worker behavior; `packages/sdk` and `apps/cli` expose it. `packages/hetzner` is transport only until live activation checks are complete.
- Run `pnpm check` and `pnpm format:check` for a checkpoint. With local API/worker running, `pnpm smoke:local` exercises the real CLI and must finish cleanup. Tests create and remove isolated databases; never point cleanup code at unrelated databases.

- Model states with discriminated unions. Derive transport types from validated schemas. Validate external input at boundaries; do not use `any`, non-null assertions, or unchecked casts.
- Keep business decisions separate from provider I/O. Persist intent before external mutation. An unknown provider outcome must be reconciled before another create attempt.
- Tenant authorization, idempotency, concurrency, revocation, and actual restore checks are required behavior. Tests must exercise failure modes rather than mirror implementation.
- Prefer a small number of explicit modules to speculative frameworks. Runtime capabilities and documentation must reflect implemented behavior.
- Document runnable verification commands in `README.md` as they become available. Never report a live integration as verified when it only passed with a fake provider.
- Do not log credentials, customer commands, or application secrets. Use dedicated development credentials and scoped CI secrets.

## Preserve working context

- After each substantive checkpoint, update `docs/PROGRESS.md` with evidence and remaining work.
- Before a handoff or context compaction, update `docs/CONTEXT.md` with current branch, commands, results, blockers, and the next concrete step. Keep it short and current.
- Record durable decisions and lessons in the architecture docs and `docs/DECISIONS.tsv`. Prefer an enforced invariant or regression check over repeating a warning.
- Update this file when the workflow or repository map changes. Keep the customer skill under `skills/` consistent with the CLI; it must never claim to grant authorization.
- Commit coherent verified milestones on `yahor/agent-cloud`. Commit messages and PR descriptions describe product behavior and verification plainly.

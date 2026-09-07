# Working on agent-cloud

Build an open-source cloud operated through customers' existing agents. We do not build an agent. Use TypeScript, ordinary Hetzner VMs, Docker Compose and a CLI/API. Keep the frontend minimal. Stripe is excluded.

Read `docs/CONTEXT.md` for the single current handoff. Architecture documentation owns subsystem details; `docs/archive/` preserves history, not current status.

## Development loop

- Measure progress by a working customer capability. State the observable acceptance condition, inspect the relevant code, make the smallest sound connected change, exercise the actual CLI/API/application, fix failures and commit verified work.
- Reuse working foundations. Do not expand prerequisites, speculative frameworks or future-scale infrastructure. Record non-blocking improvements briefly and continue.
- Use one primary implementation stream. Delegate only concrete independent work that shortens delivery. Review consequential authorization, concurrency and recovery changes with a bounded scope and stopping condition.
- Run focused tests while iterating and required integration checks when code, dependencies, configuration or a concrete concern changes. Do not rerun comprehensive suites for documentation, another review, or an unchanged fast-forward. Documentation-only CI uses lightweight checks.
- Keep this file concise. Update the single handoff at meaningful checkpoints and before compaction with what works, what remains, the next acceptance scenario, commands/evidence, owned resources/cleanup and actual blockers. Put durable subsystem lessons beside that subsystem.

## Boundaries and guarantees

- Work only in this repository. The parent workspace contains unrelated projects.
- Contracts own schemas, DB owns immutable migrations, control owns authorization/admission/controllers, SDK/CLI expose implemented behavior, provider adapters own transport. Validate external input once; derive types from schemas. Avoid `any`, unchecked casts and speculative layers.
- Persist external mutation intent before submission. Never repeat an uncertain create. Retain exact resource IDs, ownership evidence and cleanup authority across revocation and crashes. Release cost reservations only after authoritative cleanup.
- Serialize competing mutations at the existing machine/account boundaries. Use `loadAuthority` for current ancestry and database-time expiry; recheck authority under the account lock before mutation admission. Uncertain certificate issuance is never repeated for the same persisted attempt.
- Never put provider credentials in guests. Never print secrets, raw CA logs, customer commands or application data into service logs. Smallstep access logging remains disabled. Private files are owner-only; use explicit SSH credentials and verified host trust, never inherited SSH configuration or agents.
- Keep the probe account restricted to identity and inspection. Internal deployment access must be explicitly configured, separate from public customer access and unavailable to delegated/customer grants by default.
- Applied migrations and published image inputs are immutable. Run `pnpm db:check` before claiming deployed schema matches source. Preserve original identity keys on retries; runtime and cleanup must survive missing fresh-provisioning credentials.

## Cost and verification

- Hetzner credentials are ready. Prefer local protocol/VM fixtures before paid work. Live tests require recorded ownership, existing cheap spending caps, a deadline and verified cleanup. No expensive plans, benchmarks, warm pool or automatic type/region fallback.
- Reuse safe fixtures. Run VM smokes sequentially; act only on exact recorded resources. Never run a broad stop/delete command. Existing ownership records and historical operational rules are in `docs/archive/development-rules-before-capability-loop.md` and the relevant architecture docs.
- Distinguish implemented, locally verified and live verified. Never infer provider proof from simulation. Do not silently omit blocked requirements.
- Use `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>`. Coherent source checkpoints require `pnpm check` and `pnpm format:check`, plus integration checks relevant to changed behavior. Commit on `yahor/agent-cloud`; describe product behavior plainly.

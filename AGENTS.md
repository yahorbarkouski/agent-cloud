# Working on agent-cloud

Build an open-source cloud operated by customers' existing coding agents. We do not build a coding agent. Read `README.md`, then `docs/CONTEXT.md` for the current state and next work. `docs/PROGRESS.md` owns milestone status; `docs/architecture/overview.md` will own the implemented design. Historical plans under `docs/archive/` are reference material, not claims that features exist.

## Current constraints

- TypeScript, ordinary Linux VMs, Docker Compose, SSH, and Hetzner. Stripe and payment integration are deferred until the product works.
- Keep costs low. Use local services and a simulated provider first. Hetzner verification and credential setup are complete. Rent a server only when a bounded inexpensive test and cleanup path are ready. No expensive plans, warm pool, or load generation against shared provider infrastructure.
- All external resources must have recorded ownership, a cleanup path, and explicit spending limits. Never put provider credentials in a customer guest.
- Keep all work inside this repository. The parent workspace contains unrelated projects.

## Code and verification

- `packages/contracts` owns schemas; `packages/db` owns schema/migrations; `apps/control` owns auth, admission and worker behavior; `packages/sdk` and `apps/cli` expose it. `packages/hetzner` is transport only until live activation checks are complete.
- Run `pnpm check` and `pnpm format:check` for a checkpoint. With local API/worker running, `pnpm smoke:local` exercises the real CLI and must finish cleanup. Tests create and remove isolated databases; never point cleanup code at unrelated databases.

- Model states with discriminated unions. Derive transport types from validated schemas. Validate external input at boundaries; do not use `any`, non-null assertions, or unchecked casts.
- Money carries an explicit currency. Reserve gross provider prices including IPv4 using integer micro-units. Pin the admitted offer; recheck before a fresh effect and never substitute types automatically. Catalog network refresh runs outside admission transactions.
- The operation controller selects effects; `effect-journal.ts` owns submission/reconciliation and `resource-journal.ts` owns provider identity records. VM and Primary IP cleanup must both be observed before releasing a reservation. Never compensate an IP while a VM submission is uncertain.
- `packages/pki` wraps pinned Smallstep signing and checks certificate identities and lifetimes. `packages/remote` performs bounded native SSH identity reads with explicit credentials, fixed commands and isolated trust files. Keep certificate issuance separate from retryable reads. Never inherit a user's SSH config or agent.
- Guest bootstrap secrets stay encrypted and bound to allocation/image/endpoint metadata. Provider journals carry references. Claim guest keys only after direct SSH proof to the owned provider address. Fresh live submissions use `create_guest` with a bootstrap reference; legacy `create` remains readable for reconciliation. Only a matching prepared attempt may render boot data. Enrollment signing budgets survive restarts, and certificate persistence, token erasure and the runtime handoff commit together. See `docs/architecture/guest-bootstrap.md` for the remaining integration boundaries.
- `packages/guestctl` owns root-run first boot and local identity inspection. `images/` owns public image inputs and Linux service configuration. Publish keys and certificate bundles atomically, preserve keys on retry, and explicitly set file modes under the systemd umask. Keep guest state separate from fleet credentials. See `docs/architecture/guest-image.md` for the current Linux proof and remaining snapshot work.
- Runtime SSH credentials force only `sudo -n -- /usr/local/bin/guestctl inspect --json`. Keep identity reads unprivileged; never add the probe user to Docker or grant general sudo. The worker rechecks owned provider addresses, pinned image/keys, component health, disk headroom and boot ID. Signing attempts persist per operation. Recheck the readiness deadline in the completion transaction; pending provider effects still require reconciliation after expiry. See `docs/architecture/guest-runtime.md`.
- `pnpm smoke:guest` owns one local OrbStack VM through `.local/guest-image-machine.json`. On failure inspect only that recorded VM, then delete it and its record before a fresh run. Do not treat OrbStack networking or local protocol fixtures as Hetzner boot verification.
- Image installation requires the caller's builder UUID. `guestctl prepare-image --json` is only for a freshly created exclusive builder with no allocation or Docker data. It never starts Docker to inspect it. A sanitation receipt authorizes stopping that recorded builder before cloning; it does not authorize snapshotting a running or partially prepared machine. See `docs/architecture/image-sanitation.md` for interruption limits.
- `pnpm smoke:image` owns a builder through `.local/guest-image-builder.json`, a negative-test clone through `.local/guest-image-refusal.json`, and sequential guest clones through the guest record above. Failures preserve those records. Inspect and delete only recorded machines before retrying. Never modify a selected `.local/guest-builds/<manifest-digest>` input tree during a VM smoke or use `orb stop` without an explicit owned machine name.
- While a VM smoke is active, use its output for progress and leave VM commands to that process. Even a diagnostic `orb run` can start a deliberately stopped sanitized builder and invalidate its identity. Inspect VM contents only after the smoke has exited.
- `packages/images` owns full input provenance and authenticated release metadata. Published inputs are read-only and named by manifest digest; capture `.local/guest-build.json` once and verify that directory before use. Execute the controller-owned `imageInstallCommand` to check the independently pinned transfer digest with base OS tools before any uploaded code. A signature authenticates recorded evidence; production snapshot ownership and actual boot-source proof still require the provider runner and verifier integration.
- Operator image builds use sibling SQL journals, never customer allocations. `pnpm image:build` admits, inspects and cancels; it has no live advancement command yet. Reserve both VM/IP pairs with per-resource hourly rounding and separate gross snapshot storage caps. Keep all unfinished builds in the aggregate operator allowance. Unknown creates never retry; known duplicate IDs remain recorded even during cleanup. Exact-ID stop/delete retries retain the original receipt and point to a prepared replacement. Cancel is a full build abort, including its unpublished snapshot. See `docs/architecture/image-release.md`.
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

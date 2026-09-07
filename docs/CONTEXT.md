# Current handoff

Updated 2026-09-07. The full non-Stripe goal is active. User authorizes implementation, private GitHub pushes and bounded cheap Hetzner tests. Use working customer capabilities as progress, one primary stream and proportional verification.

## What works

- Internal CLI/API authentication, delegated grant storage/authority, budgeted machine lifecycle and exact owned cleanup.
- Signed image build, guest enrollment, verified SSH health, graceful reboot/power operations and certificate renewal. M1 live Hetzner proof and full cleanup are preserved in `docs/research/m1-customer-live-*.json`.
- Durable customer SSH session storage and narrowly bound certificate signer, including native SSH and uncertainty checks. Customer endpoints/gateway are not connected yet.
- HEAD before current changes: `095adac` on `yahor/agent-cloud`, pushed. Linux CI 34145649715 passed. Do not rerun that unchanged source.

## Next acceptance scenario

Use the existing internal identity to provision one cheap VM through the CLI, deploy frontend/backend/PostgreSQL, verify HTTPS, disconnect/reconnect, inspect logs/status, update while retaining data, then destroy and verify cleanup. Add a separate restricted deployment account and an explicitly allowlisted internal endpoint. Keep the probe account unchanged. CLI/API/native SSH/systemd/Compose reference deployment is implemented. Native Ubuntu proof passed: verified local HTTPS, CLI disconnect/reconnect, logs and update from revision1 to2 with a persisted visit. Isolated VM and DB were removed. Focused authorization/recovery tests passed. Bounded independent review found a lost systemd wakeup race; an enabled timer now resumes recorded pending work. Source check passed on41files with454tests, typecheck and lint. Formatting passed. Next is capped Hetzner public-HTTPS deployment and cleanup. CI documentation filtering is implemented and locally checked.

## What remains

First complete the internal application scenario. Then finish customer login/delegation/revocation, files/durable commands, general Compose/recovery, routing/domains, database/analytics recipes, protected backup/isolated restore, limits/usage, self-hosting, agent instructions and budget-appropriate failure verification. Do not expand image-capability prerequisites before the application scenario.

## Resume and evidence

Use `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>`. Focused checks first; `check` and `format:check` at source checkpoints. PostgreSQL 17 at localhost:55439, database `agentcloud`, migrations through 0020 applied and verified. API PID15176/session25749 on4319 and worker PID15190/session89064 use `.env` with simulated provider. Restart after relevant source changes. Native CA at https://localhost:9449; pinned tools and credentials under `.local/pki` and `.local/runtime-identity`. Never print their contents or raw CA logs.

## Resources and blockers

No paid VM, IP, snapshot, firewall or SSH key remains. Hetzner project `agent-cloud-development`15945891; token `.local/hcloud-token`. Default project untouched. Local CA container `agent-cloud-pki-ca-1` uses256MiB/.5CPU; DB container `agent-cloud-dev-postgres-1`. No tunnel or OrbStack guest active. Prior live drill scripts/records are under `.local/customer-drill-*`; archived private DB dump must not be printed or committed. Previous bounded customer VM/IP cap60000µUSD, image VM/IP cap120000µUSD, snapshot monthly cap1000000µUSD. New live run needs its own explicit owned record and cleanup.

Evidence: `.local/reference-local-vm.log`, `.local/reference-focused.log`, `.local/reference-check.log`. Native fixture uses `reference.localhost` and a trusted local Caddy CA; this is not public ACME or Hetzner verification. Run `pnpm smoke:reference` for that local scenario. No user action currently blocks implementation. Public HTTPS domain choice remains to be exercised. Untracked image-capability draft and golden fixture remain preserved in `.local/customer-ssh`; do not discard or pursue them as prerequisites. Detailed previous status is archived in `docs/archive/handoff-before-capability-loop.md`.

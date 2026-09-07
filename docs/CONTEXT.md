# Current handoff

Updated 2026-09-07. The full non-Stripe goal remains active. User authorizes implementation, private GitHub pushes and bounded cheap Hetzner tests. Work by customer acceptance scenarios; do not expand prerequisites.

## What works

- **First internal deployment scenario live verified:** existing identity → product CLI provisions CPX12 → frontend/backend/PostgreSQL → public HTTPS → disconnect/reconnect → status/logs → revision update preserving data → destroy and verified cleanup. Source `4d2bffa`, Linux CI34148449714 passed. Public evidence: `docs/reference-deployment-verification.json`. The historical application URL is no longer live.
- Signed image build, guest enrollment, verified SSH health, lifecycle operations, renewal and exact owned cleanup. Budget admission and current delegated authority are enforced by the control service.
- Customer SSH session storage and bound certificate signer have local/native verification; customer endpoints/gateway remain unconnected. Internal reference deployment is separately configured for one root grant; it is not public customer access.
- A real provider lag briefly reported an owned IP still attached after authoritative server absence. Cleanup recovered with one delete. The local correction now waits in that case while retaining the reservation; foreign assignment stays blocked. Regression, focused cleanup checks and full source check passed (455 tests, typecheck, lint). Bounded review found no blockers.

## Next acceptance scenario

An owner delegates one project to a second CLI credential. The second CLI can inspect only that project and cannot escalate authority. Revoking its parent blocks it and its descendants immediately. Connect the existing grant API to CLI credential files, exercise actual CLI/API paths and document use. Continue customer sign-in and general access afterward; this internal checkpoint is not completion.

## What remains

Customer login/delegation/revocation, file transfer and durable commands, general Compose deployment/recovery, routing/domains, database/analytics recipes, protected backups and isolated restore, limits/usage, self-hosting, agent instructions and budget-appropriate operational failure verification. Reuse the existing foundations.

## Resume and evidence

Use `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>`. Focused checks while iterating; required `check` and `format:check` at coherent source checkpoints. Do not repeat unchanged suites for docs or reviews. PostgreSQL 17: localhost:55439, DB `agentcloud`, migrations through0020 verified. Simulated API PID15176/session25749 on4319 and worker PID15190/session89064 run older loaded code; restart after relevant source changes. Native CA https://localhost:9449; original keys in `.local/pki` and `.local/runtime-identity`. Never print credentials or raw CA logs.

Local evidence: `.local/reference-local-vm.log`, `.local/reference-check.log`, `.local/reference-cleanup-focused.log`, `.local/reference-cleanup-check.log`. `pnpm smoke:reference` exercises actual CLI/API/native SSH/systemd/Compose on Ubuntu using trusted local HTTPS. Live record: `.local/reference-live-record.json`, owner `63cbe179-f25b-4729-8469-ae6947664b47`; driver and finishing logs beside it. Isolated live DB was privately archived under `.local/archives/` then dropped; the archive was listed, not restored.

## Resources and blockers

**No paid resources remain.** Hetzner project `agent-cloud-development`15945891 inventory: zero servers, IPs, snapshots, firewalls and SSH keys. Live SQL reservations zero. All six temporary live processes stopped and confirmed absent. No local OrbStack guest remains. Token `.local/hcloud-token`; Default project untouched. Main local CA and PostgreSQL containers remain for development.

Existing live caps: image VM/IP120000µUSD, customer VM/IP60000µUSD, snapshot monthly1000000µUSD. First scenario's estimated VM/IP cost was83394µUSD (~$0.0834) using hourly rounding, excluding snapshot storage; not an invoice. No extra paid rerun is needed for the locally reproduced cleanup classification fix. Future paid tests still need ownership, deadline, caps and cleanup.

No user action currently blocks implementation. Preserved untracked image-capability drafts remain in `.local/customer-ssh`; do not pursue them as prerequisites. Historical detail is in `docs/archive/`, not a second current status file.

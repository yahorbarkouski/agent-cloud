# Implementation progress

## Architecture workflow

- [x] Ground: greenfield repository; researched plan available; parent projects are unrelated.
- [x] Sketch: bounded alternatives for durable lifecycle and persistence.
  - [x] Frame: compare recoverable effects, testability, TypeScript contracts, and implementation size.
  - [x] Fan out
  - [x] Cross-judge
  - [x] Pick
  - [x] Graft
  - [x] Verify
- [x] Agree: user authorized autonomous implementation; no design approval checkpoint required.
- [ ] Implement: fill the chosen contracts with real behavior and tests.
- [ ] Scrap audit: revisit boundaries if implementation needs repeated exceptions.

## Product milestones

- [x] M0: repository, contracts, local services, authenticated API, operation model, simulated provider.
- [ ] M1: durable machine lifecycle, Hetzner adapter, first-boot image, cleanup and reconciliation.
- [ ] M2: CLI and customer access, grants, device login, SSH access and revocation.
- [ ] M3: file transfer, persistent command runs, Compose deployments, HTTPS routes and domains.
- [ ] M4: PostgreSQL/analytics recipes, protected backups, isolated restore, platform recovery.
- [ ] M5: resource limits, usage, audit, alerts, local account funding policy. Stripe deferred.
- [ ] M6: self-hosting, maintained skills/docs, realistic end-to-end validation.
- [ ] M7: availability and failure drills appropriate to the user's low infrastructure budget.

## Verification ledger

2026-09-06 local checkpoint:

- TypeScript build and tooling/test typecheck pass. Strict typed ESLint passes.
- 19 PostgreSQL integration tests pass in two suites. They verify admission races, account isolation, provider uncertainty, worker contention, cleanup, delegation bounds, expiry, and revocation. A subprocess crash exercises the real provider-commit/journal boundary; database guards reject attempt-history rewrites.
- The CLI → HTTP API → PostgreSQL → Graphile worker smoke test passed, including creation, readiness inspection, deletion, and cleanup. Provider state and guest readiness are **simulated**.
- All smoke allocations were cleaned up; the development account reported zero active reservations afterward.
- Independent `gpt-5.6-sol` review and follow-up found no material regression after the journal guard fix; see `docs/research/m0-review.md`.
- Initial migrations applied locally. Database/queue state persists across processes.
- Private repository `yahorbarkouski/agent-cloud` exists and is configured as origin. First push and remote CI verification are pending.
- Hetzner account verification was pending at the last browser inspection. No project, token, VM, or bucket has been created through this task. No cloud resources have been rented.

M1 is in progress. A Hetzner HTTP transport exists, but live admission/worker activation is disabled. Before enabling it: verify account prices and availability; enforce reservation ceilings including ancillary charges; track Primary IP cleanup; verify the guest template; distinguish allocation from guest readiness; implement authoritative resolution of uncertain and duplicate resources.

M2 has a JSON CLI, local token login, scoped grants through API/SDK, and revocation. Browser/device login, SSH certificates, gateway access, and CLI grant management remain.

M3–M7 remain implementation work. Current passing tests do not establish real VM boot, SSH identity, routing, Compose deployment, database restore, or production availability.

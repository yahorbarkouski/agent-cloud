# Guest grounding for machine create

This note traces the current `machine.create` path and identifies where guest bootstrap, one-time key enrollment, and SSH readiness can attach. It is grounding for later designs, not a selected design.

## Caller flow

The external caller enters through `apps/control/src/app.ts`. `POST /v1/projects/:projectId/machines` parses `MachineSpec`, reads the `Idempotency-Key`, and calls `admit()` with `{ kind: 'create', projectId, spec }`.

`apps/control/src/lifecycle.ts` owns admission. Inside one transaction, `admit()` locks the shared admission ceiling, locks the account, reloads the grant, checks `machine:create`, checks size and region policy, resolves the catalog offer, reserves the exact gross hourly price, creates the stable `machines` row in `{ kind: 'provisioning', allocationId }`, creates the live `allocations` row, inserts the `operations` row with command `{ kind: 'create', spec }`, stores the idempotency binding, records `operation.admitted`, and enqueues `advance_operation`.

`apps/control/src/tasks.ts` runs `advanceOperation()` for queued work and re-enqueues every nonterminal operation. The recurring `reconcile_operations` task also re-enqueues nonterminal operations, so future guest readiness state can be retried by the same durable loop if it is represented in database state.

`apps/control/src/advance-operation.ts` serializes per machine with `withMachineLock()`, reloads the operation, machine, active allocation, provider attempts, and allocation-owned resources, then advances one durable effect at a time. For create on `managed_ipv4`, the first effect is `create_primary_ip`; after that resolves, the second effect is `create`.

`apps/control/src/effect-journal.ts` owns external mutation journaling and reconciliation. `journalEffect()` checks the admitted offer against a fresh provider catalog for billable effects, reloads authorization for fresh effects, inserts a prepared `provider_attempts` row, sets progress to `submitting`, calls `provider.submit()`, saves the provider outcome, and claims returned resources when possible. `resolveEffect()` evaluates pending attempts by action status and provider observation, then writes an immutable confirmed or failed resolution, or leaves progress in `waiting_provider`, `verifying`, or `blocked`.

`packages/hetzner/src/index.ts` maps `ProviderCommand` to Hetzner transport calls. The `create` command body uses the configured template fields: `image`, shared `firewallIds`, shared `sshKeys`, and static `userData`; it attaches the previously owned Primary IP and disables IPv6. The transport does not currently receive allocation-specific bootstrap material.

After a confirmed server create, `advance-operation.ts` calls `complete()`. For the simulator, the machine becomes `allocated` with `guest: simulated`. For Hetzner, it becomes `allocated` with `guest: pending`, but the operation is still marked `succeeded`. That is the current gap relative to the archived plan.

## Authoritative files and types

- `packages/contracts/src/lifecycle.ts`: `LifecycleCommand`, `OperationProgress`, `MachineState`, and `guestVerificationSchema`. `OperationProgress` already has `blocked: guest_unreachable`; `MachineState.allocated.guest` has `pending`, `simulated`, and `ssh`.
- `packages/contracts/src/provider.ts`: `ProviderCommand`, `Submission`, `ProviderAction`, `ResourceObservation`, `EffectResolution`, and `MachineProvider`.
- `apps/control/src/lifecycle.ts`: idempotency, authorization, quote pinning, reservation, machine/allocation/operation creation, and enqueue.
- `apps/control/src/advance-operation.ts`: operation controller, sequencing, effect selection, compensation, and final machine state transition.
- `apps/control/src/effect-journal.ts`: prepared-before-submit journaling, fresh checks, action polling, provider observation, and immutable resolution.
- `apps/control/src/resource-journal.ts`: allocation labels, effect labels, owned resource records, and absence recording.
- `packages/hetzner/src/index.ts`: live transport request shape and current template schema.
- `packages/db/src/schema.ts`: durable tables for machines, allocations, operations, provider attempts, provider resources, and audit events.
- `docs/archive/original-plan.md` sections 9.3 and 10.1: intended SSH and provisioning contract.
- `docs/architecture/provider-resources.md`: implemented resource ownership and cleanup contract.

## Extension points

Per-allocation guest bootstrap belongs at the create boundary where `advance-operation.ts` builds the `ProviderCommand` and `HetznerProvider.submit()` renders cloud-init. The command currently carries provider shape only: name, server type, region, labels, and network. A future design needs durable bootstrap input tied to `allocation.id` before the provider create effect is submitted, because `journalEffect()` records the command before mutation and preserves it for reconciliation.

One-time key enrollment belongs after the provider server is confirmed and before the machine is exposed as guest-ready. The archived plan requires the guest to create fresh SSH/TLS keys, enroll once with a short-lived bootstrap secret, and bind signing to the pending record, bootstrap secret, expected allocation, and expected provider/network identity. The natural controller hook is the current `complete()` call site after confirmed `create` resolution. Today that path immediately marks the operation succeeded; a future design can split provider allocation from guest readiness using existing progress and machine guest state.

SSH readiness belongs after enrollment, not inside Hetzner transport. `resolveEffect()` verifies provider facts: labels, region, type, attached Primary IP, and power. It does not verify host identity, OpenSSH reachability, Docker, Compose, disk, image version, or guest proxy health. Those checks should produce the existing `guest: { kind: 'ssh', verifiedAt, imageVersion }` state only after host identity matches the platform CA model from original-plan 9.3.

## Current limitations

Live API and worker activation reject `PROVIDER=hetzner` in `apps/control/src/api.ts` and `apps/control/src/worker.ts`. The Hetzner package is transport-only.

There is no durable bootstrap secret table, no enrollment endpoint, no guest identity record, no host certificate signing flow, and no SSH transport ticket flow. Cloud-init is a static template string, and provider commands do not carry per-allocation user data.

`complete()` marks Hetzner create operations succeeded while leaving `machine.state.guest` as `pending`. That accurately records provider allocation, but it does not implement original-plan 10.1 steps 6 through 9.

Provider resource ownership and cleanup are implemented around VM and Primary IP IDs. They do not prove guest boot, SSH identity, application runtime readiness, or live Hetzner cleanup under paid-resource faults.

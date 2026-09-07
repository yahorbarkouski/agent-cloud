# M1 guest runtime readiness review

Reviewer: configured `gpt-5.6-sol`. This is a read-only review of the runtime readiness checkpoint, including the controller, migration 0008, purpose-specific PKI/SSH transport, guest inspection, sudo policy, tests, architecture, commit, CI, and final decision trail. I did not operate the VM. The local run evidence below was supplied through the active task and preserved in repository artifacts; no transcript directory was supplied.

## Findings

### Resolved during review — enforce the deadline at commit

`guest-readiness.ts` originally asked PostgreSQL whether `operation.created_at + 30 minutes` had expired only before provider, CA, and SSH work. A check beginning just before expiry could return ready after the deadline. `complete` now locks the operation row, requires the exact `waiting_guest/runtime` phase and observed server, rechecks database time, and atomically records `guest_deadline_exceeded` before any success write when expired. A regression moves the database clock boundary during the SSH callback and verifies no machine verification or success audit is committed.

Fresh Hetzner create, reboot, and power-on effects now receive the same admission-relative cutoff in `journalEffect` before attempt insertion and `provider.submit`. This does not suppress reconciliation of a prepared or uncertain effect, which must still discover its real outcome. The added queued-create regression covers expiry both before IP creation and after an owned IP exists: no guest render or VM attempt occurs, the IP is compensated when present, and the allocation is retired.

### Deliberate production gate — the worker cannot use readiness yet

`createTasks` calls `advanceOperation` without `guest`, and `worker.ts` constructs only the simulated provider and has no signer, remote probe, or readiness instance. This correctly keeps the live gate closed, but production operations cannot use the runtime path yet. Do not claim production readiness until configuration constructs these ports and a queued live create/reboot reaches them through `createTasks`.

## Security and correctness assessment

The capability split is narrow and coherent. Probe and runtime credentials have distinct branded kinds, principals, inspected critical commands, and no SSH extensions. Runtime reads require host-CA trust. OpenSSH ignores user/global configuration, agents, proxy commands, forwarding, passwords, and interactive input. The server authorizes both allocation-specific principals, while the runtime certificate forces the absolute `sudo -n -- guestctl inspect --json` command. The root-owned sudoers entry permits exactly that argv under `NOSETENV`, and `agent-probe` is not placed in the Docker group. Native CA inspection proved the forced command and empty extensions. The Ubuntu smoke proved runtime inspection through restricted sudo while denying general `sudo id` and direct unprivileged inspection.

Guest inspection binds its proof and complete manifest to the locally installed bundle hash, reports the kernel boot ID, and runs fixed component commands. Docker checks the daemon through its Unix socket; Caddy is checked both by binary version and the allocation-specific loopback health response. Disk headroom takes the minimum free space across guest state and Docker storage. Individual operational failures become explicit `unavailable` checks, while malformed identity, manifest, architecture, or boot evidence fails the whole read. Output and subprocesses are bounded.

The control plane re-observes the single owned server and Primary IP, including immutable labels, admitted type/region, attachment, address, and running power, before SSH. It compares the host-CA-authenticated proof to persisted keys, CSR, image, manifest digest, architecture, component versions, disk headroom, and proxy identity. Identity changes block; transient component failures wait. For reboot and power-on, a previously verified machine cannot complete until the returned boot ID differs. Completion stores the new verification and operation success atomically under the machine advisory lock.

Signing reservations are durable and immutable. The SQL trigger ties each sequential attempt to the same account, allocation, machine operation, issued identity, runtime phase, server, live allocation, supported operation kind, and database deadline. The application locks the operation row, enforces 12 attempts and a 30-second issuance cooldown, and caches a credential until near expiry. A failed CA call deliberately consumes its reserved slot. Tests cover the database guards, cap, cooldown, restart, and concurrent completion.

## Evidence boundaries

The final full check passed 121 tests in 18 files with typecheck and strict lint. The focused readiness coverage includes concurrent atomic completion, unavailable components and recovery, version/disk/proxy failures, changed identity/manifest/architecture, changed provider labels before signing, durable cooldown and exhaustion, immutable attempt guards, deadline before signing and across SSH, queued-effect expiry, and reboot/power-on boot-ID changes. Native PKI, SSH, and enrollment smokes passed.

The fresh Ubuntu smoke used image `dev-3e7f5c0ea7e8`, manifest digest `b14b11bdb05883e7af0307a3817f31c047b0fcb10e3b9c382e1381dd0c2834c5`. It passed real cloud-init/systemd enrollment, restricted runtime sudo and denials, Docker service/socket and proxy failure detection, a 32 MiB temporary guest-state filesystem, recovery to readiness, rejection of a provider-complete reboot with the old boot ID, and completion after an actual reboot. The token scan covered 135 files and 18,358,624 bytes with no matches. The VM and ownership record were removed, and local VM inventory was empty.

Migration 0008 was applied to the development database. Restarted API/worker/CLI smoke passed and cleaned its allocation; the database reported nine migrations and zero active allocations, simulated VMs, or simulated IPs. These services still use the simulated provider and do not exercise production `GuestProvisioning` wiring.

## Trail audit

The six appended runtime rows have the required six TSV fields. Each decision maps to the cited code, migration, tests, smoke runner, architecture, progress ledger, commit, or CI run. The rows preserve the review-discovered deadline race and its fix, describe the purpose-specific privilege boundary, record durable signing and boot evidence, and state the local VM and migrated-service outcomes. They make no Hetzner boot or paid-resource claim. The local run/session outputs were not independently replayed by this reviewer, and no transcript directory exists; this is an artifact and trail audit.

Implementation commit `ca03da9ef6330357559d06d65eb83dc672a6a6a3` is pushed. I independently queried GitHub Actions run `34071617896`: workflow `Check` completed successfully at that exact head SHA. Its recorded steps include frozen installation, the full check, formatting, fresh Smallstep/PKI setup, all three native PKI/SSH/enrollment smokes, and cleanup. This CI does not run the OrbStack VM smoke.

The current architecture, progress, and context consistently leave production worker/live configuration, snapshot sanitation, certificate renewal, blocked-operation recovery, and the bounded Hetzner boot/cleanup drill open. The new “Next sanitation proof” section is explicitly preparatory: it cites the intended cloud-init/provider boundaries and observed clone tooling, without claiming implementation, clone execution, or VM evidence.

**Attention:** the reviewed runtime slice has no remaining high-confidence correctness or privilege-boundary defect. Scrutinize the still-closed production worker wiring and the unimplemented sanitation, renewal, operator recovery, and real Hetzner proof before enabling live operations.

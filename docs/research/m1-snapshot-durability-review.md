# M1 snapshot durability review

Reviewed by: `gpt-5.6-sol`

Scope: read-only implementation and artifact/trail review of the correction prompted by the first Hetzner image drill. No active-workspace transcript directory was supplied, so this report does not claim a transcript audit. I did not edit implementation code, run tests, operate VMs, touch provider resources, or control project processes.

## Result

I found no remaining production-code blocker. The local random-seed proof deliberately clears OrbStack's LXC virtualization condition and must remain described as an environment fixture rather than a byte-identical production-image proof.

### Resolved P1 — stop the random-seed writer before removing its output

`packages/guestctl/src/image.ts:137-151` stops logging and container services, then removes `/var/lib/systemd/random-seed`, but it leaves `systemd-random-seed.service` active. The upstream unit is `Type=oneshot` with `RemainAfterExit=yes`, conflicts with and orders before `shutdown.target`, and runs `systemd-random-seed save` in `ExecStop`. The upstream documentation likewise states that the service saves the kernel seed to `/var/lib/systemd/random-seed` at shutdown. A normal `/actions/shutdown` therefore stops the still-active unit after sanitation and recreates a random seed in the snapshot source. Clones made from that snapshot can inherit the same seed, defeating the sanitizer's explicit removal.

The implementation now stops `systemd-random-seed.service` alongside the container services before removing `/var/lib/systemd/random-seed`. Stopping the active oneshot intentionally invokes its save once; deleting the file afterward removes that saved value. Every initial and replay receipt requires both an inactive writer and an absent seed, then completes the final `sync --file-system /`. The code does not disable or mask the unit, so normal static activation remains available on clone boot.

The native image smoke now proves that the injected failing `sync` was actually reached through a `/run` sentinel, that the durable state had reached `sanitized` without emitting a receipt, that restoration permits retry, and that the writer is inactive and its seed absent before imaging.

Authoritative references: [upstream unit definition](https://github.com/systemd/systemd/blob/main/units/systemd-random-seed.service.in) and [systemd random-seed documentation](https://github.com/systemd/systemd/blob/main/man/systemd-random-seed.service.xml).

### Native fixture limitation — OrbStack's virtualization condition is deliberately overridden

`scripts/support/vm-seed.ts:6-8` writes a smoke-only drop-in under `/etc/systemd/system/systemd-random-seed.service.d` to clear `ConditionVirtualization`. This persistence is intentional: OrbStack identifies both builder and clones as LXC, for which the stock upstream unit deliberately skips execution on every boot. A `/run` override would disappear at clone boot and make the post-boot assertion fail for that known environment reason.

The helper is invoked by local smoke scripts after installation. It is absent from immutable published input `61b1e397…`, and the actual Hetzner builder does not invoke it. The native proof is consequently narrow but useful: with the documented local condition cleared, production sanitation stops the real unit, removes its seed without disabling or masking it, and clone boot reactivates that unit without a manual start and produces a nonempty seed. It does not prove stock virtualization-condition behavior or a byte-identical production snapshot. The fresh target-provider run must supply the production-environment proof. The failed OrbStack assertion correctly exposed this limitation and is not evidence of a production defect.

The evidence supports the stated root-cause inference, with the right degree of caution. The cancelled verifier disk was inspected through rescue with its filesystem mounted read-only and `noload`. Several installed files that must have existed for the completed builder workflow were present as zero-byte inodes, while large installed binaries remained intact and the individually fsynced sanitation record survived. The recorded image transport used Hetzner's hard `/actions/poweroff` immediately after sanitation. This does not prove at the block level that hard poweroff was the sole possible cause, but it is strong evidence that recently dirty filesystem data was captured without a complete writeback. The artifact labels this as an inference and does not claim that the failed snapshot was valid or published.

## Correction review

`packages/guestctl/src/image.ts` now publishes the sanitation record atomically and then runs `/usr/bin/sync --file-system /` before returning the sanitation receipt. The record's own file and directory fsync cannot cover installed files, removed builder state, systemd units, or filesystem metadata elsewhere, while GNU `sync --file-system /` asks the kernel to flush the filesystem containing `/` and reports writeback failure through its exit status. Because the command is awaited, a failed flush cannot yield a receipt to the controller.

The replay path also reaches the flush. A crash or lost SSH response after writing the sanitized record therefore causes the next sanitation call to revalidate the sanitized state and retry the filesystem flush before returning the same receipt. The native failure injection replaces `sync` with a failing executable after earlier sanitation checks, asserts that no receipt is returned, restores the real executable, then verifies successful retry and identical replay. This exercises the important durable-record-but-no-receipt boundary.

The image transport now maps the journal's `power_off` desired-state command to Hetzner `/servers/{id}/actions/shutdown`. No hard-power fallback is present. An accepted or even succeeded shutdown action is not treated as proof that the source stopped: the controller continues to observe the server, keeps the stop effect pending while it is running, refuses snapshot creation, and does not resubmit the accepted action. Only observed `power: off` confirms the stop and permits the existing snapshot step. This preserves idempotency and prevents duplicate shutdown submissions after a lost response.

If an ACPI shutdown is acknowledged but the guest never stops, the build intentionally stalls rather than cutting power. Cancellation can enter the separately journaled full cleanup path; otherwise operator diagnosis is required. That operational wait is consistent with the hard no-fallback policy and is preferable to producing another potentially corrupt image.

## Test and trail assessment

The new transport test asserts the exact graceful endpoint, POST method, accepted receipt, and single request. The controller regression supplies an accepted, provider-succeeded shutdown action while leaving the server observed running; it verifies pending state, snapshot refusal, and no repeated submission, then changes the authoritative observation to off and verifies progress. The native smoke addition covers flush failure, restoration, successful receipt, and receipt replay. Together these tests cover transport selection, controller gating, and the guest durability boundary rather than merely checking the changed strings.

The appended decision rows accurately preserve the bounded paid drill and its failure before enrollment, cancellation/rescue diagnosis with publication prevented, the graceful-shutdown and filesystem-flush correction, the random-seed finding, the explicit OrbStack fixture limit, and final local verification. The drill artifact identifies implementation and CI, exact build/resource identities, rescue actions, sampled files and hashes, final cleaned state, access removal, and the later zero-resource inventory. It does not claim a successful verifier, release, or snapshot durability proof.

The cleanup evidence is internally consistent: build `bbb28cd4-aca1-4a94-87cf-364728bf6771` is recorded cleaned at `2026-09-07T09:59:14.223Z`, access removal follows, every recorded resource is absent, and the fresh provider inventory at `2026-09-07T10:00:18.634Z` is empty. No replacement VM was created during rescue.

## Remaining proof limits

Final local evidence is complete. `docs/research/m1-snapshot-durability-verification.json` records 66 focused tests, then full check `29401` with 352 tests across 33 files, typecheck, lint, and exit 0. Script typecheck and lint also passed after the fixture changes. Native run `57208` exited successfully on immutable input `61b1e397…`: the flush sentinel proved refusal after the sanitized marker and successful retry after restoration; two distinct clones completed restricted SSH, runtime failure/recovery, and reboot checks; both token scans had zero matches; and all exact VM ownership records were absent after cleanup. The seed lifecycle in this run remains subject to the documented OrbStack virtualization override.

Final documentation formatting, an exact implementation commit, and exact-head CI remain pending. More importantly, only a fresh corrected Hetzner build through sanitation, graceful observed shutdown, snapshot, verifier enrollment/runtime, retained publication, and final cancellation will prove this durability change on the target provider. The failed drill and rescue diagnosis do not supply that positive proof.

Customer release wiring, certificate renewal, backups, and the broader product remain open. The existing hard-power endpoint elsewhere in the general customer-machine adapter is outside this image-source snapshot path and should not be described as part of this correction.

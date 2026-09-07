# Image sanitation implementation

This fills the selected guest image design. Current phase: local implementation and clone proof complete; provider publication remains open. Grounding traced `images/install.sh` → public installed manifest/toolchain → rendered per-allocation cloud-init → `guestctl enroll` → fresh keys/certificates/runtime. Sanitation belongs between installation and snapshot/clone creation, before any allocation ever enrolls.

Caller sketch:

```ts
const prepared = await prepareImage(configuration);
// Verify receipt, then stop the recorded builder before clone/snapshot publication.
// Boot two owned clones with separate bootstrap records and compare public identities.
```

`packages/guestctl/src/image.ts` owns the root-only preparation command. The installer writes a private builder record bound to the caller's UUID, original machine ID, installed manifest and home paths/owners. Preparation validates that record, the actual bundle, empty allocation state and absence of Docker containers, images, volumes, build cache, custom networks and swarm state. It stops Docker/containerd, removes their generated state, builder homes/access, system SSH host keys, cloud-init caches, logs, random seed and machine ID. It disables SSH startup and publishes the guest SSH policy for later enrollment. It does not stop the current SSH session; the caller must stop the builder after receiving the receipt and before taking a snapshot. An interrupted preparation retains its record for retry.

The record has builder, preparing and sanitized states, with the caller's builder ID, original machine ID, manifest digest and explicit home paths/owners. Unknown homes and symlink/missing allocation directories refuse preparation. The installer checks state/home directory types, owners and write modes before package mutation, and refuses existing managed accounts. Docker must already be active for initial inspection; preparation never starts it. After empty-state checks, the preparing record persists before stopping Docker, allowing retry without restarting it. If another command restarted Docker during recovery, preparation checks its inventory again. Preparing retries accept only the original machine ID or the reset `uninitialized` value, never a clone's newly generated ID.

Sanitized replay verifies the reset state. Before generating keys, enrollment requires a sanitized record, matching manifest and fresh machine ID. It removes the record only after publishing allocation metadata and keys so retries remain identifiable. A shared wrapper lock serializes enrollment and preparation. The build tool owns a freshly created exclusive builder; these checks prevent accidental use on an allocated guest and do not defend against a concurrent actor who already has root on that builder.

Home/SSH access removal happens after cloud-init and storage cleanup. A final interruption after access removal needs the owner's out-of-band connection or disposal/rebuilding of the recorded builder. It must never authorize snapshot publication from an incomplete record. A rebooted partial builder with a newly generated machine ID is refused. Ubuntu's root-owned `/var/log` permits the syslog group to write; sanitation permits that group-write bit while still refusing world-write, symlink or ownership changes. The first native run exposed this and was discarded before a fresh retry.

Before removing persistent logs, preparation places a temporary `Storage=volatile` journald drop-in under `/run`, restarts journald and stops rsyslog if installed. Later service operations can log to memory without recreating builder logs on disk. The receipt requires `/var/log` to remain empty. The temporary configuration disappears on reboot, restoring the clone's normal logging policy. Systemd documents both volatile journal storage under `/run` and that changing storage mode does not remove old persistent files; preparation removes those files explicitly. See the [systemd journald documentation source](https://raw.githubusercontent.com/systemd/systemd/main/man/journald.conf.xml).

`scripts/smoke-image.ts` owns a recorded builder and calls the existing guest smoke for two sequential clones. The clone mode accepts only the separate recorded sanitized builder, never an arbitrary source VM. Failed VM/record state is retained for targeted inspection. Success removes both clones and builder. The existing first-boot/runtime checks remain the clone acceptance criteria; the parent compares machine ID, SSH fingerprint and TLS public-key fingerprint.

Verification must prove preflight refusal leaves allocations/workloads untouched, interruption/retry behavior, reset state before shutdown, fresh identities on both clones and cleanup. Local clones do not prove Hetzner snapshot consistency, pricing, retention or cleanup; those remain a later bounded provider drill.

OrbStack starts each clone once so the test can stage its NoCloud seed, then reboots it into allocation enrollment. This verifies the installed cloud-init/systemd path after cloning. It does not reproduce Hetzner's allocation data being present at the first power-on. The negative partial-preparation clone copies a sanitized filesystem and changes only its private record to `preparing`; it verifies machine-ID rejection, not a crash at every cleanup instruction.

## Local verification

Fresh `pnpm smoke:image`, session73319 on 2026-09-07, passed all installer/data/refusal checks, a real interrupted preparing retry, protection of newly added Docker volume data during recovery, persistent log cleanup, a rejected preparing clone, and two positive clones through enrollment/runtime/reboot. Both125-file token scans found no matches. Their allocation IDs, machine IDs, SSH keys and TLS SPKIs differ. The final VM inventory was empty and builder/guest/refusal ownership records were absent. See the [public verification record](../research/m1-image-sanitation-verification.json) for exact identities and digest.

Full check42939 passed121tests/18files, typecheck/lint and formatting; composed native enrollment9311 passed. The [different-model review](../research/m1-image-sanitation-review.md) and append-only decision trail retain earlier failed or interrupted runs separately from the final fresh proof. No cloud resource was created.

## Next publication work

Manifest format 2 now binds the guest bundle, installer, service/policy files, artifact pins and public trust through a complete input inventory. The [publication implementation](image-release.md) also authenticates transfer checksums before uploaded code runs and verifies signed release metadata. Provider ownership, snapshot/boot observations and release promotion remain unfinished. Keep the OS package inventory distinct from reproducible public inputs; installing current Ubuntu packages is not a reproducible OS build.

Provider publication needs its own recorded snapshot identity and cleanup. The existing VM/IP effect journal has no image effect yet, and the production worker still does not construct `GuestProvisioning`. A stopped builder, durable submission intent, reconciled snapshot result and explicit image deletion must precede the bounded Hetzner drill. A lost create-image response must not cause an unexamined second snapshot request.

Hetzner exposes create-image as a server action and image read/delete as separate operations. Snapshots survive server deletion and are billed by stored size. Image ownership labels must fit the provider's 63-character value limit; use a build ID and keep the full 64-hex manifest digest in the recorded release metadata. See the [Cloud API reference](https://docs.hetzner.cloud/reference/cloud) and [snapshot overview](https://docs.hetzner.com/cloud/servers/backups-snapshots/overview/). This describes the next boundary; no snapshot has been created.

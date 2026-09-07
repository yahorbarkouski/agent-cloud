# Runtime readiness

The controller reads fresh runtime evidence over host-CA-verified SSH and compares it to the persisted allocation, image and keys. A confirmed provider allocation plus enrollment does not finish machine creation. This path has local Ubuntu proof; production worker configuration and live activation remain gated.

The guest exposes `guestctl inspect --json`. It returns identity and manifest plus bounded outcomes for installed component versions, Docker daemon access, disk headroom and allocation-specific Caddy health. The command runs native tools with fixed arguments, reads local state and never changes it. A separate short-lived runtime SSH certificate forces `sudo -n -- /usr/local/bin/guestctl inspect --json`; a sudoers entry permits exactly that command. The identity probe certificate still forces the unprivileged identity command. Both forbid forwarding and PTYs; the probe account never joins the Docker group.

`packages/contracts` owns the runtime evidence schema. `packages/guestctl` owns inspection. `packages/pki` issues purpose-specific probe certificates. `packages/remote` owns fixed identity/runtime SSH reads and validates their wire responses. `apps/control/guest-readiness.ts` owns current provider ownership checks, credential caching, persisted issuance limits, image/evidence comparison and a bounded readiness outcome. The operation controller owns completion and blocked state.

Control call under the machine lock:

```ts
const result = await runtime.check({ db, operation, machine, allocation });
// ready: observed provider server and verified guest metadata
// waiting: a transient check or connection is not ready yet
// blocked: deadline, signing budget or identity mismatch needs operator recovery
```

A readiness signing slot belongs to the operation and allocation and is persisted before calling the CA. Migration 0008 enforces an immutable, consecutive 12-attempt ceiling and permits inserts only for an issued identity and matching active boot operation. The service applies a 30-second cooldown across restarts and reuses five-minute credentials in memory. SSH reads do not sign. The cache prunes expiring entries and caps its size at 1,024.

Boot operations have a 30-minute deadline from admission, measured with the database clock. Fresh create/reboot/power-on effects cannot begin after it. Already-pending effects still reconcile, and unused IP compensation can continue. An enrolled VM that misses readiness remains reserved and blocked. After network checks return, the completion transaction locks the operation, verifies the runtime phase/server and rechecks expiry before writing machine readiness and operation success. This closes the race found in review where an SSH read begun before expiry could otherwise commit success afterward.

Ready evidence records its timestamp, image version, manifest digest and Linux boot ID in machine state. All five pinned component versions must match. Docker must answer through its local daemon socket, both guest state and Docker storage must retain at least 1 GiB, and the loopback proxy health response must identify the allocation and image. Reboot/power-on must show a changed boot ID when a previous verified boot exists. Power-off preserves historical verification; destroy does not imply guest readiness. The bootstrap token is not reused for this phase.

Local verification on 2026-09-07:

- `tests/guest-readiness.test.ts` covers concurrent completion, changed image/keys/architecture, provider ownership, unavailable components, versions, disk/proxy identity, signing cooldown/restart/cap, database immutability, expiry during SSH and boot-ID checks for reboot/power-on. Queued-create expiry tests cover zero resources and compensation of an owned IP without creating a VM.
- `pnpm smoke:pki` issued and inspected a real runtime certificate with the exact forced command and no extensions. Certificate inspector tests reject purpose swaps and expanded permissions.
- `pnpm smoke:guest` passed in a fresh owned Ubuntu VM. Native runtime SSH used the restricted sudo command. General `sudo id` and unprivileged inspection were denied. Stopping Docker including its socket, stopping Caddy, and temporarily mounting a 32 MiB filesystem over copied guest state each kept creation pending. Restoring them allowed completion.
- The same VM's provider fixture reported a completed reboot while its Linux boot ID remained unchanged; the controller waited. An actual OrbStack reboot then completed the operation. Enrollment, host-CA identity and proxy survived. The token scan covered 135 files and 18,358,624 bytes with no matches. The VM was deleted, `orb list` returned an empty list and its ownership record was removed.

The image was `dev-3e7f5c0ea7e8`, manifest digest `b14b11bdb05883e7af0307a3817f31c047b0fcb10e3b9c382e1381dd0c2834c5`. The real VM used simulated provider observations; this does not establish Hetzner boot, production worker wiring, certificate renewal, snapshot sanitation or recovery of a blocked operation. No paid resource was created.

Smallstep's [SSH template reference](https://smallstep.com/docs/step-ca/templates/) documents fixed critical options and signed token/template fields. Our certificate purpose policy and worker behavior are application choices, not a claim about provider behavior.

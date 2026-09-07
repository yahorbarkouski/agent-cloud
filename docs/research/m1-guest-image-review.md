# M1 guest image review

Reviewer: configured `gpt-5.6-sol`. This is a read-only review of the dirty guest software and image slice: `packages/guestctl`, `images`, `scripts/build-guest.ts`, and the enrollment/guest smokes. I did not operate the owned OrbStack VMs. The parent supplied the VM observations described below.

## Findings

### Resolved during review. persist the SSH daemon across reboot

The reviewed version originally disabled and stopped `ssh.socket`, then only restarted `ssh.service`. That could let enrollment succeed while leaving no SSH listener after reboot on Ubuntu installations that relied on socket activation. `prepareSsh` now creates the required runtime directory, validates sshd, explicitly enables `ssh.service`, and restarts it. The clean VM smoke repeated the host-CA SSH probe after its second reboot and passed.

### Resolved by real VM evidence. locked probe account

The installer creates `agent-probe` as a system account and does not explicitly unlock it. This needed installed-image evidence because the Docker SSH fixture clears its password. On the fresh Noble VM, native host-CA SSH to the forced identity command succeeded while `passwd -S agent-probe` still reported `L`. No password-state change is needed for the reviewed Noble/OpenSSH/UsePAM configuration.

### Resolved during review. clean diagnostic secrets on scan failure

The scanner originally set a failing exit code when it found a match. The VM command wrapper then threw before the smoke parsed the reported paths or removed `/tmp/agent-cloud-token-needle`, the copied journal, and the scanner. Because failed runs deliberately preserve the diagnostic VM, the test itself would leave a plaintext token and lose the useful scanner output. The scanner now always emits bounded JSON, and the smoke removes all diagnostic copies in `finally` before rejecting any matches. Its `lstat`, `O_NOFOLLOW`, regular-file recheck, bounded byte count, and chunk-overlap search avoid symlinks, sockets, the cloud-init hotplug FIFO, and boundary misses. The successful VM run exercised normal cleanup; forced match/failure cleanup was established by code review, not a separate VM fault injection.

### Resolved during review. distinguish installed validity from signing start

Guest validation originally passed persisted `identity.issuedAt` to the PKI inspectors as the signing start. The server records that value after sequential issuance, so a slow CA sequence could reject a valid persisted certificate. The shared validity boundary now has separate `signing` and `installed` timing cases. Installed validation checks current validity, inclusion of `issuedAt`, and bounded total lifetime, while fresh signer validation retains the strict start-time bounds. Focused regressions cover slow signing and expired, future, and oversized installed periods.

## Correctness and security assessment

The filesystem protocol is well structured for process crashes. Keys are generated in a private sibling directory, essential files are flushed, the completed directory is renamed once, and a competing process adopts and revalidates the winner. Certificate files are validated before their directory is published. Same-directory temporary files, file and parent-directory syncs, no-follow reads, exact ownership/mode checks, bounded reads, fixed executables and argv, and generic tool errors materially limit substitution and disclosure. The revised `atomicWrite` explicitly applies its requested mode after creation, which is necessary under `UMask=0077` for the public proof and SSH principal files.

Enrollment retry preserves the guest keys and bootstrap token, and a lost successful response can recover through server replay. Once an installed bundle exists, restart validates the image, proof, private keys, certificate files, and issued identity before activation without another network request. A crash during cleanup remains recoverable because cloud-init is disabled and its instance/seed caches are removed before `bootstrap.json`. The first VM run found that cloud-init 26.1 also materializes the bootstrap in `/run/cloud-init/combined-cloud-config.json`; production cleanup now removes it before the local bootstrap. A crash after bootstrap deletion but before writing the final status can leave a stale `cleanup` status, but the durable installed identity is intact and boot will correctly skip enrollment; this is an observability issue rather than secret or identity loss.

The SSH policy pins the generated host key, trusts only the image user CA, permits only `agent-probe`, and disables passwords, root, forwarding, tunnels, TTYs, environment injection, and ordinary authorized keys. User certificates are separately constrained by the signer to the forced identity command. Caddy reads a group-limited copy of the TLS key, validates its JSON before restart, requires a client certificate on the external listener, and exposes readiness only on loopback. The external route is currently a 404 placeholder, so this does not establish runtime readiness.

The build downloads bounded artifacts to unique temporary files, checks pinned SHA-256 values before publication, builds a manifest tied to the guest bundle, and gives the installer a complete checksum inventory. The installer verifies that inventory, checks the installed Node/Docker/Compose versions, and prints the Caddy/Smallstep versions. It deliberately leaves builder access and machine state for a later sanitation step, so its output is not yet a reusable image.

## Evidence boundaries

The expanded enrollment smoke meaningfully exercises guest-library key generation, native Smallstep/OpenSSH issuance, a lost-response retry with stable keys, installed-certificate activation, bootstrap removal, replay without fresh signing, host-certificate SSH, and issued-leaf TLS. Its system hooks are fixture callbacks.

The first OrbStack Noble run completed real cloud-init/systemd enrollment and proved that installed sshd accepted the constrained host-CA login for the still-locked `agent-probe` account. Its scan exposed the additional cloud-init 26.1 combined-config cache, so it remained diagnostic evidence.

The subsequent clean run used guest image `dev-16e464e1b451` with manifest digest `8ec5f5a92dbcfc01381b9a80a1ccc2d219f8bba0e998c21727948ca58b25f82d`. It passed actual cloud-init/systemd enrollment, native host-CA SSH, Docker and Caddy health, rejection of TLS clients without a certificate, and a bounded scan of 135 regular files and 18,311,558 bytes with no bootstrap-token match. After a second reboot, identity, proxy service, and host-CA SSH passed again. The owned VM was deleted and its ownership record removed. This is strong local Linux integration evidence, but it does not prove Hetzner public-IP reachability or a sanitized shipped provider image. Runtime inspection, renewal, sanitation, and live gates remain outside this slice.

## Show-me-your-work audit

All six appended `M1-image` rows have the required six TSV fields and map to real implementation, test, or architecture evidence. The first four preserve the installer and focused-test checkpoints, including the review-triggered service-enablement fix and runtime-directory failure. The two outcome rows accurately record the combined-config discovery, bounded token scan, clean first boot, Caddy, post-reboot host-CA SSH, VM deletion, and absence of paid cloud resources. The run result is parent-supplied evidence; I did not operate the VM, and no transcript directory was supplied, so this is not an independent transcript audit.

The reviewer independently reran `tests/guest-files.test.ts` and `tests/certificate-validity.test.ts`: five tests passed. This checks the restrictive-umask publication behavior, no-follow and permission boundaries, destination-symlink replacement, and the split certificate timing rules. It does not substitute for the separately reported VM evidence.

**Attention:** the reviewed guest boot slice has no remaining high-confidence correctness or secret-exposure blocker. The forced scan-match cleanup path was reviewed statically rather than fault-injected. Keep live activation closed until image sanitation and snapshot ownership, worker runtime readiness, certificate renewal, operator recovery, and the bounded Hetzner drill are complete.

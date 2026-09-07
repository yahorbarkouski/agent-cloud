# Guest image and first boot

The development image targets Ubuntu 24.04 on x86. `pnpm build:guest` bundles the TypeScript CLI and verifies eight downloaded artifacts against `images/artifacts.json`. It stages only public CA trust, the guest bundle, tool archives, configuration and checksums in `.local/guest-builds/<manifest-digest>`, with a separate current-build pointer. Manifest format 2 binds the full public input inventory; see [image publication](image-release.md). It does not copy provider tokens, provisioner credentials or CA private keys.

Node 24.20.0, Smallstep 0.30.6, Caddy 2.11.4, Docker 29.8.0 and Compose 5.5.1 are pinned. Compose uses the current `docker compose` plugin. This updates the original plan's v2 wording. Ubuntu packages, including OpenSSH and cloud-init, receive the repository's security updates during installation. The installer records their exact versions in `/usr/lib/agent-cloud/os-packages.txt`. This is a recorded development build, not a claim of bit-for-bit reproducibility or a finished snapshot release pipeline.

The manifest records architecture, component versions, guest bundle hash and public trust. The allocation pins its complete manifest digest. `guestctl` checks that digest and the installed bundle before adopting bootstrap data. Snapshot IDs are assigned later and are not part of the pre-snapshot manifest. Release provenance and sanitized snapshot publication remain unfinished.

## Allocation identity

Cloud-init writes one root-only bootstrap file. An enabled systemd unit runs after `cloud-final.service`, with a filesystem lock, bounded attempts and a restrictive umask. It generates an Ed25519 SSH host key and P-256 TLS key/CSR in a private temporary directory, fsyncs the files and publishes the complete directory with one rename. A restarted attempt adopts the existing keys and checks both private/public key pairs; it never rotates a claimed identity.

The SSH probe account can read the public proof file and has no Docker group membership. The installed SSH configuration accepts certificates for the allocation principal, disables password and root login, and refuses forwarding and PTYs. Ubuntu socket activation is disabled, its runtime directory is created explicitly, and `ssh.service` is enabled for later boots. The short-lived control certificate forces `guestctl identity --json`.

The guest posts its token and proof over HTTPS. The control plane checks the guest's identity through native SSH to the provider-observed address before signing. The guest validates the returned key, name, CA, lifetime, CSR and image. It publishes complete certificate generations through an atomic current pointer, installs the SSH host certificate and starts Caddy under the separate `agent-proxy` user. Caddy receives a group-readable copy of its TLS key, never the SSH private key. Its admin and health listeners are loopback-only. Port 8443 requires client certificate verification and returns no application routes yet.

After a lost HTTP response, retry uses the same keys. After certificate publication, retry validates the stored bundle and reactivates it without needing the bootstrap token. Installed-certificate validity uses the persisted issuance timestamp as an issuance result, not as the beginning of the earlier CA calls. Renewal is still required before live activation.

## Bootstrap erasure

After the Linux service hooks succeed, guestctl creates `/etc/cloud/cloud-init.disabled` so future boots cannot repopulate the bootstrap caches from provider metadata. It removes cloud-init user/vendor data, the serialized datasource, local datasource seeds, sensitive and combined runtime configuration, and cloud-init logs. The local bootstrap is removed last so a crash during cleanup leaves a retry trigger.

A real Ubuntu boot exposed `/run/cloud-init/combined-cloud-config.json` as another token copy in cloud-init 26.1. Cleanup now includes it. The local smoke scans regular files under the cloud-init, guest, configuration and log directories, plus decoded systemd journal output. It skips sockets, symlinks and the hotplug FIFO, and limits total scanned bytes. Temporary search credentials and journal copies are removed even when the scan fails. Provider-side metadata is outside this erasure boundary; allocation expiry and the consumed server-side bootstrap still bound its usefulness.

## Verification boundaries

`smoke:enrollment` runs actual guest library key generation, lost-response retry, certificate installation and reactivation against the local control/PKI/OpenSSH fixture. Its activation hooks are fixture hooks.

`smoke:guest` creates one owned local OrbStack Ubuntu VM, installs the image, seeds the actual rendered cloud-init data, reboots through real cloud-init and systemd, and checks native SSH, Docker, Caddy, token erasure and a second reboot with host-CA SSH. The fixture disables cloud-init networking because OrbStack owns that local interface. Production Hetzner cloud-init networking remains unchanged and unverified. The script records ownership before creation, deletes the VM after success, and preserves its record for inspection on failure. It never calls the Hetzner API.

A local VM pass does not complete M1. Runtime readiness is implemented and described in [guest-runtime.md](guest-runtime.md). Sanitation and local clone verification are described in [image-sanitation.md](image-sanitation.md). The image factory subsequently passed a bounded Hetzner publication/cleanup drill. [Ongoing renewal](guest-renewal.md) now passes local native checks; customer runtime activation and broader operator recovery remain. Application deployment, customer access, routes, backups and restore belong to later milestones.

## Sanitation and snapshot boundaries

Sanitation targets a recorded builder with no customer allocation, then the caller stops it before cloning or snapshot publication. It removes builder access and machine-specific state while retaining public image inputs. `pnpm smoke:image` boots distinct clones with distinct allocation bootstrap data and verifies different machine IDs, SSH host keys and TLS keys, followed by enrollment/runtime checks and owned-resource cleanup. See the sanitation document for completed proof and remaining provider boundaries.

Cloud-init documents `clean --logs --machine-id --seed` for clearing cached initialization and obtaining a new systemd machine ID on the next boot. Generated network/config cleanup requires deliberate selection for each datasource; the local OrbStack network override must remain fixture-owned. See the [cloud-init CLI reference](https://docs.cloud-init.io/en/latest/reference/cli.html#clean). Local `orbctl clone --help` confirms that clones start stopped and copy the source state. Local clone results are recorded in the sanitation document.

Hetzner snapshots persist until explicitly deleted and exclude attached volumes. A builder VM cleanup alone therefore cannot finish a snapshot test. Track image ownership and deletion separately, and keep later database/volume restoration tests distinct. See [Hetzner snapshot documentation](https://docs.hetzner.com/cloud/servers/backups-snapshots/overview/). These are planning constraints; snapshot creation and billing have not been exercised.

Pinned artifacts come from [Node's official distribution](https://nodejs.org/dist/v24.20.0/SHASUMS256.txt), [Smallstep releases](https://github.com/smallstep/cli/releases/tag/v0.30.6), [Caddy releases](https://github.com/caddyserver/caddy/releases/tag/v2.11.4) and [Docker's Ubuntu repository](https://download.docker.com/linux/ubuntu/dists/noble/stable/binary-amd64/Packages). Caddy's JSON client-authentication configuration follows its [Go module documentation](https://pkg.go.dev/github.com/caddyserver/caddy/v2/modules/caddytls).

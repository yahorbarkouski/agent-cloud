# Guest bootstrap and verified readiness

Status: selected design; implementation is in progress. It does not yet enable live provisioning.

## Caller and phases

The caller uses the existing `acld machine create`, `operation wait`, and `machine inspect` commands. A provider allocation is not a ready guest. Create remains active through `waiting_guest/enrollment` and `waiting_guest/runtime`, then succeeds only after verified SSH, expected image, Docker, Compose, disk, and proxy checks. A boot deadline produces an explicit blocked state with resources reserved, not a second VM request.

```text
admission -> owned IPv4 -> prepare bootstrap reference -> journal VM create
                                                          |
                                  confirm provider VM <---+
                                           |
HTTPS enrollment proposal -> verify key at recorded provider IP
                                           |
                              sign and persist guest identity
                                           |
                              verify runtime -> create succeeds
```

## Durable data and secret boundary

One bootstrap belongs to one allocation and create operation. It stores a random 256-bit token hash, an AES-256-GCM encrypted token, expiry, image manifest, enrollment URL, and public CA trust. The encryption key lives in an owner-only operator file outside the database and guest. Authenticated additional data binds the envelope to the account, allocation, operation, image and enrollment URL, so swapping ciphertext between rows fails. Use Node's crypto APIs, not a custom cipher.

The `create_guest` provider command stores only a stable bootstrap reference. Historical `create` commands remain readable and reconcilable; the live adapter rejects fresh legacy submissions. The renderer requires the exact recorded prepared attempt and its live allocation before recovery. Structural comparison ignores PostgreSQL JSON object key order. It never stores plaintext token, full user data, SSH private keys, or CA credentials. The transport receives an injected renderer that loads/decrypts the reference in memory immediately before the initial VM request. The saved bootstrap fixes its inputs and image choice. The existing prepared/unknown attempt is reconciled after a crash and is never resent merely because its payload can be reconstructed.

Bootstrap creation is idempotent by allocation under the machine lock and database uniqueness. Reuse the existing record without extending expiry or changing token/image/URL. Expiry after submission requires operator recovery or explicit cleanup, not silent identity replacement. After enrollment, erase recoverable ciphertext; retain the token hash until its bounded retry expiry so a lost enrollment response can return the same persisted certificates for the same keys. No bootstrap table appears in customer JSON or audit payloads.

## Enrollment and network proof

The guest creates fresh SSH host keys and a TLS private key/CSR. A narrow HTTPS endpoint accepts the token, allocation reference, host public key, TLS CSR, and image version. It validates bounds, token, expiry, allocation status and provider-owned VM/IP records. Metadata claimed by the guest is not proof of location.

Before issuing certificates, the control plane connects with ordinary OpenSSH to the IP from its provider observation, never a caller-supplied address. It pins the submitted host public key in a private temporary known-hosts file and authenticates with a short-lived internal user certificate for that allocation. The guest trusts only the platform public user CA and its own allocation principal. The probe reads the locally generated TLS CSR, image manifest and allocation identity over that verified SSH connection and compares them with the enrollment proposal. This proves possession of the host private key on the recorded server and binds the TLS key before signing. A leaked bootstrap token alone cannot substitute keys from another host.

The endpoint does not trust `X-Forwarded-For` or another caller-provided network header. This permits a temporary HTTPS tunnel for development even though its socket peer is the tunnel. The tunnel exposes only the bounded enrollment endpoint; the worker still dials the recorded public IP directly. A LAN address is not presumed reachable from Hetzner. Production uses the configured public HTTPS API URL.

Claim a key digest under the allocation lock before signing, after the probe succeeds. Signing can happen outside a database transaction through the isolated CA; a concurrent or restarted attempt may sign only the claimed keys. Persist the first certificate result, encrypted-token erasure, runtime phase, audit event and worker wakeup in one transaction. Return the same result on same-key retries. Replay can repair a matching enrollment handoff but cannot reopen blocked or completed operations. A changed key/CSR or image is rejected. Never sign based solely on an existing server plus a token.

## Modules and tools

- `guest-bootstrap.ts` owns allocation bootstrap records and encrypted token recovery.
- `guest-enrollment.ts` owns key proposals, provider/SSH proof, immutable identity claims and persisted certificates.
- `guest-readiness.ts` checks the signed host certificate and runtime, then completes the existing operation.
- `packages/remote` wraps native `ssh` and `ssh-keygen` with fixed arguments, private temporary files, timeouts and bounded output. No shell interpolation or TypeScript SSH implementation.
- `packages/pki` calls Smallstep with isolated signing credentials. Gateways and guests receive public CA trust only. M1 internal verification certificates do not implement M2 customer tickets or revocation.
- `packages/guestctl` exposes machine-readable local inspection. `images/` contains pinned build inputs, sanitation and first-boot enrollment scripts.

OpenSSH host aliases use the allocation identity so replacement machines cannot reuse a predecessor's host principal. Runtime probes use only a host CA trust file, explicit identity/certificate files, strict host verification, and no inherited SSH agent or user config. Guest TLS is separately verified against the platform CA and recorded identity.

## Image and low-cost verification

Implemented locally on 2026-09-07: encrypted bootstrap storage and SQL guards, API catalog refresh, Smallstep signing, and native SSH identity reads. `pnpm smoke:pki` verifies real local TLS; `pnpm smoke:ssh` verifies a disposable OpenSSH server and negative identity cases. The enrollment endpoint and provider reference rendering now compose with these packages. `pnpm smoke:enrollment` proves the HTTP/storage/signing/SSH path with a local provider fixture and verifies the returned SSH/TLS certificates through real connections. Startup activation, image boot and runtime completion remain unwired.

SSH host and probe keys use Ed25519. TLS guest keys use ECDSA P-256, checked through Node's native SPKI parser. The development CA has separate ECDSA P-256 SSH signing keys. Its templates issue one-hour server-only TLS certificates, one-hour SSH host certificates, and five-minute probe user certificates with only a forced identity command and no forwarding/PTY extensions. The signer inspects exact key and CA fingerprints, principal, type, options and validity before returning a certificate. Native SSH verifies certificate signatures during connection.

Probe issuance is explicit and returns a short-lived in-memory credential. SSH reads reuse that credential and do not contact the CA. Migration 0007 records immutable signing attempts before CA calls and enforces 12 probe issuances and 4 identity signing attempts per bootstrap. A process-local cache reuses probe credentials; restart consumes a new durable slot. Retries have a 30-second application cooldown. Expiry, signing cooldown, cached credential reuse, issuance and consumption now use PostgreSQL time. Completion rechecks active ownership and expiry after signing under allocation/bootstrap row locks. CA/SSH and guest request validation still require synchronized machine clocks. Ongoing [guest renewal](guest-renewal.md) has a separate persistent allowance; customer access remains M2 work. The current TLS template does not issue client certificates.

Build and boot are distinct. An image build installs pinned OpenSSH, Docker, Compose, Caddy and guestctl, writes a versioned manifest, then removes SSH/TLS private keys, machine-id, cloud-init instance state, credentials and build logs. Shipped first boot generates fresh identity and enrolls; it does not install an entire toolchain for each customer.

Verify token/row substitution, same-key retries, conflicting-key races, expiry, redaction, wrong provider IDs, wrong SSH keys, wrong TLS CSR and runtime failures locally. A real disposable SSH server exercises certificate and process behavior. This does not prove systemd or cloud-init.

Then use one bounded cheap Hetzner image-build VM and a bounded boot from its sanitized snapshot, with explicit gross price ceilings, a test deadline, and cleanup of all recorded VM/IP/snapshot resources. Refresh current prices first. Snapshot ownership and cleanup must be included before the image build test. No warm pool or expensive fallback is permitted.

## Synthesis and tradeoffs

A is the base for allocation-owned encrypted bootstrap and distinct guest phases. Parent scores were A 20, B 13, C 16 out of 25; the independent judge scored A 20, B 15, C 16. Both selected A. Take B's concrete OpenSSH/runtime/mTLS checks and sanitation list; take C's distinction between provider allocation and verified completion. Reject B's plaintext cloud-init journal and C's missing ciphertext storage and assumed LAN reachability. Tighten A's provider boundary to a reference-only command.

The source-address-only design would require exposing the local API directly. The synthesis instead proves the proposed key over a direct connection to the recorded provider IP before signing. That is an explicit adaptation for temporary enrollment tunnels, with a corresponding wrong-key test required. The tunnel is transport, never identity evidence.

We accept encrypted recoverable bootstrap material until enrollment in exchange for crash-safe preparation. The operator must preserve its sealing key in platform recovery. We accept one internal certificate/probe step before enrollment to avoid depending on proxy source headers. Public customer SSH transport, certificate renewal and revocation remain M2 work, not claims of this slice.

Cloud-init rendering uses fixed paths, an owner-only bootstrap file, disabled metadata SSH-key import and a fixed systemd start command. Guest image setup must supply that service, remove cloud-init copies of the bootstrap after enrollment, and verify the configuration on a real boot. Rendering alone does not demonstrate those behaviors. The renderer follows the documented [cloud-init SSH, write_files and runcmd modules](https://docs.cloud-init.io/en/latest/reference/modules.html).

Sources: [OpenSSH key and certificate tooling](https://man.openbsd.org/ssh-keygen), [Smallstep SSH certificate command](https://smallstep.com/docs/step-cli/reference/ssh/certificate/), [Node authenticated encryption](https://nodejs.org/docs/latest-v24.x/api/crypto.html). The integration and proof sequence above is our design, not a claim made by those sources.

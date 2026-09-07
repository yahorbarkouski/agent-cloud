# Image verifier identity grounding

Baseline: `f440c55`

## Overview

The implemented guest identity path is allocation-owned end to end. A customer allocation ID is present in the bootstrap row primary key, the encrypted bootstrap spec, the guest-generated proof, the SSH host certificate name, the TLS certificate DNS name, the probe and runtime user certificate principals, the enrollment request, the proxy readiness response and the runtime inspection result.

That does not mean the verifier should create a fake customer allocation. The useful reusable pieces are below the allocation storage layer: image manifest validation, local key and CSR validation, SSH/TLS certificate inspection, fixed-command SSH probing and read-only runtime inspection. The allocation-owned tables and API schemas should stay customer-only. A platform verifier needs its own build-owned bootstrap/enrollment record and explicit identity subject, then can reuse the same cryptographic checks with verifier-specific names and principals.

## Exact call and data flow

### 1. Control plane prepares an allocation bootstrap

Fact: `apps/control/src/guest-bootstrap.ts` writes one `guest_bootstraps` row per allocation through `prepareGuestBootstrap()`. It only accepts a live `machine.create` operation whose account and machine match the allocation. The resulting `BootstrapSpec` includes `accountId`, `machineId`, `allocationId`, `operationId`, `expiresAt`, `enrollmentUrl` and `image`.

Fact: the database schema makes `guest_bootstraps.allocation_id` the primary key and foreign-keys it to `allocations(account_id, id)`. `guest_identities` and `guest_signing_attempts` also hang off that bootstrap. The SQL guards retain history, keep bootstrap identity immutable, allow token erasure only after an issued identity exists, and require signing attempts to belong to an active unconsumed bootstrap.

Fact: `recoverGuestBootstrap()` joins `guest_bootstraps` back to `allocations`, rejects retired allocations, validates the JSON `BootstrapSpec` against the row and decrypts the token using authenticated data derived from the full parsed spec. It returns `{ spec, token }`.

Suggestion: a verifier bootstrap should not call `prepareGuestBootstrap()` or write `guest_bootstraps`. Its sibling table can copy the same shape of invariant, but the foreign key should point to an image build or verifier boot record, not `allocations`.

### 2. Provider boot rendering writes the guest bootstrap file

Fact: `apps/control/src/guest-renderer.ts` calls `recoverGuestBootstrap()` only for the exact prepared `create_guest` attempt. It checks the allocation is live, the attempt is still prepared and pending, the command equals the journaled command, the server type/region/name match the admitted offer, and the command labels match the bootstrap account, machine, allocation and operation.

Fact: the rendered cloud-init writes `/var/lib/agent-cloud/bootstrap.json` as root-owned mode `0600` with:

```json
{
  "spec": "...BootstrapSpec...",
  "token": "...random enrollment token..."
}
```

Fact: cloud-init disables generated SSH host keys by setting `ssh_keys: {}` and `ssh_publish_hostkeys.enabled: false`. The image relies on `guestctl` to create the durable guest SSH host key during enrollment.

Suggestion: a verifier renderer can reuse the same pattern of recovering a sealed bootstrap immediately before first submission and writing the same file path, but its command labels and spec should name the image build verifier, not a customer allocation.

### 3. guestctl validates image inputs before making identity

Fact: `packages/guestctl/src/cli.ts` runs `guestctl enroll --json` as root. The systemd unit `images/systemd/agent-cloud-enroll.service` starts it after `cloud-final.service` when `/var/lib/agent-cloud/bootstrap.json` exists.

Fact: `enrollGuest()` in `packages/guestctl/src/enrollment.ts` calls `loadBootstrap()`, which reads `bootstrap.json`, parses `guestBootstrapFileSchema`, and calls `verifyImage()`.

Fact: `verifyImage()` in `packages/guestctl/src/identity.ts` loads the installed image manifest, hashes its canonical JSON, verifies the on-disk `guestctl` binary digest, and compares the bootstrap image fields to the manifest: digest, version, architecture, SSH host CA, SSH user CA and TLS root.

Fact: `guestSystem.prepareIdentity()` in `packages/guestctl/src/system.ts` calls `validateImageBoot()`. For a fresh clone this requires `/usr/lib/agent-cloud/image-build.json` to be a sanitized builder record with the same manifest digest, a fresh machine ID and a different machine ID from the builder. On retry after consumption, existing allocation metadata may substitute for the removed image record only if allocation and manifest still match.

Suggestion: `loadManifest()` and `verifyImage()` are reusable for verifier boots as-is. `validateImageBoot()` mostly is, but its lost-response retry currently checks `allocation.json`; a verifier path needs an equivalent verifier-state retry file rather than an allocation file.

### 4. guestctl generates host key, TLS key, CSR and public proof

Fact: `ensureIdentity()` in `packages/guestctl/src/identity.ts` creates `/var/lib/agent-cloud/keys` exactly once. If the directory already exists, `storedIdentity()` revalidates the existing private keys, CSR and proof against the current bootstrap spec.

Fact: for a new identity, `ensureIdentity()` runs:

- `ssh-keygen -t ed25519 -N "" -C "" -f ssh_host_ed25519_key`
- `step certificate create <guestName> guest.csr guest.key --csr --kty EC --curve P-256 --no-password --insecure --san <guestName>`

Fact: `guestName(allocationId)` in `packages/pki/src/index.ts` turns an allocation ID into a DNS name by replacing `alloc_` with `alloc-` and appending `.guest.agent-cloud.internal`. That name is both the CSR common name and the only DNS SAN.

Fact: `ensureIdentity()` writes `proof.json` containing `version`, `allocationId`, `imageVersion`, `manifestDigest`, `sshHostPublicKey` and `tlsCsr`. `storedIdentity()` verifies that proof still matches the allocation, image version, manifest digest, SSH private key and TLS private key.

Suggestion: the reusable primitive is "make or adopt a local key directory for an explicit identity subject and image digest." Today the subject is derived from `AllocationId`. A verifier-safe shared function should take a validated subject object, derive a verifier DNS name without using `alloc_`, and produce the same key/CSR/proof checks for that subject.

### 5. guestctl exposes raw proof over a restricted SSH probe

Fact: after proof generation, `guestSystem.prepareSsh()` copies the image-owned sshd config, stops Ubuntu's socket unit, writes public `/var/lib/agent-cloud/proof.json`, writes `/var/lib/agent-cloud/probe-principals`, validates sshd and restarts `ssh.service`.

Fact: the authorized probe principals are `probe-${allocationId}` and `runtime-${allocationId}`, generated by `probePrincipal()` and `runtimePrincipal()` in `packages/pki/src/index.ts`.

Fact: before enrollment completes, the control plane uses `createGuestProbe().readIdentity()` from `packages/remote/src/index.ts`. That function requires a probe credential whose `allocationId` matches the requested `allocationId`, uses an allocation-derived SSH alias from `guestName()`, pins the submitted raw host public key in an isolated trust file, disables inherited SSH config and agents through `withSshFiles()`, and runs only:

```text
/usr/local/bin/guestctl identity --json
```

Fact: `readIdentity()` parses `guestProofSchema` and checks the returned `allocationId` matches the target. In raw-key mode it also checks the returned host public key matches the pinned key.

Suggestion: this SSH machinery is reusable if the target type stops assuming `AllocationId`. A shared read function should accept an explicit alias, expected proof subject, trust mode and credential, then run the same fixed command through the same isolated SSH files. Verifier proof should be checked against the verifier boot record and pinned snapshot metadata, not against an allocation row.

### 6. Enrollment verifies provider ownership before signing

Fact: the public HTTP endpoint in `apps/control/src/app.ts` POSTs `/guest/enroll` into `createEnrollmentService().enroll()` with `guestEnrollmentInputSchema`.

Fact: `guestEnrollmentInputSchema` carries only a bootstrap reference `{ version: 1, allocationId }`, token, SSH host public key, TLS CSR and image version. The guest constructs this request in `enrollGuest()` after `prepareSsh()`:

```json
{
  "bootstrap": { "version": 1, "allocationId": "..." },
  "token": "...",
  "sshHostPublicKey": "...",
  "tlsCsr": "...",
  "imageVersion": "..."
}
```

Fact: `createEnrollmentService()` reloads the bootstrap under the machine lock, verifies the token hash, checks expiry, ensures the machine.create operation is waiting for enrollment, checks exactly one confirmed server-create attempt for the allocation server, compares signer trust to the image trust, and calls `observeGuest()` to obtain the provider-observed address.

Fact: before signing, the service calls `signer.validateTlsRequest({ allocationId, csr })` and `probe.readIdentity({ allocationId, address, trust: pinned_key, credential })`. `validateTlsRequest()` uses `readCsrKey()` to require an ECDSA P-256 CSR whose common name and only DNS SAN equal `guestName(allocationId)`. `readIdentity()` proves the key and CSR are present on the host reached at the owned provider address.

Fact: only after that proof does the service insert a claimed `guest_identities` row, reserve an identity signing attempt, call `signer.signHost()` and `signer.signTls()`, update the identity to issued, consume the bootstrap token and hand the operation to runtime readiness.

Suggestion: the verifier should keep this order. The concrete reusable shape is:

- load a build-owned verifier bootstrap and token
- observe the verifier server and address from the image build resource journal
- validate the TLS CSR for the verifier DNS name
- read proof over direct SSH to the observed address with the submitted raw host key pinned
- claim immutable verifier keys in a verifier-owned table
- sign host/TLS certificates with verifier-specific names and principals

The part to avoid reusing is the customer machine lock, allocation foreign keys and `guest_identities` row.

### 7. Certificate and credential names are allocation-derived today

Fact: `packages/pki/src/index.ts` owns all current name derivation:

- `guestName(allocationId)` returns `<alloc-id-with-dashes>.guest.agent-cloud.internal`
- `probePrincipal(allocationId)` returns `probe-${allocationId}`
- `runtimePrincipal(allocationId)` returns `runtime-${allocationId}`

Fact: `createSigner().signHost()` signs an SSH host certificate with one principal, `guestName(allocationId)`, valid for at most one hour. `signTls()` signs a TLS certificate for the same DNS name, also valid for at most one hour.

Fact: `issueProbeCredential()` and `issueRuntimeCredential()` generate fresh Ed25519 user keys and call the same internal SSH signing path. Probe/runtime user certificates are valid for at most five minutes and carry forced commands. `inspectIssuedSsh()` rejects any probe/runtime certificate without the expected force-command:

- probe: `/usr/local/bin/guestctl identity --json`
- runtime: `/usr/bin/sudo -n -- /usr/local/bin/guestctl inspect --json`

Fact: `inspectIssuedTls()` rejects TLS leaves unless the SAN, host check, server auth usage, public key and lifetime match the expected name/key.

Suggestion: these validation functions are the safest reuse point. `readCsrKey()`, `inspectIssuedSsh()` and `inspectIssuedTls()` already accept explicit names/principals. The signer API should grow name/principal based helpers or a discriminated identity subject, rather than forcing verifier code to manufacture an `AllocationId`.

### 8. Runtime inspection is privileged but narrowly scoped

Fact: runtime readiness uses `createGuestReadiness()` in `apps/control/src/guest-readiness.ts`. It requires an issued guest identity for the allocation, reserves bounded runtime signing attempts, issues a runtime credential for the allocation and calls `probe.readRuntime()` with host-CA trust.

Fact: `createGuestProbe().readRuntime()` only accepts a runtime credential and host-CA trust. It runs:

```text
/usr/bin/sudo -n -- /usr/local/bin/guestctl inspect --json
```

Fact: the guest image sudoers file grants `agent-probe` exactly that command as root with `NOPASSWD`, `NOSETENV`, `env_reset` and a fixed secure path. It does not grant Docker access or general sudo.

Fact: `guestctl inspect --json` runs as root because it reads local proof, checks the manifest/binary, reads `/proc/sys/kernel/random/boot_id`, checks component versions, checks disk headroom across guest state and Docker paths, and checks the local Caddy readiness endpoint. It returns `GuestRuntime`, which includes the original `GuestProof`, the manifest, architecture, boot ID and health checks.

Fact: `createGuestReadiness()` independently recomputes the manifest digest and compares runtime proof, persisted issued identity, image version, manifest digest, manifest architecture, runtime architecture, component versions, disk headroom, proxy allocation ID/image version and boot ID behavior for reboot/power-on.

Suggestion: a verifier can reuse the forced runtime inspection model, but the readiness checker should be parameterized by verifier evidence. The current `GuestRuntime` schema embeds `GuestProof`, and `GuestProof` embeds `allocationId`. A verifier path needs either a sibling `VerifierRuntime`/`VerifierProof` schema or a discriminated `GuestProof` subject that preserves strict subject comparison without pretending the verifier is a customer allocation.

## Concrete shared functions to factor or reuse

Facts, already reusable with little or no change:

- `packages/guestctl/src/identity.ts`: `loadManifest()` and `verifyImage()` verify image manifest, binary digest and trust bundle against a supplied spec.
- `packages/pki/src/index.ts`: `readCsrKey()` validates a CSR for a supplied DNS name and P-256 key.
- `packages/pki/src/ssh-certificate.ts`: `inspectIssuedSsh()` validates certificate type, key fingerprint, CA fingerprint, key ID, principal, force-command and lifetime.
- `packages/pki/src/tls-certificate.ts`: `inspectIssuedTls()` validates TLS SAN, hostname, server-auth usage, public key and lifetime.
- `packages/remote/src/index.ts`: the OpenSSH execution pattern uses isolated trust, explicit credentials, no inherited SSH config, no agent and fixed commands.
- `packages/guestctl/src/inspect.ts`: `inspectRuntime()` collects read-only runtime evidence and marks component failures as explicit `unavailable` checks.

Suggestions, concrete extraction targets:

- Add a validated identity subject type near contracts or PKI, for example customer allocation subject and image verifier subject. It should derive DNS names and probe/runtime principals from the subject, not from raw strings at call sites.
- Split `guestName()`, `probePrincipal()` and `runtimePrincipal()` into subject-based helpers. Keep the current allocation wrappers for customer callers.
- Add signer methods that accept explicit subject-derived names and principals: host SSH signing, TLS request validation/signing, probe credential issuance and runtime credential issuance. The existing allocation methods can call these.
- Split `createGuestProbe().readIdentity()` and `readRuntime()` into lower-level functions that accept expected subject, SSH alias, trust and credential. Keep allocation wrappers that parse `guestProofSchema` and compare allocation IDs.
- Split guestctl identity creation around "ensure key directory for subject and image." The current wrapper can keep writing `GuestProof`; verifier code can write a verifier proof with the same key/CSR validation.
- Split `guestSystem.prepareSsh()` around "publish proof and allowed principals." The current wrapper can keep deriving allocation principals; verifier enrollment can publish verifier principals.
- Add verifier-owned enrollment storage and request schemas instead of reusing `guestEnrollmentInputSchema`, `guest_bootstraps`, `guest_identities`, `guest_signing_attempts` or `runtime_signing_attempts`.

## File map

- `packages/contracts/src/guest.ts`: public schemas for `GuestImage`, allocation bootstrap specs/references, enrollment input, claimed/issued identity, proof, manifest and runtime evidence.
- `packages/pki/src/index.ts`: allocation-derived names/principals, Smallstep signing wrapper, CSR validation and probe/runtime credential issuance.
- `packages/pki/src/ssh-certificate.ts`: strict OpenSSH certificate inspection, including forced commands.
- `packages/pki/src/tls-certificate.ts`: strict X.509 leaf inspection.
- `packages/remote/src/index.ts`: fixed OpenSSH probe and runtime reads.
- `packages/guestctl/src/cli.ts`: root-gated guest commands and unprivileged identity command.
- `packages/guestctl/src/enrollment.ts`: first-boot enrollment sequence and HTTP request.
- `packages/guestctl/src/identity.ts`: manifest verification, local SSH/TLS key generation, proof creation and certificate bundle installation.
- `packages/guestctl/src/system.ts`: Linux system changes during enrollment, SSH principal publication, host certificate activation, proxy config and bootstrap erasure.
- `packages/guestctl/src/inspect.ts`: privileged runtime evidence collection.
- `packages/guestctl/src/image.ts`: builder sanitation and sanitized-image boot checks.
- `apps/control/src/guest-bootstrap.ts`: allocation-owned sealed bootstrap creation and recovery.
- `apps/control/src/guest-renderer.ts`: exact prepared-attempt rendering of `/var/lib/agent-cloud/bootstrap.json`.
- `apps/control/src/guest-enrollment.ts`: customer guest enrollment, provider-address SSH proof, identity claim/sign/consume and runtime handoff.
- `apps/control/src/guest-readiness.ts`: runtime SSH proof and readiness decision.
- `packages/db/migrations/0006_guest_identity.sql`: allocation bootstrap and identity tables and immutability guards.
- `packages/db/migrations/0007_guest_signing_attempts.sql`: allocation enrollment signing budgets.
- `packages/db/migrations/0008_guest_runtime.sql`: allocation runtime signing budgets.
- `images/systemd/agent-cloud-enroll.service`: root first-boot enrollment service.
- `images/guest-inspect.sudoers`: exact sudo grant for runtime inspection.
- `docs/architecture/image-release.md`: states the open verifier requirement and rejects fake customer allocations.

## Gotchas

- `GuestProof` is public and allocation-specific. Reusing it for verifier evidence would either require a fake allocation ID or blur what an allocation proves.
- The unprivileged `guestctl identity --json` command reads `/var/lib/agent-cloud/proof.json`, which `prepareSsh()` writes only after local key generation. Runtime inspection reads the same proof after enrollment and certificate activation.
- `readIdentity()` checks the host public key only in raw-key mode. Runtime uses host-CA trust and relies on persisted identity comparison in `createGuestReadiness()`.
- Probe and runtime credentials are both SSH user certificates for the `agent-probe` Unix user. Their safety comes from distinct principals, five-minute lifetime and force-command certificate options.
- The runtime path is intentionally privileged on the guest, but privilege is bounded to one sudo command. Expanding the sudoers grant would weaken the proof model.
- `validateImageBoot()` consumes the image build record before SSH restart. After that, retry behavior falls back to stored allocation metadata. Verifier retry needs its own stored metadata before consuming the image record.
- Customer enrollment signing budgets are enforced by allocation bootstrap state. Verifier signing budgets need separate rows because the verifier bootstrap should not satisfy `guest_signing_attempts` or `runtime_signing_attempts` foreign keys.
- Host and TLS certificates are one-hour credentials. Probe/runtime credentials are five-minute credentials. A verifier should preserve those lifetimes unless release verification has a stronger reason and matching validation tests.

# Operator runtime

The production entrypoints support `PROVIDER=hetzner` with explicit `image_factory` or `customer` configuration. The factory serves `/image/enroll` and runs only image-build jobs. Every `/v1/*` customer endpoint returns 403 there, and customer guest endpoints are absent. Customer mode serves authenticated lifecycle APIs, `/guest/enroll` and `/guest/renew`, and runs only customer operation jobs. Simulated development remains the default. Customer runtime composition has local protocol verification; customer destroy now cancels blocked provisioning through durable cleanup. The separate [operator recovery command](operator-recovery.md) records explicit source closure and bounded retry authority. A customer Hetzner boot remains open.

Startup and image admission create no cloud resource. `image:build start <build-id>` records explicit, durable permission to advance an admitted build. That command can incur charges when an image worker is running. Global and per-build image caps, pinned prices, exact provider ownership, deadlines and cleanup remain enforced by the existing SQL journals. A configured worker reconciles unfinished builds each minute, including cleaned builds whose local key removal is incomplete.

## Persistent identity

Run `pnpm setup:runtime /absolute/private/identity-directory` once. The command creates an independent 32-byte bootstrap encryption key and an Ed25519 image release key. It prints only paths and the public release key ID. Repeated setup verifies the original identity; it never replaces keys or extends validity. Files and the containing directory are owner-only. Identity metadata binds the bootstrap key hash and release public key ID. A crash leaving incomplete setup fails explicitly; restore the original files rather than rerunning setup to create a different identity for live bootstraps.

The directory contains `bootstrap.key`, `release.key`, `identity.json` and `release-policy.json`. Back up this whole directory with the control database and the CA/provisioner recovery material. Keep those backups outside source control. Loss of the bootstrap key prevents recovering unconsumed bootstrap tokens. Loss of the release private key prevents new publication. Existing signed releases need only their public policy for verification.

The initial public key policy permits signing for 90 days and verification for 120 days. These are explicit setup defaults, not automatic renewal. An operator maintains the policy before those windows end. `release-policy.json` has `{ "version": 1, "keys": [...] }`. A trusted entry contains `kind`, `publicKey`, `signedFrom`, `signedUntil` and `verifyUntil`. A revocation entry contains `{ "kind": "revoked", "keyId": "<public-key-sha256>" }`. Revocation wins if both forms are present. Empty trust denies every release.

Replace the policy atomically with an owner-only file. Every release authorization reloads it; a missing, malformed, duplicate or unsafe policy fails closed without cached fallback. An active build whose signer is revoked requests cleanup. Temporary policy-read failure retries until the durable deadline, after which cleanup remains independent of the policy. The runtime rechecks signer authorization when rendering an exact prepared VM effect.

The API and worker cache private identity, CA configuration and short-lived probe credentials within each process. Policy changes take effect without restarting. Changes to the bootstrap key, release private key, CA trust or provisioner credential require restarting both processes. Restore matching original material for existing work. A replacement CA also requires new image inputs and a newly verified release; it cannot sign identities for a guest pinned to the old CA. Automated private-key rotation remains future work.

## Configuration

`AGENT_CLOUD_RUNTIME` selects an owner-only JSON file, default `.local/runtime.json`. All paths in it must be absolute. `PUBLIC_URL` must be a reachable HTTPS origin with no credentials, path, query or fragment. The enrollment URL is that origin plus `/image/enroll`. The private CA URL is separate and only the control process needs to reach it.

```json
{
  "version": 1,
  "mode": "image_factory",
  "identityDirectory": "/srv/agent-cloud/private/identity",
  "images": {
    "inputsDirectory": "/srv/agent-cloud/images",
    "accessDirectory": "/srv/agent-cloud/private/image-access",
    "limits": {
      "currency": "USD",
      "maxOpenBuilds": 1,
      "maxVmGrossMicros": 120000,
      "maxSnapshotMonthlyGrossMicros": 1000000
    }
  },
  "pki": {
    "binary": "/srv/agent-cloud/bin/step",
    "caUrl": "https://ca.internal.example",
    "tlsRootFile": "/srv/agent-cloud/trust/root_ca.crt",
    "sshHostCaFile": "/srv/agent-cloud/trust/ssh_host_ca_key.pub",
    "sshUserCaFile": "/srv/agent-cloud/trust/ssh_user_ca_key.pub",
    "provisioner": "agent-cloud-control",
    "provisionerPasswordFile": "/srv/agent-cloud/private/provisioner-password"
  }
}
```

These example caps are integer millionths of USD: $0.12 reserved VM/IP cost and $1.00 monthly snapshot allowance. They are not a price quote. Current gross prices must fit the exact admission. Set `PROVIDER_CURRENCY` to the account currency and an explicit `MAX_PROVIDER_HOURLY`; image spending uses the separate image limits above. There is no currency conversion or automatic region/type substitution.

Public input directories are named by their manifest digest beneath `images.inputsDirectory`. For local development, `build:guest` publishes them beneath `.local/guest-builds`. The configured CA trust must exactly match the admitted manifest. The runtime verifies the complete local tree and builder access before its first resource effect. SSH upload verifies the tree again before transfer, avoiding repeated hashing of large artifacts on every worker poll.

Use the same `IMAGE_ACCESS_DIRECTORY` for `image:build prepare` and `image:build cleanup` as the runtime's `images.accessDirectory`. The preparation command returns public access metadata; the worker recovers the private keys from that directory. The provider token comes only from owner-only `HCLOUD_TOKEN_FILE`. Public CA files may be readable but cannot be writable by other users. All operator file reads are bounded and refuse a final symlink.

After database migration and configuration, `pnpm dev` serves the image factory and `pnpm worker` runs its Graphile tasks. The API checks identity and public policy before listening. The worker loads signing material lazily so cancelled and expired work can still clean up after credential loss. PostgreSQL time controls image expiry and destructive cleanup; local process time is not authority to delete a valid retained image.

Run `PUBLIC_URL=https://your-origin.example pnpm runtime:check` to verify public HTTPS reachability and the factory's route restrictions. It checks health200, disabled customer403, invalid verifier input400 and absent customer enrollment404. It sends no token and creates no resource. A [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) can supply a temporary test origin without another VM or a domain. Quick tunnels are for development and their random URL changes when the process restarts. Keep the selected tunnel alive for a bounded drill; an existing bootstrap retains its original URL.

## Customer configuration and recovery availability

Customer mode uses the same `version`, `identityDirectory` and `pki` fields, replacing `images` with:

```json
{
  "mode": "customer",
  "releaseBuildId": "<retained-image-build-uuid>",
  "firewallIds": [123456]
}
```

This is a configuration fragment. Supply the common fields too, and use actual owned IDs. `firewallIds` contains one to five distinct firewall IDs in the configured provider project. Each firewall must have labels `managed_by=agent-cloud`, `role=customer_access` and exactly two inbound TCP rules for public IPv4 ports22 and8443, with no destination IPs or outbound rules. The rules exported as `customerFirewallRules` are the operator setup contract. Customer processes only read them; they do not create or repair network resources. Certificate authentication protects SSH. The guest's initial HTTPS listener is Caddy on8443 with mutual TLS, so opening80/443 does not make it reachable. Public application routing remains unfinished; these guest ports do not establish a public application endpoint.

A customer create pins the configured release in the admission transaction. Historical enrollment-only images remain auditable, but both admission and subsequent resolution require the renewal service and timer in the signed input inventory. Fresh effects observe the exact pinned snapshot, current signing policy, configured CA trust and firewall rules. Rendering rechecks those conditions. Guests receive no provider SSH keys or provider credentials. The default release never replaces an allocation's existing pin.

Customer processes read `bootstrap.key` and its metadata without opening `release.key`. Mount only the bootstrap identity, public release policy and required PKI files into them. Preserve the release signing key in the factory/backup environment. Public policy reloads for each release authorization; private changes require restarting both customer processes.

`runtime:check` in customer mode performs explicit read-only PKI, release, CA-trust and firewall preflight, then checks public health, customer authentication and guest route registration. This preflight is deliberately separate from API/worker startup. Missing bootstrap or PKI files, unavailable pricing or an expired default image must not prevent authenticated recovery reads and already-admitted cleanup. Each fresh-create or guest operation loads its own required material. Renewal and runtime inspection need the signer but never the bootstrap seal; losing that seal must affect only fresh bootstrap preparation and enrollment. Provider credentials and PostgreSQL are still required. The existing create controller compensates a known unused IP when guest preparation fails; uncertain VM creates retain ownership and never retry blindly.

Run image and customer workers as separate processes with their respective config files. Keep the image worker available for retained snapshot expiry and cleanup. This does not start a warm pool. The customer worker uses a bootstrap callback instead of holding a seal in its configuration, which keeps exact-resource reconciliation independent of private guest material.

Customer power-off now calls the provider's [shutdown endpoint](https://raw.githubusercontent.com/hetznercloud/hcloud-go/main/hcloud/server.go), matching the earlier image durability correction. An acknowledged request alone does not prove the VM is off; the journal observes its state before completion. There is no force-off fallback.

Customer destroy supplies the provisioning cancellation path. Operator recovery now handles explicit source closure and deletion retry exhaustion. The first live customer drill still requires a renewal-capable retained release, owned customer firewall setup and a bounded lifecycle/cleanup exercise. No live customer VM is claimed from the protocol fixture.

## Recovery without signing credentials

`pnpm image:build cancel <build-id>` records cancellation and wakes the worker. `pnpm image:build cleanup <build-id>` performs one recovery pass directly. Repeat the latter until inspection reports `cleaned` and a nonnull `accessRemovedAt`, or leave the configured worker to reconcile. It requires only `DATABASE_URL`, `HCLOUD_TOKEN_FILE`, the exact build ID and `IMAGE_ACCESS_DIRECTORY`. It does not read the runtime JSON, bootstrap key, release private key, source inputs, price service or CA credentials. Its provider renderer rejects server creation and the journal accepts only deletion commands without spending ports.

Recovery still requires authoritative ownership. Unknown creates remain unresolved even if an inventory search is empty. Known resources use exact IDs and current effect labels. Deletion retries preserve original receipts. Customer pins can retain a snapshot until its original create settles. A provider outage can extend billing; cancellation cannot guarantee immediate absence. Local keys are removed only after provider cleanup, and a durable marker ensures filesystem failures retry after restart.

## Verification and remaining work

`tests/runtime-identity.test.ts` checks repeated setup, decryption binding, substituted keys, partial setup, unsafe files, configuration and policy reload. `tests/image-runtime.test.ts` composes actual runtime ports with a controlled HTTP transport, covering startup/admission without provider I/O, disabled customer endpoints, fresh prices, revocation, recovery after credential loss and host-clock skew. These are protocol proofs, not live cloud proofs.

The corrected bounded Hetzner drill passed builder installation, sanitation, observed graceful shutdown, snapshot creation, verifier enrollment/runtime and signed publication/selection. Cancellation then removed all provider resources and local access; independent inventory and cleanup replay passed. The historical signed release remains auditable, but its snapshot is absent and current selection rejects it. See [live evidence](../research/m1-hetzner-durability-drill.json). Temporary image API, worker and HTTPS tunnel were stopped after cleanup. Customer certificate renewal now passes separate [local native checks](guest-renewal.md). Customer runtime wiring now has separate local checks. A customer Hetzner boot, SSH access, application deployment, routing, backups and self-hosted recovery remain open milestones.

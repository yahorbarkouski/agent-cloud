# Candidate C: guest bootstrap as an allocation capability

## Problem

`machine.create` already has durable admission, allocation, provider attempts, owned Primary IP records, and per-machine worker serialization. The missing M1 slice is not another provider effect; it is proving that the allocated server booted into a unique guest, generated its own SSH/TLS identity, accepted only the intended bootstrap capability, and can run Docker/Compose plus the guest proxy before the create operation succeeds. The design must survive crashes before and after provider submission, keep prepared/unknown provider attempts unreplayed, and avoid exposing provider or CA keys to the guest.

## Usage

The caller keeps the same CLI shape:

```sh
acld machine create web --project prj_x --size small --region nbg1 --key create-web-1
acld operation wait op_x
acld machine inspect mch_x
```

`operation wait` returns `succeeded` only after the guest is verified. `machine inspect` then shows:

```json
{"state":{"kind":"allocated","guest":{"kind":"ssh","verifiedAt":"...","imageVersion":"agent-cloud-2026-09-06"}}}
```

Worker create call site:

```ts
const bootstrap = await loadOrCreateGuestBootstrap(tx, { operation, allocation });
await journalEffect({ ...work, command: buildCreateCommand({ offer, labels, ip, bootstrap }) });
```

Enrollment route, intentionally outside bearer auth:

```ts
app.post('/v1/bootstrap/enroll', async (c) =>
  enrollGuest({ db, signer, now, body: guestEnrollmentSchema.parse(await c.req.json()) }),
);
```

Readiness hook after provider create is confirmed:

```ts
const enrollment = await resolveGuestEnrollment(work, resolution.observation.server);
if (enrollment.kind !== 'ready') return await setProgress(db, operation, enrollment.progress);
await completeVerified({ ...work, server, guest: enrollment.guest });
```

## Shape

Data model additions:

```ts
export const guestBootstraps = pgTable('guest_bootstraps', {
  allocationId: text('allocation_id').primaryKey(),
  operationId: text('operation_id').notNull(),
  secretHash: text('secret_hash').notNull(),
  secretVersion: integer('secret_version').notNull().default(1),
  publicEnrollUrl: text('public_enroll_url').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const guestIdentities = pgTable('guest_identities', {
  allocationId: text('allocation_id').primaryKey(),
  operationId: text('operation_id').notNull(),
  providerServerId: text('provider_server_id').notNull(),
  providerIpv4: text('provider_ipv4').notNull(),
  sshHostPublicKey: text('ssh_host_public_key').notNull(),
  sshHostCertificate: text('ssh_host_certificate').notNull(),
  tlsPublicKey: text('tls_public_key').notNull(),
  tlsCertificate: text('tls_certificate').notNull(),
  imageVersion: text('image_version').notNull(),
  enrolledAt: timestamp('enrolled_at', { withTimezone: true }).notNull(),
});
```

Contract additions:

```ts
export const operationProgressSchema = z.discriminatedUnion('kind', [
  // existing states...
  z.object({ kind: z.literal('waiting_guest_boot'), allocationId: allocationIdSchema }),
  z.object({ kind: z.literal('waiting_guest_enrollment'), allocationId: allocationIdSchema }),
  z.object({ kind: z.literal('verifying_guest'), allocationId: allocationIdSchema }),
]);

export const providerCommandSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('create'),
    name: z.string(),
    serverType: z.string(),
    region: z.string(),
    labels: z.record(z.string(), z.string()),
    network: providerNetworkSchema,
    bootstrap: guestBootstrapRenderSchema,
  }),
  // existing commands...
]);
```

Functions and boundaries:

```ts
export async function loadOrCreateGuestBootstrap(tx: Transaction, input: {
  operation: Operation; allocation: Allocation; publicUrl: string; now: Date;
}): Promise<GuestBootstrapPlaintext> {
  // Select FOR UPDATE by allocation. If present and not expired, return only a freshly decrypted
  // secret from encrypted local control-plane storage. If absent, generate 32 random bytes,
  // store only hash + encrypted sealed value, and audit without the secret.
  throw new Error('not implemented');
}

export function renderGuestCloudInit(input: GuestBootstrapPlaintext): string {
  // Write /run/agent-cloud/bootstrap.env mode 0600, install first-boot systemd unit, post
  // enrollment once, then shred the env file and disable the unit.
  throw new Error('not implemented');
}

export async function enrollGuest(input: {
  db: Database; signer: GuestCertificateSigner; body: GuestEnrollment; now: Date;
}): Promise<GuestEnrollmentResponse> {
  // Lock bootstrap row. Verify unexpired secret hash, operation/allocation ids, and provider
  // observation: server id, labels, assigned Primary IP, and source/claimed IPv4 match the
  // recorded provider server. First insert wins. Retries must present the same SSH/TLS keys,
  // imageVersion, allocation, and provider facts; otherwise reject.
  throw new Error('not implemented');
}

export async function verifyGuestReady(input: {
  ssh: OpenSshClient; http: GuestProxyClient; identity: GuestIdentity; server: ProviderServer;
}): Promise<{ kind: 'ready'; guest: { kind: 'ssh'; verifiedAt: string; imageVersion: string } } |
  { kind: 'pending'; progress: OperationProgress } |
  { kind: 'blocked'; progress: OperationProgress }> {
  // Use ssh-keygen/ssh with the platform public host CA, not TypeScript SSH crypto. Check host
  // cert principal = machine id, Docker, docker compose, disk, image manifest, and HTTPS 8443
  // proxy mTLS using the signed guest TLS cert.
  throw new Error('not implemented');
}
```

`complete()` splits into `completeProviderAllocation()` and `completeVerified()`. Hetzner create calls the first after provider confirmation, leaving the operation nonterminal, then loops through enrollment/readiness. Simulated create keeps its current fast path. Destroy/cleanup continue to use provider resources; guest rows are allocation-owned evidence and do not authorize cleanup.

Development verification uses two paths. Local-first runs the API bound to `0.0.0.0` with `PUBLIC_URL=http://<dev-lan-ip>:4319` and a firewall allowing only the disposable guest IP to `/v1/bootstrap/enroll`; tests assert arbitrary `X-Forwarded-*` headers are ignored unless a configured trusted reverse proxy is in front. A `scripts/build-guest-image.ts` boots a disposable VM with build-only cloud-init, installs Ubuntu packages, Docker/Compose, Caddy, OpenSSH, `guestctl`, and writes an image manifest, then sanitizes host keys, machine-id, cloud-init state, logs, caches, and the build secret before snapshot. Shipped first boot receives only the per-allocation bootstrap cloud-init. One bounded Hetzner CPX12 test provisions from that image, waits through real enrollment/readiness, serves a static file through guest Caddy on 8443, then destroys VM and Primary IP by recorded ownership.

Hetzner server creation supports `user_data`, and Hetzner documents server metadata endpoints for instance self-identification in its Cloud API reference. Cloud-init documents provider instance data as cached standardized metadata. Smallstep documents `step-ca` issuing SSH certificates for hosts and users, and OpenSSH server configuration accepts CA-trusted certificate principals. Those are the only assumed external behaviors.

Sources: https://docs.hetzner.cloud/reference/cloud, https://docs.cloud-init.io/en/latest/explanation/instancedata.html, https://smallstep.com/docs/tutorials/ssh-certificate-login/, https://man.openbsd.org/sshd_config

## Synthesis decision

Candidate C is intentionally allocation-centered: bootstrap, guest identity, and readiness all attach to the existing allocation and operation, so retries and cleanup inherit the current lifecycle invariants. It rejects making guest enrollment a provider attempt because no cloud mutation is being submitted and provider unknown-outcome rules should stay scoped to provider resources.

## Tradeoffs accepted

- We accept one encrypted recoverable bootstrap secret in the control plane until expiry in exchange for crash-safe rendering after admission and before provider submission.
- We accept adding unauthenticated bootstrap routing in exchange for a narrow secret-bound endpoint that can work before SSH and TLS identity exist.
- We accept a LAN/public-url development requirement in exchange for testing a real guest without assuming DNS or accepting arbitrary proxy headers.

## Alternatives considered

Provider-managed bootstrap in static Hetzner config lost because it cannot vary per allocation or replay safely after crashes.

Guest polling authenticated only by provider metadata lost because provider metadata proves location, not possession of the admitted bootstrap secret or generated keys.

Marking create succeeded at provider allocation and verifying guest asynchronously lost because the caller’s existing create/wait contract needs a ready machine.

## Open questions and risks

Should bootstrap secret encryption use the existing local credential pattern for M1, or introduce a small KMS-backed envelope now?

What exact image manifest fields are release-blocking: package versions, guestctl version, cloud-init datasource, kernel, Docker plugin version?

## Next implementation step

Add `guest_bootstraps` and `guest_identities` migrations plus contract schemas, then change create admission/worker tests so Hetzner operations wait in `waiting_guest_enrollment` instead of succeeding at provider confirmation.

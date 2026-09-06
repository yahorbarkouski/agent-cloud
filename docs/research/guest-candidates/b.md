# Candidate B: allocation-scoped guest bootstrap

## Usage

Caller behavior stays the same:

```bash
agent-cloud machines create --project prj_... --name web --size cpx12 --region hel1
agent-cloud operations wait op_...
agent-cloud machines get vm_...
```

`operations wait` returns only after provider resources and guest readiness are verified. A Hetzner create moves through `create_primary_ip -> create -> await_guest_enrollment -> verify_guest`; it is not `succeeded` while `guest.kind === "pending"`. The final machine response is:

```ts
{
  state: {
    kind: "allocated",
    allocationId,
    serverId,
    power: "running",
    guest: { kind: "ssh", verifiedAt, imageVersion }
  }
}
```

The image build path is separate from shipped first boot:

```bash
pnpm image:guest:build --enroll-url http://127.0.0.1:4319 --mode image-build
pnpm smoke:guest:local
PROVIDER=hetzner PROVIDER_CURRENCY=USD MAX_PROVIDER_HOURLY=0.03 pnpm smoke:hetzner:guest
```

Image-build boot installs Docker, Compose, `guestctl`, OpenSSH config, and the guest proxy, then sanitizes host keys, machine-id, cloud-init instance data, logs, and bootstrap state. Shipped first boot generates unique SSH/TLS keys, reads allocation bootstrap material from cloud-init, enrolls once, and starts health endpoints.

For one bounded live dev test, bind the control API to a temporary public interface instead of relying on loopback:

```bash
HOST=0.0.0.0 PUBLIC_URL=https://<temporary-tunnel-host> pnpm dev:api
```

The tunnel must terminate TLS and forward only to `/v1/guest/enroll` and `/healthz`, injecting no trusted identity headers. Enrollment trusts the bootstrap secret plus provider observation, not the tunnel source. This avoids assuming a domain while avoiding arbitrary proxy-header trust.

## Shape

Add contracts:

```ts
export const bootstrapIdSchema = z.string().regex(/^boot_[0-9a-f-]{36}$/).brand<"BootstrapId">();

export const guestEnrollmentRequestSchema = z.strictObject({
  allocationId: allocationIdSchema,
  bootstrapId: bootstrapIdSchema,
  bootstrapSecret: z.string().min(32).max(256),
  sshHostPublicKey: z.string().min(1),
  tlsPublicKeyPem: z.string().min(1),
  imageVersion: z.string().min(1).max(64),
});

export const guestEnrollmentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pending") }),
  z.object({
    kind: z.literal("enrolled"),
    sshHostPublicKey: z.string(),
    sshHostCertificate: z.string(),
    tlsPublicKeyPem: z.string(),
    tlsCertificatePem: z.string(),
    imageVersion: z.string(),
    enrolledAt: z.iso.datetime(),
  }),
]);

export const operationProgressSchema = z.discriminatedUnion("kind", [
  /* existing */,
  z.object({ kind: z.literal("awaiting_guest"), allocationId: allocationIdSchema }),
  z.object({ kind: z.literal("verifying_guest"), allocationId: allocationIdSchema }),
]);
```

Add DB:

```ts
guestBootstraps(
  allocationId pk/fk,
  bootstrapId unique not null,
  secretHash not null,
  secretPreview text not null,
  enrollUrl not null,
  expiresAt not null,
  enrollment jsonb not null default {kind:"pending"},
  createdAt not null
)
```

`secretHash = scrypt(secret + bootstrapId + allocationId, serverPepper)`. `secretPreview` is the first 8 nonsecret chars for audit correlation only. Do not store cloud-init user data.

New modules:

```ts
// apps/control/src/guest-bootstrap.ts
export async function ensureBootstrap(tx, input: {
  allocation: Allocation;
  publicUrl: string;
  ttlMinutes: number;
}): Promise<{ id: BootstrapId; secret: string; enrollUrl: string }>;

export function renderGuestCloudInit(input: {
  baseUserData: string;
  allocationId: AllocationId;
  bootstrapId: BootstrapId;
  bootstrapSecret: string;
  enrollUrl: string;
}): string;

export async function enrollGuest(input: {
  db: Database;
  provider: MachineProvider;
  request: GuestEnrollmentRequest;
  now: Date;
  signer: GuestCertificateSigner;
}): Promise<GuestEnrollmentResponse>;

// apps/control/src/guest-readiness.ts
export async function advanceGuestReadiness(input: {
  db: Database;
  operation: Operation;
  machine: Machine;
  allocation: Allocation;
  server: ProviderServer;
  verifier: GuestVerifier;
}): Promise<"pending" | "ready" | "blocked">;

export interface GuestVerifier {
  verify(input: {
    ipv4: string;
    machineId: MachineId;
    allocationId: AllocationId;
    sshHostCertificate: string;
    imageVersion: string;
  }): Promise<{ docker: "ok"; compose: "ok"; proxy: "ok"; disk: "ok" }>;
}

export interface GuestCertificateSigner {
  signHost(input: { principals: [MachineId, AllocationId]; publicKey: string }): Promise<string>;
  signProxyTls(input: { dnsNames: string[]; publicKeyPem: string; ttlMinutes: number }): Promise<string>;
}
```

`advance-operation.ts` changes only in the create branch. Before journaling the `create` effect, call `ensureBootstrap()` in the same transaction that reloads allocation data, render allocation-specific user data, and include it in the provider command:

```ts
{ kind: "create", ..., network, guestBootstrap: { userData } }
```

`packages/hetzner` uses `command.guestBootstrap.userData ?? template.userData`. The attempt journal stores the command, so a crash after bootstrap generation but before provider submit keeps the exact same secret and cloud-init payload with the prepared attempt. A crash before the attempt exists reruns `ensureBootstrap()` and returns the same `bootstrapId` plus a newly returned plaintext secret only if no provider create attempt exists. Once a create attempt exists, plaintext must come from the journaled command, never from the hashed row.

`POST /v1/guest/enroll` is unauthenticated but narrow. It validates body size, hashes the presented secret, loads `guest_bootstraps` by `(allocationId, bootstrapId)`, locks the row and live allocation, rejects expiry, reloads the owned server/IP, and asks the provider to observe the recorded server. It accepts only when provider labels match, server IP matches the request path target expectation, power is running, and enrollment is pending or byte-for-byte the same keys. Same keys return the same certs; different keys for the same allocation block as `provider_resource_mismatch`. Signing uses Smallstep/OpenSSH tooling; the API shells to configured tools or calls a local CA client, never implements SSH crypto. Smallstep documents `step-ca` as an SSH and X.509 CA, and OpenSSH certificates are signed public keys with principals/options verified by clients and servers: https://smallstep.com/docs/step-ca/ and https://man.openbsd.org/ssh-keygen.1

After server confirmation, `advanceGuestReadiness()` sets `awaiting_guest`, then `verifying_guest` after enrollment. Verification uses OpenSSH with `UserKnownHostsFile` containing only the platform host CA, checks the host cert principal equals `machineId,allocationId`, runs `guestctl inspect` for Docker/Compose/disk/image, and calls the guest proxy health endpoint over mTLS. Hetzner and cloud-init both support server `user_data` injection at creation, which is the only first-boot secret delivery mechanism used here: https://docs.hetzner.cloud/reference/cloud and https://docs.cloud-init.io/en/latest/explanation/format/index.html

## Rationale

The non-obvious part is crash handling around the only plaintext bootstrap secret. The design makes allocation the owner of guest bootstrap state and the provider attempt the owner of the submitted cloud-init payload. That gives each invariant one durable home: the database proves expected allocation and enrollment state; the attempt journal proves what was sent to the provider.

This keeps guest readiness outside `effect-journal.ts`, whose job remains provider mutation and observation. Guest readiness is a controller phase, not a provider effect, because no provider mutation is being submitted and readiness must not be inferred from provider `running`. Prepared or unknown provider attempts keep their existing behavior: reconcile them before cleanup or another create. Guest enrollment does not authorize cleanup and does not replay provider calls.

The short-lived bootstrap secret is useful only with matching provider-owned network identity. A leaked cloud-init secret alone cannot enroll arbitrary keys for another allocation because the server, IP, labels, allocation, and pending record must agree before signing. Guests receive only their one-time secret and public CA trust, never provider tokens or CA private keys.

## Tradeoffs accepted

- We accept storing plaintext user data in the provider attempt command after submission in exchange for exact crash recovery. Logs must redact `guestBootstrap`.
- We accept an unauthenticated enrollment endpoint in exchange for first-boot simplicity; admission is enforced by secret hash plus provider observation.
- We accept a temporary public tunnel for one live test in exchange for avoiding premature domain and gateway work.

## Alternatives considered

- Put enrollment into `effect-journal.ts`: rejected because guest readiness is not a provider effect and would blur cleanup rules.
- Store only a hash and never persist submitted user data: rejected because crash recovery after a prepared create could not reconstruct the same secret safely.
- Pre-register guest keys in the image: rejected because original plan requires unique guest-generated keys and sanitized reusable images.

## Open questions and risks

- What is the exact certificate principal format for OpenSSH host certs: machine ID only, or machine plus allocation? I recommend both to make restores distinct.
- How should expired, never-enrolled bootstraps surface to users: retryable `guest_unreachable` or operator-visible blocked state?
- Which CA client is available in dev and CI: local `step-ca`, `step ssh certificate`, or an OpenSSH `ssh-keygen -s` wrapper?

## Next implementation step

Add contract schemas, `guest_bootstraps` migration, and simulator tests for idempotent enrollment before wiring Hetzner user data.

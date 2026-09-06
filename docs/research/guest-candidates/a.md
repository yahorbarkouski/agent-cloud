# Candidate A: allocation-bound guest phase

## Usage

The external caller keeps the same create/wait flow:

```sh
pnpm acld machine create app --project prj_... --region nbg1 --size small --key create-app-1
pnpm acld operation wait op_...
pnpm acld machine inspect vm_...
```

`operation wait` returns success only after the provider server is confirmed, the guest has enrolled its own SSH/TLS keys, and readiness probes pass. During boot the operation reports `progress.kind = "awaiting_guest"` or `"verifying_guest"`; if the server is running but the guest cannot prove itself before deadline, it becomes `blocked: guest_unreachable`. `machine.inspect` shows `allocated.guest.pending` until final success sets `allocated.guest.ssh`.

Controller call sites:

```ts
const bootstrap = await ensureGuestBootstrap(tx, { operation, machine, allocation, publicUrl });
await journalEffect({ ...work, command: createProviderCommand({ ..., bootstrap }) });

const enrollment = await admitGuestEnrollment(db, {
  bootstrapToken,
  allocationId,
  provider: providerObservation,
  keys: guestKeys,
});

const ready = await verifyGuestReadiness({
  host: server.ipv4,
  expected: enrollment,
  checks: ["ssh-host-cert", "docker", "compose", "disk", "image", "proxy"],
});
```

The temporary image-build boot is separate: Packer/cloud-init installs Docker, Compose, `acld-guest`, sshd policy, and the local proxy into a sanitized image with no machine identity, no host keys, and no bootstrap token. Shipped first boot generates guest keys and consumes the per-allocation bootstrap passed in Hetzner `user_data`.

## Type sketch

```ts
export const operationProgressSchema = z.discriminatedUnion("kind", [
  /* existing variants */,
  z.object({ kind: z.literal("awaiting_guest"), allocationId: allocationIdSchema, deadlineAt: z.iso.datetime() }),
  z.object({ kind: z.literal("verifying_guest"), enrollmentId: guestEnrollmentIdSchema }),
]);

export const providerCommandSchema = z.discriminatedUnion("kind", [
  /* existing variants */,
  z.object({ kind: z.literal("create"), /* existing fields */, bootstrap: guestBootstrapRefSchema }),
]);

export type GuestBootstrap = {
  allocationId: AllocationId;
  operationId: OperationId;
  tokenHash: string;
  tokenCiphertext: string;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  publicUrl: string;
  nonce: string;
};

export type GuestEnrollment =
  | { kind: "pending"; allocationId: AllocationId }
  | {
      kind: "enrolled";
      id: GuestEnrollmentId;
      allocationId: AllocationId;
      providerServerId: string;
      primaryIpId: string;
      ipv4: string;
      sshHostPublicKey: string;
      sshHostCertificate: string;
      tlsPublicKey: string;
      tlsCertificate: string;
      imageVersion: string;
      enrolledAt: Date;
    };

export async function ensureGuestBootstrap(tx: Transaction, input: {
  operation: Operation;
  machine: Machine;
  allocation: Allocation;
  publicUrl: string;
}): Promise<{ publicUrl: string; token: string; allocationId: AllocationId; nonce: string }> {
  throw new Error("not implemented");
}

export async function admitGuestEnrollment(db: Database, input: {
  bootstrapToken: string;
  allocationId: AllocationId;
  nonce: string;
  observedRemoteIp: string;
  keys: { sshHost: string; tls: string };
  imageVersion: string;
}): Promise<GuestEnrollment> {
  // Lock allocation row. Verify token hash, expiry, provider resource ownership, expected Primary IP,
  // and observed remote IP. If an enrollment exists, accept only byte-identical keys and image version.
  throw new Error("not implemented");
}

export async function advanceGuestPhase(work: Work, server: ProviderServer): Promise<boolean> {
  // Return true only after enrollment exists and readiness probes pass.
  throw new Error("not implemented");
}

export function renderHetznerUserData(input: {
  staticTemplate: string;
  bootstrap: { publicUrl: string; token: string; allocationId: AllocationId; nonce: string };
}): string {
  // Render one small cloud-init part that writes /run/acld/bootstrap.json, starts acld-guest,
  // then deletes the file after a successful enrollment response.
  throw new Error("not implemented");
}
```

## Module and schema changes

Add `apps/control/src/guest-bootstrap.ts` for token creation, cloud-init rendering, enrollment admission, and idempotent signing calls. Add `apps/control/src/guest-readiness.ts` for SSH/OpenSSH probes and HTTP proxy health checks. Keep Hetzner transport provider-only: it accepts a `bootstrap` object inside the already-journaled create command and renders `user_data`, but it does not know enrollment rules.

Add `guest_bootstraps(allocation_id pk, operation_id unique, token_hash, token_ciphertext, nonce, public_url, issued_at, expires_at, consumed_at)` and `guest_enrollments(id pk, allocation_id unique, provider_server_id, primary_ip_id, ipv4, ssh_host_public_key, ssh_host_certificate, tls_public_key, tls_certificate, image_version, enrolled_at)`. Add a trigger matching provider attempts: bootstrap identity, ciphertext, and token hash are immutable; only `consumed_at` may move from null once. Store only hashes, sealed ciphertext, and certificates, never the plaintext token or full cloud-init body.

`advance-operation.ts` changes only the create tail. Before journaling VM create, call `ensureGuestBootstrap()` in the same transaction that prepares the command. It generates the token once, stores its hash plus ciphertext sealed with `BOOTSTRAP_SEAL_KEY`, and returns the plaintext only to render this allocation's cloud-init. A crash before submit decrypts the same row and re-renders the same VM command; a crash after submit reconciles the immutable prepared command. After provider create confirmation, set `awaiting_guest` instead of `succeeded`; later ticks call `advanceGuestPhase()`. Existing prepared/unknown provider attempts remain unreplayed because the create command already contains the immutable bootstrap reference and reconciliation still owns provider truth.

## Rationale

This shape keeps one operation as the source of truth. The provider journal continues to answer “which paid resources exist?” and the new guest records answer “has the expected OS instance proved its own keys?” Enrollment is accepted only when the bootstrap secret, allocation ID, server labels, recorded Primary IP, and observed remote address all match. Retry accepts the same keys/allocation and rejects rotation, so a flaky first boot cannot swap identity after the CA has signed.

Readiness is deliberately after provider confirmation. Hetzner “running” only means the VM action completed; it says nothing about sshd, Docker, Compose, disk layout, image version, or the guest proxy. The verifier uses ordinary OpenSSH host certificate checks and Docker/Compose commands over SSH. Smallstep remains the CA boundary for later M2 user certificates; M1 only creates the host certificate and stores public CA material on the guest. This follows OpenSSH certificate support documented by OpenSSH and Smallstep’s SSH CA model: https://www.openssh.com/specs.html and https://smallstep.com/docs/step-ca/.

For local-first verification, the simulator gains a fake guest enrollment/readiness path. For one cheap live test, bind the API to a real operator-controlled interface, set `PUBLIC_URL=https://<operator-ip-or-temporary-host>:4319`, and restrict the development listener to the precreated Primary IP before VM create. Do not rely on proxy headers; Hono reads the TLS socket remote address. If the developer is behind NAT, run the API on a self-hosted temporary box or port-forwarded host using an IP literal and a bootstrap-pinned enrollment signing key, then destroy the guest before the CPX12 budget window ends. Hetzner user data support is part of server creation per the official API docs: https://docs.hetzner.cloud/reference/cloud.

Tradeoffs accepted: one extra durable table pair instead of overloading `machines.state`; polling guest readiness inside the existing worker instead of adding a guest workflow engine; IP-literal development TLS with key pinning instead of requiring DNS for the first live test.

Alternatives considered: making enrollment a provider effect lost because the provider journal must stay about external cloud mutations; marking create succeeded at provider-ready and adding a later readiness command lost because callers need `create/wait` to return a usable machine; distributing fleet keys in the image was rejected by the original plan and would clone identities.

Open questions: what seal format should back `BOOTSTRAP_SEAL_KEY` in production, KMS envelope encryption or libsodium sealed boxes? What exact Docker Compose version is part of the sanitized image contract? Should M1 expose guest proxy health publicly or only through SSH during readiness?

Next implementation step: add contract schemas and migrations for `awaiting_guest`, `guest_bootstraps`, and `guest_enrollments`, then wire simulator enrollment tests before touching Hetzner activation.

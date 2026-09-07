# Customer SSH access design

Design selected on 2026-09-07. The shared authority loader is integrated into the main development branch. Session storage is implemented in the isolated customer-ssh checkout and under verification. Admission, issuance, gateway, customer certificates and CLI remain planned below. Existing opaque delegated grants authorize this slice. Browser/device login, persistent commands, deployment and forwarding remain later work. The current probe/runtime SSH path stays restricted.

## Customer usage

```sh
acld ssh <machine-id>
acld ssh <machine-id> -- id -u
```

The CLI creates an ephemeral Ed25519 key and a random32-byte transport secret in an owner-only temporary directory. It sends the public key and SHA-256 ticket hash to the API under one persisted request key. The plaintext ticket stays local until the gateway consumes it. A lost API response replays the same request and returns the saved certificate. Losing the local secret means starting a new session.

```ts
const local = await prepareSshInvocation();
const pending = await client.createAccessSession({
  machineId,
  publicKey: local.publicKey,
  ticketHash: local.ticketHash,
  key: local.requestKey,
});
const access = await client.waitAccessSession(pending.session.id);
await runCustomerSsh({ access, local });
```

Native OpenSSH reads private key/certificate/known-hosts files and invokes a hidden `acld access-proxy --profile <private-file>` as its ProxyCommand. That profile contains the gateway origin and ticket. Stdin/stdout carry SSH bytes only. Use properly quoted fixed executable/profile paths, never shell interpolation of customer commands or secrets. Child diagnostics go to stderr. Cleanup owns each temporary directory even when SSH or the proxy fails.

The customer user is `agent-customer` with passwordless sudo. Interactive sessions may request a PTY; command mode has no PTY. Agent forwarding, port forwarding, tunnels, user RC and password authentication are disabled in this first slice. Remote commands carry ordinary SSH shell semantics; durable detached execution belongs to M3.

## Authority and durable state

The API accepts only an existing machine ID, canonical Ed25519 public key and fixed-size ticket hash. It authorizes `machine:exec` and the machine's project, then binds account, project, grant, machine, allocation, pinned guest identity and gateway configuration. Every authority-changing request field participates in the idempotency fingerprint. Hash uniqueness is global. The shipped CLI generates the secret with a cryptographic RNG; the API cannot measure entropy from a hash.

Add a branded `AccessSessionId` with the repository's UUID convention. Contracts derive schemas and types together. The stored row contains immutable ownership, request fingerprint, public key, ticket hash, deadlines and the following discriminated states:

```ts
type AccessIssuance =
  | { kind: 'pending' }
  | { kind: 'attempted'; attemptedAt: string }
  | {
      kind: 'issued';
      certificate: string;
      issuedAt: string;
      ticketDeadline: string;
      certificateExpiresAt: string;
      target: OwnedSshTarget;
    }
  | {
      kind: 'unavailable';
      reason:
        | 'signing_unknown'
        | 'signing_failed'
        | 'provider_rejected'
        | 'authorization_changed'
        | 'target_changed'
        | 'deadline_exceeded';
    };

type AccessConnection =
  | { kind: 'unclaimed' }
  | { kind: 'claimed'; gatewayInstanceId: string; connectionId: string; claimedAt: string }
  | {
      kind: 'closed';
      closedAt: string;
      reason: AccessCloseReason;
      previous: UnclaimedConnection | ClaimedConnection;
    };

type UnclaimedConnection = { kind: 'unclaimed' };
type ClaimedConnection = {
  kind: 'claimed';
  gatewayInstanceId: string;
  connectionId: string;
  claimedAt: string;
};

type OwnedSshTarget = {
  provider: 'hetzner' | 'simulated';
  serverId: string;
  primaryIpId: string;
  address: string;
  port: 22;
  hostAlias: string;
  sshHostCa: string;
  guestHostPublicKey: string;
  imageManifestDigest: string;
};
```

SQL forbids mutation of ownership, key/hash, deadlines, saved certificate and target, including the exact host CA, guest host key and signed image digest. Finalization verifies those pins against the same issued allocation identity. It permits issuance only along the declared transitions, and one claim followed by one close. Claim requires issued credentials, current authority and unexpired ticket/session. An unclaimed expired/revoked session can close directly. Cross-tenant and cross-project references use composite foreign keys. No row can reopen after claim, even if the gateway never connected. An opened timestamp is optional audit evidence in a separate immutable event, not a prerequisite for denying replay.

One session permits one persisted CA submission, with a ninety-second admission-to-issuance deadline. An attempted result lost to a crash remains uncertain and cannot sign again. The same invocation can recover a saved result; an unknown result requires a new session after normal admission limits. Start with ten fresh sessions per grant per five minutes and twenty per account, plus four unexpired session reservations per grant and twenty per account. Pending/unknown reservations count until the original issuance deadline. Issued-unclaimed reservations count until ticket expiry; claimed reservations count until the hard lease expires or closure. Rate windows count every admitted row regardless of outcome, so lost requests cannot evade limits. These are explicit configurable operator ceilings, not new customer spending policy.

From one admission-time database timestamp, persist `issueDeadline = admittedAt + 90s` and `hardDeadline = min(admittedAt + 1h, ancestryExpiry)`. At publication, persist `ticketDeadline = min(issuedAt + 60s, issueDeadline, ancestryExpiry)` once. Certificate validity is at most five minutes and never after the original hard/ancestry deadline. No replay, queue delay or renewed authority check moves these absolute limits.

`loadAuthority(db, grantId)` returns `{ principal, checkedAt, expiresAt }` where expiry is the earliest validated ancestor. One bounded recursive SQL statement reads the complete ancestry from one MVCC snapshot. It materializes the traversal before reading PostgreSQL time for the expiry decision. `loadPrincipal` remains the useful principal-only wrapper for existing authentication/lifecycle callers. Grant delegation consumes the full horizon directly. Admission, issue, claim and session checks must use this shared walk under their stated locks. A consistent snapshot does not prevent a revocation that commits after that snapshot. Future gateways must subtract RPC latency when anchoring remaining lifetime. Do not duplicate an access-only ancestor query.

## Implemented storage boundary

Draft migration0020 creates `access_sessions` and `access_signing_attempts`. The attempt table has one row per session, with the original attempt timestamp. Its ownership comes from the immutable session foreign key. An AFTER UPDATE trigger inserts that receipt in the same transaction as the first signing transition; receipt insertion requires that exact session state. Updates and deletes are refused. Generic operator audit records are not the signing authority.

Closed sessions retain the preceding unclaimed or claimed state. The unique gateway/instance/connection index reads that retained claim after closure, so closing cannot release the tuple for reuse. Instance and connection IDs are canonical lowercase UUIDv4 values. A different configured gateway has its own namespace. Customer ticket hashes remain globally unique independently of connection IDs.

SQL validates immutable request keys, canonical Ed25519 wire keys, Ed25519 or P-256 host CA wire keys, complete typed identity pins, bounded gateway origins and explicit IPv4/IPv6 CIDRs before admission. The same access profile is enforced in contracts. Origins have no path, trailing slash, credentials, query or fragment; WSS is required except WS on localhost,127.0.0.1 or[::1]. DNS labels are lowercase and bounded; ports are1–65535. CIDR/0 and duplicate sources are refused. These checks establish readable stored configuration, not provider ownership or certificate trust.

Contract and PostgreSQL tests cover malformed raw inserts, source/key boundaries, immutable receipts, rollback, competing signing attempts and outcomes, competing claims, closure, expiry and closed tuple uniqueness. SQL alone does not establish grant ancestry, current machine state, admission rate limits, live provider ownership or cryptographic certificate validity. Those remain the service boundaries described below. This unpublished migration has only run in disposable test databases; applied migrations0000–0019 are unchanged.

## Issue, claim and close

`POST /v1/machines/:machineId/access-sessions` atomically admits the session and queues an `issue_access_session` task through the existing Graphile worker. It returns202 with public pending metadata. `GET /v1/access-sessions/:id` requires current `machine:read`, account/project scope, and either the issuing grant or a validated ancestor of it. A still-authorized ancestor can therefore inspect a session after child revocation, but this grants no new ticket or signing authority. It returns pending, ready, unavailable or consumed metadata, never plaintext ticket. The SDK wait helper stops at the earlier of its caller deadline and persisted issue deadline; it rejects unavailable/consumed states without silently creating another session. Lost POST responses replay the same admission; no CA work runs in the HTTP request. Worker restarts can resume pending provider checks, but an already attempted CA call cannot be repeated.

`apps/control/src/access-sessions.ts` owns admission and issuance. Initial and final transactions acquire machine advisory lock, global admission lock only when using shared ceilings, account row, then machine/allocation/session rows. This matches lifecycle order. The worker alone holds an access-session advisory lock on one pinned PostgreSQL connection across the complete issuance pass to prevent a concurrent worker from marking an in-flight CA call unknown. It takes machine locks only inside its initial/final phases. Admission, claim, revoke and destroy never acquire that session advisory lock, so there is no reverse edge. Under that order, reload the grant chain, require verified allocation-owned guest identity and a supported customer-access image, and reject active cleanup or non-running lifecycle work. Preserve idempotent outcomes before considering fresh admission capacity.

Release SQL locks before provider observation and CA calls. Check exact current server/IP ownership and source-restricted firewall policy before signing. Persist the attempted state before the CA call. The final transaction reacquires the machine lock, rechecks grant ancestry, allocation, bootstrap/identity, machine version, cleanup intent, deadlines and the observed resource IDs. A valid signature does not override lost authority. Only a validated certificate and current target can become issued. Provider observation is never a certificate-signing retry. Before CA submission, retryable provider unavailability may reschedule only within the original issue deadline. A pending job after that deadline persists `deadline_exceeded` without calling the CA. A worker that acquires the session lock and finds `attempted` has recovered a lost execution; without a proven signer lookup receipt it persists `signing_unknown` and never resubmits. Definite signer/provider rejection persists the matching unavailable reason. Every provider/CA call is abort-bounded by both its transport timeout and remaining issue deadline. Finalization after expiry cannot publish credentials.

The gateway process can run on the same operator host during development. It holds no database, provider, bootstrap or CA credentials. It calls a narrow authenticated control RPC for claim, batch authority checks and close. An operator-generated gateway token is stored0600 on that gateway; the control configuration contains only its hash, gateway ID and allowed egress CIDRs. Tokens authenticate a distinct `GatewayPrincipal`, never a customer/owner principal. Rotate/revoke gateway tokens through explicit operator configuration and recheck policy on every RPC. Startup requires TLS to the configured control origin, except explicit loopback development; reject redirects. Gateway configuration cannot load control-owner database or signing material. An upgrade accepts only the fixed WSS path and `Authorization: Bearer <ticket>` header. Tickets never enter URLs or access logs. Browser-origin requests are refused in this CLI-only slice. Bound unauthenticated sockets and header/handshake size before ticket lookup.

Control RPC routes are available only in configured customer mode and require the gateway token independently of ordinary `/v1` authentication. `claim` receives the ticket plus fresh instance/connection IDs. `check` and `close` accept bounded session/connection IDs belonging to that authenticated gateway. They cannot create grants, sign certificates, change machine state or accept network targets. No secret appears in errors or logs. The API owns all SQL and provider authority; the gateway owns live sockets only.

Claim reads immutable scope by hash, then in a single machine-first transaction requires exact account/project membership and active grant ancestry at database time, issued/unclaimed state, unexpired ticket and hard lease, the same live allocation attached to the same running machine/version, no cleanup intent or conflicting operation, and exact live server/IP ledger IDs matching the immutable target and identity pins. It also requires current configured gateway ID/CIDRs to match the signed session. The transaction consumes the ticket before returning any target. A post-claim `check` immediately before TCP/bytes confirms that same claimed connection still has authority. Failure consumes the ticket permanently.

The gateway receives only the short-lived API-observed address on22 and pinned identity metadata from this RPC. Native OpenSSH verifies the exact allocation host principal against the stored CA before authentication or customer commands, which prevents a recycled IP from impersonating the original guest. Do not claim that a last-second provider read removes every address race.

Grant revocation keeps the existing account lock, identifies the revoked subtree and closes its affected unclaimed/claimed sessions in the same transaction. It never acquires machine/session advisory locks while holding the account lock. Delegation also takes the account lock, so concurrently created descendants cannot escape the closed subtree. Destroy admission closes that machine's sessions under its existing machine-first lock before queuing cleanup. A five-second authenticated RPC batch check covers revocation, ancestor expiry and stale connection state. Notifications are unnecessary in this first slice; correctness and the documented bound depend on the scheduled checks only. A database/API/network error refuses new attempts and cannot extend existing authority. Gateways close existing sockets no later than their already scheduled deadline.

Use one monotonic connection deadline equal to the earlier of its original maximum lease and fifteen seconds after the last successful authority check. Anchor the hard lease once from database-time remaining lifetime; later checks cannot extend it. Each check's deadline starts when the RPC begins, not when a delayed response finally arrives. Local wall-clock rollback, hung queries and listener loss cannot renew authority. End both sockets on rejection, close, timeout or cancellation. Process exit closes sockets; claimed tickets remain consumed without a sweeper reopening them.

## Certificates, guest and network

Add a separate customer signer/inspector in `packages/pki`. Its fixed principal is `customerPrincipal({ kind: 'allocation', id })`. Session/grant/machine IDs belong in the signed key ID for audit; the guest does not need per-session principal updates. Only controller-signed claims set certificate fields. Require the exact public key, user CA, allocation principal, maximum validity, gateway `source-address` CIDRs and explicit extension set. Probe/runtime credentials retain their forced commands and zero extensions.

The next immutable image creates `agent-customer` and a separate root-owned principals file for allocation subjects only. It permits that user and PTY in a dedicated sshd Match stanza; its sudo policy is separate from the probe's single-command entry. Image verifiers have no customer principal. Add a new signed manifest format with an explicit versioned `customerSsh` capability that binds the dedicated account, sudo policy, exact principal algorithm, SSH restrictions and expected network profile. Image input verification checks the complete configuration, and the native/provider verifier records proof of the capability before release signing. Allocation pins preserve it and access admission requires it. Old manifests remain valid historical/renewal images but report unsupported customer access. A filename by itself is insufficient. No hot rewrite of published inputs or a running M1 test guest.

The provider firewall and certificate source-address restriction both limit SSH22 to explicitly configured gateway egress CIDRs. Include worker sources separately for platform probes. Existing free tunnels terminate inbound HTTP/WSS but do not determine outbound SSH source addresses. The operator configures and verifies those addresses; no automatic widening to public22. In local native tests, distinct network identities must prove direct bypass rejection. HTTPS8443 keeps its existing mutual-TLS policy until routing work narrows its sources. Cleanup never depends on access configuration or firewall availability.

Root-equivalent access can alter the VM and copy secrets. Closing platform access cannot undo those actions or promise revocation of customer-installed backdoors. The guest continues hosting applications when access infrastructure fails.

## Transport and files

The service boundaries follow these signatures. Types come from the validated contracts and existing connection/config ports.

```ts
admitAccessSession(input: { connection: Connection; principal: Principal; machineId: MachineId;
  request: AccessSessionRequest; key: string }): Promise<AccessSession>;
advanceAccessSession(input: { connection: Connection; sessionId: AccessSessionId;
  provider: GuestObserver; signer: CustomerAccessSigner }): Promise<void>;
claimAccessSession(input: { connection: Connection; ticket: string;
  gatewayInstanceId: string; connectionId: string }): Promise<ClaimedAccess>;
checkAccessAuthority(input: { connection: Connection;
  sessions: readonly AccessSessionId[] }): Promise<AccessAuthorityBatch>;
```

Use a pinned `ws` dependency and native Node/OpenSSH. Disable compression. Set a32KiB message limit and1MiB per-direction queued-byte limit, plus explicit connect and pre-auth timeouts. Bridge with Node streams and verified backpressure. Test whether the library's stream close behavior preserves SSH's expected EOF/disconnect behavior; do not claim generic TCP half-close without evidence. Destroy the whole connection on a failed bridge, limit concurrent handshakes and store only metadata, close reasons and byte counts.

- `packages/contracts/src/access.ts`: schemas, branded IDs and public outcomes.
- `packages/db` plus next immutable migration0020: sessions, immutable signing receipts, constraints and indexes.
- `apps/control/src/access-sessions.ts`: admission, single-attempt issuance and returned metadata; customer worker registration uses the existing Graphile queue.
- `apps/control/src/access-authority.ts`: SQL claim/current-authority/closure using the existing grant loader; narrow gateway RPC routes stay in control.
- `apps/access-gateway/src/index.ts`: bounded WSS upgrade and live byte connections.
- `packages/pki/src/customer-ssh.ts`: customer certificate policy and validation.
- `apps/cli/src/ssh.ts`: invocation files, native SSH and hidden ticket-file proxy.
- `packages/guestctl`, `images`, runtime config and Hetzner firewall adapter: distinct customer user, access-capable inputs and configured source addresses.

The gateway imports contracts and its RPC client only, and must not depend on database/control runtime packages or load private factories as a side effect. Future browser login supplies the existing principal before this API, so this slice needs no OAuth tables or browser UI.

## Synthesis and verification

All three candidates were read fully. Both parent and independent gpt-5.6-sol judge chose A. A scored21/25, C18 and B15. A supplied an executable ticket-file ProxyCommand, stable allocation principal and separate customer user. C supplied explicit monotonic connection states, post-claim checks and transactional revoke/destroy closure. Review exposed that a database-reading gateway could inherit excessive rights, so the final shape uses a narrow control RPC and keeps one authority implementation. The final design uses a client-generated ticket hash, reviewed separately, to keep replay useful without a new sealing key. It also reduces CA submissions to one per session and fixes the timing/lock details.

Rejected B/C's stdin ticket channel because stdin already carries SSH bytes. Rejected their per-session principal files because neither supplied a working delivery path. Rejected sealed ticket storage, direct public SSH, provider/signer authority in the gateway, automatic uncertain CA retries and early forwarding. Candidate artifacts and rubric are `.local/m2-access-design`; the synthesis record preserves these decisions in the repository.

Before implementation completes, exercise actual CLI/SDK/API, PostgreSQL constraints, Smallstep, native OpenSSH and WSS in disposable local fixtures. Cover lost API/CA/upgrade responses, exact idempotency conflict, restart after claim, parent revocation, worst-phase polling, stalled database reads, clock rollback, expiry during issue/open, destruction races, wrong target/host CA/source address, customer/probe privilege separation, malformed frames, backpressure, EOF and local secret disposal. Retain failures and independent review. A later bounded Hetzner check needs a new verified access-capable image; the current M1 image is not sufficient.

First implementation step is the contract and SQL session model plus authority/race tests. Broader forwarding, device login and application deployment retain their own open milestones.

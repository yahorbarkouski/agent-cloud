# Customer SSH access design

The CLI, API, durable certificate issuer, gateway and native SSH/SFTP are connected. Existing opaque delegated grants authorize access. The current verification result is in `../CONTEXT.md`; this document describes the implemented boundaries. Browser/device login, durable commands and general application deployment remain separate capabilities. The probe/runtime SSH account remains restricted.

## Customer usage

```sh
acld ssh <machine-id>
acld ssh <machine-id> -- id -u
acld file put <machine-id> ./application.txt /var/lib/agent-customer/application.txt
acld file get <machine-id> /var/lib/agent-customer/application.txt ./downloaded.txt
acld access inspect <session-id>
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

The branded `AccessSessionId` follows the repository's UUID convention. Contracts derive schemas and types together. The stored row contains immutable ownership, request fingerprint, public key, ticket hash, deadlines and the following discriminated states:

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

One session permits one persisted CA submission, with a ninety-second admission-to-issuance deadline. An attempted result lost to a crash remains uncertain and cannot sign again. The same invocation can recover a saved result; an unknown result requires a new session after normal admission limits. Start with ten fresh sessions per grant per five minutes and twenty per account, plus four unexpired session reservations per grant and twenty per account. Pending/unknown reservations count until the original issuance deadline. Issued-unclaimed reservations count until ticket expiry; claimed reservations count until the hard lease expires or closure. Rate windows count every admitted row regardless of outcome, so lost requests cannot evade limits. These are fixed admission ceilings, separate from customer spending policy.

From one admission-time database timestamp, persist `issueDeadline = admittedAt + 90s` and `hardDeadline = min(admittedAt + 1h, ancestryExpiry)`. At publication, persist `ticketDeadline = min(issuedAt + 60s, issueDeadline, ancestryExpiry)` once. Certificate validity is at most five minutes and never after the original hard/ancestry deadline. No replay, queue delay or renewed authority check moves these absolute limits.

`loadAuthority(db, grantId)` returns `{ principal, checkedAt, expiresAt }` where expiry is the earliest validated ancestor. One bounded recursive SQL statement reads the complete ancestry from one MVCC snapshot. It materializes the traversal before reading PostgreSQL time for the expiry decision. `loadPrincipal` remains the useful principal-only wrapper for existing authentication/lifecycle callers. Grant delegation consumes the full horizon directly. Admission, issue, claim and session checks must use this shared walk under their stated locks. A consistent snapshot does not prevent a revocation that commits after that snapshot. Gateways subtract RPC latency when anchoring remaining lifetime. Do not duplicate an access-only ancestor query.

## Implemented storage boundary

Migration0020 creates `access_sessions` and `access_signing_attempts`. The attempt table has one row per session, with the original attempt timestamp. Its ownership comes from the immutable session foreign key. An AFTER UPDATE trigger inserts that receipt in the same transaction as the first signing transition; receipt insertion requires that exact session state. Updates and deletes are refused. Generic operator audit records are not the signing authority.

Closed sessions retain the preceding unclaimed or claimed state. The unique gateway/instance/connection index reads that retained claim after closure, so closing cannot release the tuple for reuse. Instance and connection IDs are canonical lowercase UUIDv4 values. A different configured gateway has its own namespace. Customer ticket hashes remain globally unique independently of connection IDs.

SQL validates immutable request keys, canonical Ed25519 wire keys, Ed25519 or P-256 host CA wire keys, complete typed identity pins, bounded gateway origins and explicit IPv4/IPv6 CIDRs before admission. The same access profile is enforced in contracts. Origins have no path, trailing slash, credentials, query or fragment; WSS is required except WS on localhost,127.0.0.1 or[::1]. DNS labels are lowercase and bounded; ports are1–65535. CIDR/0 and duplicate sources are refused. These checks establish readable stored configuration, not provider ownership or certificate trust.

Contract and PostgreSQL tests cover malformed raw inserts, source/key boundaries, immutable receipts, rollback, competing signing attempts and outcomes, competing claims, closure, expiry and closed tuple uniqueness. SQL alone does not establish grant ancestry, current machine state, admission rate limits, live provider ownership or cryptographic certificate validity. Those remain the service boundaries described below. Migration0020 passed disposable database tests, is applied to the main local database and is now immutable. All21 migration hashes match; the restarted simulated CLI lifecycle passed cleanup.

## Issue, claim and close

`POST /v1/machines/:machineId/access-sessions` atomically admits the session and queues an `issue_access_session` task through the existing Graphile worker. It returns202 with public pending metadata. `GET /v1/access-sessions/:id` requires current account/project scope. The issuing grant needs `machine:exec`; a validated ancestor needs `machine:read`. A still-authorized ancestor can therefore inspect a session after child revocation, but this grants no new ticket or signing authority. It returns pending, ready, unavailable or consumed metadata, never plaintext ticket. The SDK wait helper stops at the earlier of its caller deadline and persisted issue deadline; it rejects unavailable/consumed states without silently creating another session. Lost POST responses replay the same admission; no CA work runs in the HTTP request. Worker restarts can resume pending provider checks, but an already attempted CA call cannot be repeated.

`apps/control/src/access-sessions.ts` owns admission and issuance. Initial and final transactions acquire the machine advisory lock, then the account row lock before reading machine/allocation/session state. This matches lifecycle order. The worker alone holds an access-session advisory lock on one pinned PostgreSQL connection across the complete issuance pass to prevent a concurrent worker from marking an in-flight CA call unknown. It takes machine locks only inside its initial/final phases. Admission, claim, revoke and destroy never acquire that session advisory lock, so there is no reverse edge. Under that order, reload the grant chain, require verified allocation-owned guest identity and a supported customer-access image, and reject active cleanup or non-running lifecycle work. Preserve idempotent outcomes before considering fresh admission capacity.

Release SQL locks before provider observation and CA calls. Check exact current server/IP ownership and source-restricted firewall policy before signing. Persist the attempted state before the CA call. The final transaction reacquires the machine lock, rechecks grant ancestry, allocation, bootstrap/identity, machine version, cleanup intent, deadlines and the observed resource IDs. A valid signature does not override lost authority. Only a validated certificate and current target can become issued. Provider observation is never a certificate-signing retry. Before CA submission, retryable provider unavailability may reschedule only within the original issue deadline. A pending job after that deadline persists `deadline_exceeded` without calling the CA. A worker that acquires the session lock and finds `attempted` has recovered a lost execution; without a proven signer lookup receipt it persists `signing_unknown` and never resubmits. Definite signer/provider rejection persists the matching unavailable reason. Provider and CA transports have fixed timeouts. The persisted issue deadline is checked before signing and during finalization; an expired result cannot publish credentials.

The gateway process can run on the same operator host during development. It holds no database, provider, bootstrap or CA credentials. It calls a narrow authenticated control RPC for claim, batch authority checks and close. An operator-generated gateway token is stored0600 on that gateway; the control configuration contains only its hash, gateway ID and allowed egress CIDRs. Tokens authenticate a distinct `GatewayPrincipal`, never a customer/owner principal. Rotate/revoke gateway tokens through explicit operator configuration and recheck policy on every RPC. Startup requires TLS to the configured control origin, except explicit loopback development; reject redirects. Gateway configuration cannot load control-owner database or signing material. An upgrade accepts only the fixed WSS path and `Authorization: Bearer <ticket>` header. Tickets never enter URLs or access logs. Browser-origin requests are refused in this CLI-only slice. Bound unauthenticated sockets and header/handshake size before ticket lookup.

Control RPC routes are available only in configured customer mode and require the gateway token independently of ordinary `/v1` authentication. `claim` receives the ticket plus fresh instance/connection IDs. `check` and `close` accept bounded session/connection IDs belonging to that authenticated gateway. They cannot create grants, sign certificates, change machine state or accept network targets. No secret appears in errors or logs. The API owns all SQL and provider authority; the gateway owns live sockets only.

Claim reads immutable scope by hash, then in a single machine-first transaction requires exact account/project membership and active grant ancestry at database time, issued/unclaimed state, unexpired ticket and hard lease, the same live allocation attached to the same running machine/version, no cleanup intent or conflicting operation, and exact live server/IP ledger IDs matching the immutable target and identity pins. It also requires current configured gateway ID/CIDRs to match the signed session. The transaction consumes the ticket before returning any target. A post-claim `check` immediately before TCP/bytes confirms that same claimed connection still has authority. Failure consumes the ticket permanently.

The gateway receives only the short-lived API-observed address on22 and pinned identity metadata from this RPC. Native OpenSSH verifies the exact allocation host principal against the stored CA before authentication or customer commands, which prevents a recycled IP from impersonating the original guest. Do not claim that a last-second provider read removes every address race.

Grant revocation keeps the existing account lock, identifies the revoked subtree and closes its affected unclaimed/claimed sessions in the same transaction. It never acquires machine/session advisory locks while holding the account lock. Delegation also takes the account lock, so concurrently created descendants cannot escape the closed subtree. Destroy admission closes that machine's sessions under its existing machine-first lock before queuing cleanup. A five-second authenticated RPC batch check covers revocation, ancestor expiry and stale connection state. Notifications are unnecessary in this first slice; correctness and the documented bound depend on the scheduled checks only. A database/API/network error refuses new attempts and cannot extend existing authority. Gateways close existing sockets no later than their already scheduled deadline.

Use one monotonic connection deadline equal to the earlier of its original maximum lease and fifteen seconds after the last successful authority check. Anchor the hard lease once from database-time remaining lifetime; later checks cannot extend it. Each check's deadline starts when the RPC begins, not when a delayed response finally arrives. Local wall-clock rollback, hung queries and listener loss cannot renew authority. End both sockets on rejection, close, timeout or cancellation. Process exit closes sockets; claimed tickets remain consumed without a sweeper reopening them.

## Certificates, guest and network

`createCustomerSshSigner` in `packages/pki` issues the fixed principal `customer-<allocationId>`. The signed key ID includes session, grant and machine IDs. It derives seven signed fields from a validated attempted/unclaimed session and current database authority. The CA template compares the requested Ed25519 wire key with the signed key and renders only the signed identity, sources and absolute times, plus `permit-pty`. Probe/runtime credentials retain their forced commands and zero extensions.

The total certificate lifetime is at most five minutes. The start is the database observation rounded down to a second, minus60seconds. The end is the earliest of observation+240seconds, original hard deadline and ancestry expiry, also rounded down. No positive whole-second lifetime means refusal. Response inspection requires the exact key, user CA fingerprint, audit ID, principal, sources, extensions and both times. This is policy inspection of an authenticated CA response. Native OpenSSH verifies the certificate signature; the controller does not independently verify it before returning the signer result.

The signer generates one OTT in bounded stdout, keeps it in memory and makes one TLS-authenticated POST. It never follows redirects or retries. `failed` means a known failure before submission; `rejected` means a definite CA rejection; `unknown` means submission may have occurred without a usable result. Every outcome still consumes the already-recorded attempt. No result permits another signing call for that receipt. The caller supplies an abort deadline derived from the remaining original issuance deadline; CA and process operations also have20-second caps. A successful signer result does not replace the final locked authority/allocation checks.

The template validates exact field count, purpose, canonical ID structure, key binding, source count/uniqueness and restricted lexical CIDR shape. Full IP/CIDR validity belongs to the validated session/claim boundary. The template is not a second complete CIDR parser. Its trusted provisioner can already authorize certificates. Native fixtures exercise missing/altered/unsigned claims, key substitution, request option injection, near-expiry bounds, SSH authentication and protocol failure behavior. The OpenSSH fixture permits private NAT ranges and disables source penalties for repeated negative authentication tests. Those fixture settings are not production image policy.

The next immutable image creates `agent-customer` and a separate root-owned principals file for allocation subjects only. It permits that user and PTY in a dedicated sshd Match stanza; its sudo policy is separate from the probe's single-command entry. Image verifiers have no customer principal. Add a new signed manifest format with an explicit versioned `customerSsh` capability that binds the dedicated account, sudo policy, exact principal algorithm, SSH restrictions and expected network profile. Image input verification checks the complete configuration, and the native/provider verifier records proof of the capability before release signing. Allocation pins preserve it and access admission requires it. Old manifests remain valid historical/renewal images but report unsupported customer access. A filename by itself is insufficient. No hot rewrite of published inputs or a running M1 test guest.

The provider firewall and certificate source-address restriction both limit SSH22 to explicitly configured gateway egress CIDRs. Include worker sources separately for platform probes. Existing free tunnels terminate inbound HTTP/WSS but do not determine outbound SSH source addresses. The operator configures and verifies those addresses; no automatic widening to public22. In local native tests, distinct network identities must prove direct bypass rejection. HTTPS8443 keeps its existing mutual-TLS policy until routing work narrows its sources. Cleanup never depends on access configuration or firewall availability.

Root-equivalent access can alter the VM and copy secrets. Closing platform access cannot undo those actions or promise revocation of customer-installed backdoors. The guest continues hosting applications when access infrastructure fails.

## Transport and files

The gateway uses native Node streams and pinned `ws`, with compression disabled. It accepts binary frames up to64KiB and uses64KiB stream high-water marks for backpressure. Admission defaults to100 active/pending connections and256MiB total bytes per session. Operators can lower these limits. Configuration caps them at1000 connections and1GiB. Header size is8KiB, the initial socket timeout is8s, control RPC timeout4s and TCP connect timeout4s. Invalid upgrades close any already opened target.

The CLI uses explicit OpenSSH options and an option boundary before the hostname, so a remote command beginning with `-F` or `-o` cannot alter local SSH configuration. It never inherits the user's SSH agent, configuration, known hosts, local commands or forwarding. SFTP quotes single-file paths and rejects NUL/newline characters. Remote commands retain ordinary SSH shell semantics. SSH/SFTP stream output is an exception to the CLI's usual JSON stdout; access session metadata goes to stderr.

- `packages/contracts/src/access.ts`: schemas, IDs and public outcomes.
- `packages/db`, migration0020: immutable sessions and signing receipts.
- `apps/control/src/access-sessions.ts`: admission, single-attempt issuance, claims and current authority.
- `apps/control/src/access-closure.ts`: transactional grant/machine closure.
- `apps/access-gateway/src/server.ts`: authenticated upgrade and bounded live connections.
- `packages/pki/src/customer-ssh.ts`: certificate policy and validation.
- `apps/cli/src/ssh.ts`: invocation files, native SSH/SFTP and hidden ticket-file proxy.
- `packages/guestctl/src/customer-ssh.ts`: signed installed policy and effective SSH/sudo checks.

A new signed image carries optional `customerSsh:1`, the separate `agent-customer` account, allocation principal and passwordless sudo. Its home is `/var/lib/agent-customer`. Old images remain valid without enabling this capability. Readiness validates installed bytes against signed inputs and checks actual `sshd -T` output and sudo behavior. Ubuntu emits repeated `allowusers` lines and trailing whitespace in subsystem output; parse both without weakening expected values. SFTP uses the built-in `internal-sftp` subsystem.

## Operator configuration

Set `ACLD_ACCESS_CONFIG` on the customer API and worker to an owner-only JSON file:

```json
{
  "gateway": {
    "id": "primary",
    "origin": "wss://access.example.com",
    "egressCidrs": ["192.0.2.10/32"]
  },
  "tokenHash": "<SHA-256 hex digest of the complete gateway token>"
}
```

Use actual gateway egress addresses. The example address is reserved for documentation. SSH firewall sources must match this configured profile; the existing probe worker must reach guests from these allowed addresses too. The customer runtime's existing PKI configuration supplies the customer certificate signer. The image factory and an unconfigured API expose no customer SSH routes.

The separate gateway reads an owner-only file named by `ACLD_GATEWAY_CONFIG`:

```json
{
  "controlUrl": "https://api.example.com",
  "token": "<aclg_ followed by 32 cryptographically random base64url bytes>",
  "host": "127.0.0.1",
  "port": 4322,
  "maximumConnections": 100,
  "maximumSessionBytes": 268435456
}
```

Run `pnpm gateway` behind an HTTPS reverse proxy that supports WebSocket upgrades. Keep ticket authorization headers out of access logs. The gateway holds only this token, not database, provider or CA credentials. Loopback HTTP/WS is permitted for local fixtures; deployed origins require HTTPS/WSS. Changing the gateway token requires updating its hash and restarting the configured processes. Old gateway authority then expires within the15s check bound.

## Verification

`pnpm smoke:access` runs the actual CLI, HTTP API, PostgreSQL/Graphile worker, gateway, Smallstep and native SSH/SFTP against one owned local Ubuntu VM. It verifies sudo, a file round trip with spaces, descendant revocation, rejection of new revoked access, API-outage closure and retained guest data. It removes the fixture VM and database on success; a failed VM remains in `.local/guest-image-machine.json` for exact inspection and cleanup. No provider resources are created.

Focused service tests cover authorization, ticket replay, idempotency, immutable signing attempts, lost CA results, revocation during signing, target changes and admission limits. The native certificate smoke covers key, source, principal and signature rejection. A bounded independent review caught local OpenSSH option injection and exec-only session inspection mismatch; both have regression checks. Customer access is not yet verified through Hetzner. Public deployment, durable commands and browser login remain unfinished.

# HTTPS routing

Customers publish a loopback port through `acld route publish`. The control plane owns the hostname assignment, a shared public Caddy gateway terminates browser TLS, and the guest's private Caddy listener forwards to the application. PostgreSQL and application listeners do not need public ports.

## Traffic and identity

```text
Browser
  HTTPS, public application hostname
    ↓
Public gateway: authoritative hostname + applied version
  mTLS, allocation TLS identity, port 8443
    ↓
Guest Caddy: exact HTTP hostname + gateway-selected version
  HTTP, 127.0.0.1:<application port>
    ↓
Application / Docker Compose
```

Use a separate application domain from the cloud's trusted account/login domain. The gateway accepts only names in its authenticated snapshot and requires matching browser SNI and Host. Its upstream SNI is the allocation identity, while the upstream HTTP Host is the application name. Consequently the guest explicitly disables Caddy's automatic SNI/Host equality check. Exact hostname/version matching remains required, and the gateway overwrites visitor-supplied `X-Agent-Cloud-Route-Version` headers. The guest removes that internal header before forwarding to the application.

The dedicated gateway CA provisioner issues only one-hour clientAuth certificates under `.gateway.agent-cloud.internal`. Renewal uses the existing gateway key and certificate. The gateway has no CA issuer password at runtime. Allocation certificates remain serverAuth-only, with direct CA renewal disabled; guests renew through the existing control authorization path. Provider credentials remain outside guests.

Only the gateway's private service token can read `/hosting/v1/snapshot` or acknowledge `/hosting/v1/ack`. Customer credentials cannot use those endpoints, and gateway credentials cannot use customer endpoints. Image-factory mode exposes neither customer routing nor gateway configuration.

## Commands and ownership

An agent needs `route:publish` for the target project and `machine:read` for inspection. Generated names contain the full machine UUID. Each mutation requires a UUID command key and compare-and-set version. Reusing a key with different input fails. Replaying a command superseded by a later version returns an explicit version conflict identifying both versions; it never claims that the newer command was the original result.

Custom domains require an account-bound, random TXT challenge at `_agent-cloud-challenge.<hostname>`. All resolved A/AAAA addresses must point to configured gateway addresses. Challenges expire after 30 minutes; verification is checked again during publication. An unverified name does not reserve global ownership. Removed names remain reserved to their original account to prevent dangling-domain takeover. Cross-account reassignment requires an explicit operator resolution; it is not an automatic consequence of a changed TXT record.

Accounts can reserve 100 names, submit 100 route commands per hour and request 20 DNS challenges per hour. Each desired version has at most five persisted guest-apply attempts. Reconciliation cannot reset that bound. A blocked version requires diagnosis and an explicit new command using the current version. Route/domain admission is audited without storing credentials or application content.

## Updates and recovery

The API durably records intent before the worker contacts the guest. The worker verifies current provider ownership and guest identity, then uses a short-lived SSH certificate constrained to the hosting helper. Machine locks and the guest's shared enrollment/renewal/hosting lock serialize mutations.

A new guest configuration retains the versions that the gateway may still be serving. The gateway selects the exact acknowledged version through its overwritten header. If Caddy reloads a candidate but the reply is lost, the preceding version still points to its preceding port. The guest records prepared bindings before reload, then syncs the live configuration and receipt before acknowledging success. Control switches its gateway target only after that acknowledgement.

Old bindings are pruned only below the gateway's recorded acknowledgement. Guest history is bounded at 100 names and 1,000 retained bindings. An unavailable gateway can therefore cause backpressure instead of unbounded local state. A single gateway controller owns its state directory; multiple independently polling gateways with the same token are not supported by this version's acknowledgement protocol.

The gateway persists its last accepted configuration and public certificate storage. Control API outages do not remove running routes. A route acknowledgement means the proxy configuration was applied; it is not an application health check. Application readiness and Compose release status remain separate diagnostics. A public route removal is acknowledged separately from best-effort bounded guest cleanup; a destroyed allocation no longer appears in gateway snapshots.

## Operator configuration

Run `pnpm setup:pki` and restart the CA to load the dedicated gateway provisioner. Preserve the existing `.local/pki` keys. The development setup prints only gateway metadata; its gateway provisioner password remains in the private operator directory.

Set `ACLD_HOSTING_CONFIG` on both the API and worker to a mode-0600 JSON file:

```json
{
  "version": 1,
  "applicationDomain": "apps.example.net",
  "gatewayTokenFile": "/srv/agent-cloud/hosting-token",
  "gatewayAddresses": ["203.0.113.10"],
  "gatewayOrigin": "https://edge.example.net"
}
```

Create a random service token with the prefix `acld_hosting_` followed by 32 random bytes encoded as base64url. Store the same token in the operator file and gateway's private token file. Point generated wildcard DNS and custom domain address records at the gateway. Allow public 80/443 on the gateway and private 8443 from the gateway to guests. Keep SSH admission on the existing access gateway; hosting does not authorize public guest SSH or database ingress.

A private desired gateway configuration has this shape. Paths are absolute. Choose a short state directory because Caddy uses a private Unix admin socket.

```json
{
  "apiUrl": "https://api.example.com",
  "tokenFile": "/srv/edge/token",
  "clientIdentity": {
    "name": "edge-1.gateway.agent-cloud.internal",
    "receiptFile": "/srv/edge/identity/receipt.json",
    "step": "/usr/local/bin/step",
    "caUrl": "https://ca.example.com"
  },
  "gateway": {
    "caddy": "/usr/local/bin/caddy",
    "stateDirectory": "/srv/edge/state",
    "guestCaFile": "/srv/edge/root.crt",
    "clientCertificateFile": "/srv/edge/identity/client.crt",
    "clientKeyFile": "/srv/edge/identity/client.key",
    "publicTls": { "kind": "acme", "email": "operator@example.com" },
    "listenAddress": "0.0.0.0",
    "httpPort": 80,
    "httpsPort": 443
  }
}
```

Use `publicTls: { "kind": "internal" }` only for a fixture or an environment whose clients trust that local CA. Normal public hosting uses the configured ACME issuer. Operator setup generates and syncs the client key before attempting issuance, then publishes a validated receipt and Caddy PEM:

```sh
pnpm setup:hosting-gateway /private/desired-gateway.json \
  --provisioner-password-file /private/gateway-provisioner-password
ACLD_PUBLIC_GATEWAY_CONFIG=/srv/edge/state/controller.json pnpm public-gateway
```

Run the gateway under a service supervisor with persistent state and the same OS user. The runtime configuration contains no issuer password. Renewal starts with 20 minutes remaining and reloads retained routes even when the control API is unavailable. The certificate receipt is authoritative; an interrupted PEM publication is repaired from it without another issuance.

An uncertain initial issuance preserves its key and attempt record. Inspect those files, then use `--new-attempt <fresh UUID>` for an explicit new attempt with that key. The same option recovers an expired certificate after a long outage using the operator's issuer credential. Default setup does not silently reissue. Never remove the original private key to work around an uncertain or expired certificate.

## Verification

`pnpm smoke:gateway-pki` exercises the real local CA's issuance, exact identity validation and password-free mTLS renewal. Focused tests cover DNS ownership, foreign credentials, concurrent admission, replay, failed/uncertain reload, bounded attempts and authoritative header replacement. Pinned Caddy validation and a separate mTLS echo fixture confirmed duplicate spoofed headers are overwritten.

`pnpm smoke:hosting` is the connected native scenario: delegated CLI, API/worker, separate public gateway, guest mTLS proxy and a frontend/backend/PostgreSQL Compose application. See the current handoff for actual run results. Do not infer public ACME, custom public DNS or Hetzner proof from local CA/native VM checks.

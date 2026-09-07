# M2 customer access grounding

Grounded on 2026-09-07 from `.local/m2-grounding-auth.md`, `.local/m2-grounding-ssh.md`, and targeted source reads. This document describes implemented behavior first. Archived M2 recommendations are separated at the end and are not current product behavior.

## Overview

Customer access today is an account/grant system exposed through JSON HTTP and the `acld` CLI. A caller presents one opaque `acld_...` bearer token. The control API hashes that token, finds a grant row, walks its parent chain, and builds a `Principal` with account ID, grant ID and policy. Every `/v1/*` route uses that principal for route-local authorization. Delegation and revocation are implemented for API credentials.

Customer SSH is not implemented yet. The repo has reusable PKI, native SSH isolation, provider ownership observation, and guest-side SSH trust for platform probes. Those pieces currently serve enrollment, readiness and renewal. They do not create customer access sessions, user certificates, transport tickets, browser/device login, or a revocation-aware SSH gateway.

## Current access model

The main identity object is `Principal`: `{ accountId, grantId, policy }` in `packages/contracts/src/auth.ts:41`. A grant policy names capabilities, project scope, allowed sizes/regions, account currency, maximum machines and maximum hourly spend (`packages/contracts/src/auth.ts:27`). `machine:exec` already exists as a capability enum value (`packages/contracts/src/auth.ts:7`), but no route consumes it today.

The database stores accounts, projects, grants, machines, allocations, operations and operation cleanups in `packages/db/src/schema.ts`. Grants store only `tokenHash`, policy JSON, expiry, optional `revokedAt`, and a parent pointer (`packages/db/src/schema.ts:173`). Operations reference the issuing grant (`packages/db/src/schema.ts:255`), so lifecycle mutations can retain who authorized an operation. There is no `access_sessions` table or equivalent session registry in the current schema.

Development bootstrap creates the first admin credential. It writes `.local/admin.credentials.json` with a generated root token, inserts the default account/project/root grant, and preserves an existing credential only if its hash still matches SQL (`apps/control/src/bootstrap.ts:21`). That file is a development entrypoint, not browser sign-in.

CLI login is token validation plus local storage. `acld login --server ... --token-stdin` reads a token from stdin, validates the server URL and credential shape, calls `whoami`, then writes one JSON credential file with owner-only permissions (`apps/cli/src/index.ts:38`). The default path is `~/.config/agent-cloud/credentials.json`, or `ACLD_CREDENTIALS` when set (`apps/cli/src/index.ts:26`). There is no multi-profile context, OAuth device flow, refresh token, or OS keyring integration.

The SDK sends the bearer token on every request. `CloudClient.request()` sets `Authorization: Bearer ${token}`, JSON headers, optional idempotency key, rejects redirects, applies a 15 second timeout, parses server errors through the contract schema, and validates success bodies through endpoint-specific schemas (`packages/sdk/src/index.ts:40`).

The API applies authentication globally to `/v1/*`. `createApp()` leaves guest/image enrollment routes outside that middleware, optionally disables all customer API routes in image-factory mode, then calls `authenticate()` and stores the `Principal` in request context (`apps/control/src/app.ts:104`, `apps/control/src/app.ts:125`). Current `/v1` routes cover `whoami`, catalog, projects, machines, operations, grants and usage (`apps/control/src/app.ts:131`).

`authenticate()` accepts only `Bearer acld_[A-Za-z0-9_-]{43}`, hashes the token, looks up `grants.tokenHash`, and calls `loadPrincipal()` (`apps/control/src/auth.ts:47`). `loadPrincipal()` walks the grant's ancestors up to 32 rows and rejects missing parents, account mismatch, cycles, revoked grants, or expired grants (`apps/control/src/auth.ts:19`). This means parent revocation immediately invalidates descendants for future API requests.

Authorization stays close to each route. `authorize()` checks the required capability and hides out-of-scope selected projects as `not_found` (`apps/control/src/auth.ts:62`). Project listing also filters selected project grants directly in SQL (`apps/control/src/app.ts:133`). Machine and operation reads first constrain by account ID in SQL, then authorize against the resource's project (`apps/control/src/app.ts:206`, `apps/control/src/app.ts:230`). Lifecycle admission reloads the current grant inside its transaction before mutating machine state, so a stale caller context is not enough to admit a mutation.

Grant creation is parent-constrained delegation. `POST /v1/grants` locks the account and calls `issueGrant()` (`apps/control/src/app.ts:242`). `issueGrant()` reloads the actor grant, requires `grant:manage`, ensures the child policy is a subset of the parent policy, requires the child expiry to be no later than the parent, stores only the child token hash, and returns the plaintext token once (`apps/control/src/auth.ts:102`). `DELETE /v1/grants/:grantId` locks the account, reloads the actor, verifies the target sits in the actor's delegation subtree, sets `revokedAt`, and audits `grant.revoked` (`apps/control/src/auth.ts:135`).

```mermaid
flowchart TD
  CLI[acld / SDK] -->|Bearer acld token| API[/v1 route]
  API --> Auth[authenticate]
  Auth --> Grant[(grants.token_hash)]
  Grant --> Chain[walk parent grants]
  Chain --> Principal[Principal: account, grant, policy]
  Principal --> Route[route authorize]
  Route --> State[(projects, machines, operations)]
```

## Current SSH and PKI model

The implemented SSH path is internal platform proof, not customer login. The guest image trusts the platform SSH user CA and host keys, but `images/sshd_config` allows only `agent-probe`, disables password and authorized-key login, disables root login, forwarding, tunnels and TTYs, and reads authorized principals from `/var/lib/agent-cloud/probe-principals` (`images/sshd_config:1`). During boot, `guestctl` writes that principals file with only the probe and runtime principals for the exact guest subject (`packages/guestctl/src/system.ts:21`).

The signer wraps Smallstep and `ssh-keygen`. It validates configured CA URLs and public CA material, signs guest host certificates for one hour, and issues probe/runtime user credentials for five minutes (`packages/pki/src/index.ts:78`, `packages/pki/src/index.ts:140`). Probe and runtime certificates use distinct principals derived from the guest subject. Runtime credentials are still forced into the probe user path; the remote wrapper chooses the command.

`packages/remote` runs native OpenSSH with isolated temporary key and known-hosts files. `withSshFiles()` forces `-F /dev/null`, strict host checking, no inherited global known hosts, no agent, no proxy/jump, no password auth, and cleared forwarding (`packages/remote/src/ssh-files.ts:12`). `createGuestProbe()` only accepts controller-supplied IP addresses, checks credential purpose/subject/expiry, and runs either `guestctl identity --json` or `sudo -n -- /usr/local/bin/guestctl inspect --json` as `agent-probe` (`packages/remote/src/index.ts:41`).

Provider ownership is checked before those reads. `observeGuest()` requires one recorded live server and one recorded live Primary IP for the allocation, validates ownership labels, re-reads both resources from the provider, checks type/region/IP assignment, and returns the provider IP only if the VM is running and exactly owns that IP (`apps/control/src/guest-observation.ts:13`).

```mermaid
flowchart TD
  Create[machine create bootstrap] --> Guest[guestctl first boot]
  Guest --> Enroll[/guest/enroll]
  Enroll --> Observe[observe owned server + IP]
  Observe --> Probe[probe SSH identity]
  Probe --> Sign[sign host + TLS certs]
  Sign --> Ready[readiness uses runtime SSH inspect]
  Ready --> Renew[guest renewal preserves identity]
```

## Where things live

- `packages/contracts/src/auth.ts`: capability, grant policy and principal schemas.
- `packages/db/src/schema.ts`: account, project, grant, machine, allocation and operation tables.
- `apps/control/src/auth.ts`: bearer authentication, grant-chain validation, delegation and revocation.
- `apps/control/src/app.ts`: `/v1` route wiring and customer-access mode switch.
- `apps/cli/src/index.ts`: JSON CLI, local credential loading and token-based login.
- `packages/sdk/src/index.ts`: typed client methods and bearer request wrapper.
- `packages/pki/src/index.ts`: Smallstep-backed host/probe/runtime certificate signer.
- `packages/remote/src/ssh-files.ts` and `packages/remote/src/index.ts`: isolated OpenSSH invocation for platform probes.
- `images/sshd_config` and `packages/guestctl/src/system.ts`: guest SSH trust and admitted principals.
- `docs/archive/original-plan.md:406`: archived browser/device login and customer SSH plan.

## Gaps for M2

Browser and device login are absent. The archived plan calls for GitHub OAuth in the browser, OAuth device authorization for CLI, visible approval scopes, rate-limited polling, short-lived access tokens, refresh credentials in the OS keyring, and verification of issuer/audience/signature/scope (`docs/archive/original-plan.md:406`). The current system has opaque grants only. It has no auth-library tables, OAuth subject, browser user/session, device code, refresh token rotation, `slow_down` handling, or account approval UI.

Customer SSH is also absent. The archived HTTP contract includes `POST /v1/machines/:id/access-sessions` and says grant revocation should terminate associated sessions (`docs/archive/original-plan.md:351`). The archived SSH flow expects the CLI to generate an ephemeral key, the API to issue a short-lived SSH user certificate plus single-use transport ticket, OpenSSH to use `acld` as a ProxyCommand through a TLS/WebSocket gateway, the gateway to forward only to the recorded provider IP on port 22, and revocation to close active sessions (`docs/archive/original-plan.md:436`).

Current revocation is strong for future API requests because every request walks the grant chain. It is not sufficient for live SSH because there are no durable access sessions, no active tunnel registry, and no gateway process to close. Current guest SSH trust also cannot admit customer root-equivalent access: only `agent-probe` is allowed, no TTY or forwarding is permitted, and the principals file contains only internal probe/runtime principals.

## Archived plan recommendations, not implemented behavior

The archived M2 plan recommends keeping customer agent delegation explicit: owners create scoped grants rather than handing agents owner credentials; grant scope should constrain projects, capabilities, expiry, size/region and spend (`docs/archive/original-plan.md:416`). It also calls out that `machine:exec` is root-equivalent and revocation cannot undo credentials copied into the VM or changes made inside it (`docs/archive/original-plan.md:432`).

For future customer SSH, the existing code suggests useful boundaries but does not decide them. A new API route/service would need to authorize `machine:exec`, project scope, live grant activity, live allocated machine state, issued guest identity, current provider ownership and a bounded session lease. A new data model would need hashed transport tickets, public key binding, grant/machine/allocation references, expiry, opened/closed/revoked timestamps, and idempotency. A new signer method should issue customer SSH certificates with distinct principals and without weakening probe/runtime forced-command credentials. A gateway should not hold signer keys, should never accept caller-supplied destinations, and should recheck or subscribe to revocation before and during sessions.

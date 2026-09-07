# Customer authentication

An admitted customer runs `acld login --server https://cloud.example` and completes GitHub's device authorization in a browser. The CLI prints the GitHub verification URL and a short code to stderr. It requests public identity only. The cloud verifies the token with its own OAuth application's credentials and uses GitHub's numeric user ID, never a mutable login name or email address.

The operator explicitly admits customers during the non-billing preview. Public sign-in cannot create an account, change its limits or enable internal deployment access. The existing internal identity remains separate. Image-factory mode has no customer login endpoints.

## Customer commands

```sh
acld login --server https://cloud.example
acld whoami
acld grant create deployment-agent --policy ./agent-policy.json \
  --expires-at 2026-09-08T10:00:00Z --credentials ./agent.credentials.json
ACLD_CREDENTIALS=./agent.credentials.json acld project list
acld grant list
acld grant revoke <grant-id>
acld logout
```

Use a future expiry within the current credential's lifetime. Agent policies can narrow capabilities, projects, sizes, regions and reservation limits. The cloud checks the current ancestor chain on every authenticated request and again under the account lock before mutation admission. Logout revokes the current credential and its descendants before deleting the local file. A read-only credential can revoke itself; it cannot revoke another credential without grant-management authority.

Credentials are stored in `~/.config/agent-cloud/credentials.json` or `ACLD_CREDENTIALS`. Files are exclusive and owner-only. `login --token-stdin` remains available for an existing internal or delegated token and will not overwrite a credential file. Never put tokens in command arguments or repository files.

A login credential expires after 30 days or when its admission expires, whichever comes first. There is no background refresh token. Sign in again after logout to create a fresh credential. Operator revocation, admission renewal and ancestor revocation invalidate older descendants immediately for API use. Existing platform SSH sessions close within their authority lease, as described in [customer access](customer-ssh.md).

## Interrupted login

Before requesting cloud access, the CLI saves a random cloud token, the cloud URL and a login ID, then syncs the file and its directory ancestry. The raw GitHub token is used only in memory. Only the cloud token's SHA-256 hash crosses the issuance endpoint. A receipt binds the login ID to the GitHub identity, account and token hash.

If the final reply is lost, the CLI tries `whoami` with the saved token. Retry the same login command with the same file. An existing pending file is synced again before issuance; a replay returns the same current grant. A different account or token hash cannot reuse its ID. Revoked or expired receipts never issue new authority.

Login and logout hold an exclusive lock directory beside the credential file, using the canonical parent path. Token-stdin login uses the same lock. A killed process may leave `<credentials>.lock/owner.json` containing its PID. Inspect that process and verify it has exited before removing that exact lock directory. Do not remove the credential file to recover a pending login, and never remove a lock held by a live or suspended process. Locks are not stolen on a timer because an old process could resume and issue an orphaned token.

## Operator setup

1. Register a GitHub OAuth application with device flow enabled. It needs no repository, organization or email scopes. The CLI uses GitHub's fixed device endpoints; no browser callback route is required by this flow.
2. Save `{ "clientId": "…", "clientSecret": "…" }` to an owner-only file outside the repository. Set `ACLD_GITHUB_CONFIG` to its absolute path on the API process. The client ID is public; the client secret stays on the control plane. The worker and guest do not receive it.
3. Run `pnpm db:migrate`, then `pnpm db:check`. Customer identity tables are in immutable migration `0021_customer_identity.sql`.
4. Admit the intended numeric GitHub user ID through the operator command below. The operator command requires direct database access. There is no public admission endpoint.

```sh
pnpm customer admit ./private-admission.json
pnpm customer inspect <github-numeric-user-id>
pnpm customer disable <github-numeric-user-id>
```

An admission request has this shape. Replace the expiry with a future UTC time within one year and choose limits within the operator's configured currency, machine and hourly caps.

```json
{
  "githubUserId": "123456",
  "name": "preview-customer",
  "policy": {
    "capabilities": ["project:read", "machine:read", "grant:manage"],
    "projects": { "kind": "all" },
    "sizes": ["small"],
    "regions": ["fsn1"],
    "maxMachines": 0,
    "currency": "EUR",
    "maxHourlyMicros": 0
  },
  "expiresAt": "2026-10-01T00:00:00Z"
}
```

The example grants inspection only. Add the deployment capabilities explicitly when admitting a customer who may allocate infrastructure. See the capability enum in `packages/contracts/src/auth.ts` and configured provider offers for allowed regions. Admission creates an account, a default project and an unexposed authority grant. No raw authority token is retained or delivered.

`pnpm customer renew ./private-renewal.json` accepts `githubUserId`, `expectedAnchorGrantId` from inspection, `policy` and `expiresAt`. It preserves the account and projects, revokes the previous authority and its descendants, then installs a new authority. Existing credentials never gain wider permissions through a changed ancestor. Renewal cannot change account currency. A stale expected anchor fails; inspect again after an uncertain operator response. Disable prevents future sign-in and closes existing platform access. Renewal can deliberately readmit a disabled customer.

## API and verification

- `GET /auth/config` returns the public client ID and the invitation requirement.
- `POST /auth/github` accepts a GitHub OAuth bearer token and `{ id, tokenHash }`; the result contains the principal and expiry, never a raw credential.
- GitHub verification checks our OAuth app, a user identity and public-only scope. Requests use fixed HTTPS URLs, reject redirects, and have deadlines and 64 KiB response limits.
- The API limits verification attempts to 30 per minute per process. Persistent issuance is limited to 20 credentials per customer per day. Replay does not consume another issuance. These are preview limits; they are separate from machine reservations.
- `pnpm smoke:login` runs actual CLI processes and the API against a temporary database. Set `ACLD_GITHUB_CONFIG` and `ACLD_GITHUB_USER_ID`, then authorize the printed code in GitHub. It admits an account with zero VM allocation, verifies delegated access and revocation, and removes its database, processes and credentials. It does not call Hetzner.

The flow follows GitHub's [device authorization protocol](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow) and [OAuth token verification API](https://docs.github.com/en/rest/apps/oauth-applications#check-a-token). Revoking the GitHub OAuth application does not itself revoke an already issued cloud credential. Use cloud logout, grant revocation or operator disable for that purpose.

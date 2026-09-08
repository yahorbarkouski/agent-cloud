# Run a customer cloud with Compose

`infra/compose/customer.yaml` runs the existing customer API, worker, PostgreSQL and both gateways on one Linux host. Caddy serves the control API, SSH WebSocket upgrades and application HTTPS on ports80/443. The API and access gateway listen on loopback inside a shared network namespace. PostgreSQL has no host port. API and worker have outbound access to Hetzner and guests; the database remains on an internal network.

This is the customer topology. The [simulated quickstart](self-host.md) remains separate. There is no internal bootstrap service or unauthenticated customer admission. Stripe is excluded.

## Prepare the existing configuration

Build and retain the immutable runtime image as described in the quickstart. Set `ACLD_CUSTOMER_IMAGE` to its image ID and `ACLD_CUSTOMER_DIRECTORY` to an absolute private directory on the Linux host. Prepare these subdirectories before starting Compose; missing bind sources fail instead of creating empty directories:

| Directory    | Contents and access                                                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `database`   | PostgreSQL `password`; mounted only in PostgreSQL.                                                                                                             |
| `control`    | `control.env`, provider token, customer runtime JSON, GitHub/access/hosting/backup configuration and required signer/trust files. Read-only in API and worker. |
| `identity`   | Existing runtime identity and bootstrap encryption material, mounted durably for API and worker. Preserve it across upgrades.                                  |
| `generation` | `current.json`, the external control generation matching this database. Mounted read-only by every normal mutator.                                             |
| `gateway`    | Public gateway controller JSON, its own client identity, trust and durable Caddy state. No DB, provider or CA signing credentials.                             |
| `access`     | Access gateway `config.json`, containing its dedicated gateway token and loopback control URL. No DB/provider/signer credentials.                              |
| `operator`   | `operator.env` with DB URL, generation path and limits, plus private admission requests. No provider or signer is needed to admit customers.                   |
| `retention`  | Optional `retention.env`, retention configuration and independent storage deleter. Never mount the backup decryption keyring here.                             |

Private files must be regular files, mode0600 and owned by container UID1000. Private directories must be0700. Use container-visible absolute paths in JSON and environment files. The runtime includes `/usr/local/bin/step`, `/usr/local/bin/caddy` and `/usr/bin/ssh`; do not mount host binaries. Generate a strong database password and put its URL-encoded value in the private `DATABASE_URL` in `control.env` and `operator.env`. Docker Compose's interpolation environment contains only the image ID and directory path, never secrets.

The customer runtime requires an existing signed guest image publication and its matching database records, identity and firewall. Use the [image release procedure](architecture/image-release.md) before selecting customer mode. Back up those records and private identity together. This template does not create cloud resources or manufacture replacement identities at startup.

`control.env` selects `PROVIDER=hetzner`, `HOST=127.0.0.1`, `PORT=4319`, and your HTTPS `PUBLIC_URL`. Set explicit `PROVIDER_CURRENCY`, `MAX_PROVIDER_HOURLY` and `MAX_LIVE_MACHINES`; retain the recorded budget caps. Point `ACLD_CONTROL_GENERATION_FILE` at `/run/agent-cloud/generation/current.json`, `AGENT_CLOUD_RUNTIME` at the customer runtime JSON under `/run/agent-cloud/control`, and `HCLOUD_TOKEN_FILE` at its private provider token. Configure GitHub, access, hosting and backups through their existing `ACLD_*_CONFIG` files. Backup scratch can use `/var/lib/agent-cloud/scratch`; size the host disk and configured scratch limit for the intended captures.

Keep only DB URL, provider/currency/limits and the generation path in `operator.env`. Both files must agree on limits. Do not set `ACLD_LOCAL_QUICKSTART` or `INTERNAL_REFERENCE_GRANT`.

## Set the shared HTTPS origin

In `gateway/controller.json`, set `apiUrl` to `http://127.0.0.1:4319` and add this to its existing `gateway` configuration:

```json
{
  "control": { "hostname": "cloud.example.com", "port": 4319, "accessPort": 4322 },
  "listenAddress": "0.0.0.0",
  "httpPort": 80,
  "httpsPort": 443,
  "publicTls": { "kind": "acme", "email": "operator@example.com" }
}
```

Use your actual domain and email. Point its A/AAAA records at this host and permit inbound80/443. The hostname must match `PUBLIC_URL` and stay outside your generated application namespace. The API refuses customer publication/domain claims for its hostname, and the gateway independently refuses a conflicting application snapshot. A restart renders retained routes with the current operator configuration, so an old saved control origin cannot override it.

The control HTTPS route exists before the first application. Only exact `/v1/ssh` goes to loopback4322; other requests go to the API. Configure `access/config.json` with `host=127.0.0.1`, `port=4322`, `controlUrl=http://127.0.0.1:4319` and its existing gateway token. Advertise `wss://cloud.example.com` in the control access configuration. Do not expose4322 directly. Caddy retains public certificate state in the gateway directory; application upstreams still require their separate mTLS identity.

## Initialize, admit and start

```sh
customer_compose() { docker compose -p agent-cloud-customer -f infra/compose/customer.yaml "$@"; }
customer_compose config --quiet
customer_compose up --detach --wait postgres
customer_compose run --rm --no-deps operator migrate
```

For a genuinely empty new database, prepare a generation using the existing `control-recover prepare` command, with a one-off writable mount of only the generation directory. Apply a private `initialize` request with its UUID, generation and operator ID as described in [control recovery](control-recovery.md). Normal services keep that directory read-only. An existing or restored database must retain or reconcile its matching generation; initialization refuses existing accounts/image records. Never initialize over a recovery problem.

Prepare an owner-only admission JSON under `operator` using the [customer authentication contract](architecture/customer-authentication.md). Include the verified numeric GitHub user ID, account name, explicit bounded policy and admission expiry. Then:

```sh
customer_compose run --rm --no-deps operator customer admit /run/agent-cloud/operator/admit.json
customer_compose run --rm --no-deps operator customer inspect <github-user-id>
customer_compose up --detach --wait api worker
customer_compose up --detach public-gateway access-gateway
```

A customer with the [standalone CLI](cli-install.md) can now run `acld login --server https://cloud.example.com`, `acld whoami`, `acld capabilities` and `acld project list`. Existing agents can read `/llms.txt` and `/openapi.json`. Verify public DNS and the actual certificate chain before inviting customers. The automated container proof uses a private test CA and a fixture GitHub verifier; public ACME and final Hetzner customer deployment remain separate verification.

Use `operator customer disable <github-user-id>` to revoke the admission anchor and descendants. Renewal takes a private request with the current `expectedAnchorGrantId`; inspect first and retain the returned receipt. Existing revoked credentials stay revoked after renewal. Starting the optional retention process requires its separately scoped credentials: `customer_compose --profile retention up --detach retention`.

Back up PostgreSQL, the runtime identity, external generation and independently protected data keys before upgrades. Preserve named database/scratch volumes and the private directories on ordinary shutdown. If recreating the API container, recreate both gateways too because they share its network namespace. Avoid automatic image updates. Removing the database volume or private directories destroys state; follow the existing recovery procedure and exact ownership records.

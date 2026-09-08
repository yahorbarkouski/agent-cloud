# Run the control plane locally

This quickstart runs the packaged API, Graphile worker, CLI and PostgreSQL with the simulated provider. It exercises authentication and durable machine operations without creating VMs. It does not configure customer GitHub admission, public TLS, Hetzner, guest images, SSH gateways or protected object storage.

Use Docker Engine/Desktop with Compose v2 and about 2 GiB free memory, plus disk for the image and database. The smoke script additionally needs Node.js 24 or 26. Run commands from the repository root at the source revision you intend to deploy.

## Build and initialize

```sh
docker build -f infra/container/Dockerfile -t agent-cloud-runtime:local .
export ACLD_SELF_HOST_IMAGE="$(docker image inspect agent-cloud-runtime:local --format '{{.Id}}')"
export ACLD_SELF_HOST_PORT=4319
dco() { docker compose -p agent-cloud-local -f infra/compose/self-host.yaml "$@"; }
dco config --quiet
dco run --rm --no-deps initialize
dco up --detach --wait postgres
dco run --rm --no-deps migrate
dco run --rm --no-deps bootstrap
dco up --detach --wait api worker
dco run --rm --no-deps cli cli whoami
dco run --rm --no-deps cli cli project list
```

The selected local image ID is immutable; retain it alongside the source revision for upgrades. The Dockerfile pins the official Node 24 base by digest, pnpm 12.3.4 and dependency lockfile, Smallstep 0.30.6 archive checksum, and OpenSSH/CA package versions. Builds fail if a pinned dependency is unavailable. The final image contains deployed production dependencies and runs as UID/GID 1000. It needs no host Node modules. BuildKit's [Dockerfile-specific ignore file](https://docs.docker.com/build/concepts/context/#dockerignore-files) allows source/manifests/migrations and the packaging entrypoint; `.local`, environment files, keys, host dependencies and Git history are excluded. Never add credentials to source or build arguments.

Initialization creates one random database password in the `configuration` named volume, mode 0600. PostgreSQL reads that file; the runtime reads it privately instead of putting the password in Compose's environment. `database` stores PostgreSQL data. `operator` stores the existing bootstrap credential, also mode 0600, mounted only for bootstrap and CLI. Initialization syncs both the password file and directory, including a retry after an interrupted write. Initialization and bootstrap preserve existing identity on repeat. A partial or invalid secret fails initialization; it is never silently replaced. Keep all three volumes together.

`bootstrap` explicitly invokes `bootstrap-internal --allow-internal-development`. The wrapper also requires the simulated provider and loopback public URL. This creates the existing bounded development account with a 30-day credential; it is not customer registration or an automatic credential renewal mechanism. The quickstart publishes only `127.0.0.1:$ACLD_SELF_HOST_PORT`, has no PostgreSQL host port, and uses an internal Docker network. Do not publish it through a public reverse proxy or change it into a public bootstrap service.

The CLI joins the API network namespace and uses `http://127.0.0.1:4319`, preserving the product's HTTPS-or-loopback rule. Invoke `dco run --rm --no-deps cli cli ...`; this also works when the host port differs. Nothing prints the saved token. API requests without credentials are rejected.

## Use and verify

Use the project ID from `project list`. Supply a stable UUID for each mutation's `--key`; reuse it after a lost reply.

```sh
dco run --rm --no-deps cli cli machine create example --project <project-id> --key <create-uuid>
dco run --rm --no-deps cli cli operation wait <operation-id> --timeout 30
dco run --rm --no-deps cli cli machine inspect <machine-id>
dco restart api worker
dco run --rm --no-deps cli cli machine inspect <machine-id>
dco run --rm --no-deps cli cli machine destroy <machine-id> --expected-version <version> --allow-data-loss --key <destroy-uuid>
dco run --rm --no-deps cli cli operation wait <destroy-operation-id> --timeout 30
```

Inspect reports a simulated guest, not a usable VM. Shutdown preserves storage: `dco down`. Start it again with `dco up --detach --wait api worker`. Removing volumes is destructive: `dco --profile setup --profile tools down --volumes --remove-orphans` deletes this project's database, password and development credential.

The complete disposable packaging proof is:

```sh
node scripts/self-host-smoke.mjs
```

It builds a unique local image, uses fresh uniquely named volumes, verifies refused unscoped/public bootstrap and unauthenticated API access, authenticates the packaged CLI, creates a simulated machine, restarts PostgreSQL/API/worker, verifies the same identity and machine, then destroys it. It refuses any pre-existing project or image before mutation. Its `finally` removes that exact Compose project's containers, network, volumes and image tag and verifies no owned resources remain. Shared Docker build/base-image caches remain. It neither uses nor stops the normal development database/CA.

## Update and back up before migration

Migrations run explicitly, never as an API startup side effect. Back up PostgreSQL and private configuration before changing the image or schema. A database dump contains tokens' hashes, private operational records and encrypted material: protect it even though it is not a plaintext token export.

```sh
umask 077
mkdir -p .local/self-host-backups
backup_directory="$(mktemp -d .local/self-host-backups/checkpoint.XXXXXX)"
dco stop api worker
dco exec -T postgres pg_dump -U agentcloud -d agentcloud --format=custom > "$backup_directory/control.dump"
dco run --rm --no-deps --entrypoint tar initialize -C /run/agent-cloud -czf - . > "$backup_directory/configuration.tar.gz"
dco run --rm --no-deps --entrypoint tar bootstrap -C /work/.local -czf - . > "$backup_directory/operator.tar.gz"
dco exec -T postgres pg_restore --list < "$backup_directory/control.dump" > /dev/null
```

The command creates a new private backup directory for each checkpoint. Move a verified, encrypted copy off the control host using your operator backup process. Preserve the current image ID and source revision with it. For a real deployment also back up runtime identity metadata, bootstrap encryption key, signer identities, configuration receipts, and the independent backup decryption keyring. These are not recoverable from the control DB alone.

Build the reviewed source revision with the same build command, update `ACLD_SELF_HOST_IMAGE` to its ID, run `dco run --rm --no-deps migrate`, then `dco up --detach --wait --force-recreate api worker`. Re-run CLI authentication and inspect a known machine. Applied migration files are immutable. Do not assume that an older image can use a migrated database; rehearse restoration of the saved dump and matching configuration/image in a separate isolated project. Before enabling real provider workers after restoring old control state, reconcile outstanding provider intents and ownership so recovery cannot repeat an uncertain create. Control-DB disaster recovery is not proven by this simulated restart check.

## Connect an existing customer runtime

The same image exposes commands `api`, `worker`, `migrate`, `cli`, `access-gateway`, `public-gateway` and `backup-retention`. Use a separate operator Compose configuration for the live topology; the local YAML intentionally fixes the simulated provider and internal network.

Mount an existing owner-only environment file read-only and set `ACLD_CONTAINER_ENV_FILE` to its absolute container path. The wrapper uses the existing private-file check and loads its values only inside the process. All private files must be mode 0600 and owned by container UID 1000; private directories should be 0700. Use container-visible absolute paths in every referenced JSON file. Do not mount a macOS executable into a Linux container.

| Process               | Existing configuration and mounts                                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API and worker        | `DATABASE_URL`, `HOST`, `PORT`, HTTPS `PUBLIC_URL`, explicit `PROVIDER=hetzner`, currency/hourly/machine limits, `HCLOUD_TOKEN_FILE`, `AGENT_CLOUD_RUNTIME`; read-only provider/runtime/PKI files and durable writable runtime identity directory. The image includes `/usr/local/bin/step` and `/usr/bin/ssh`.                                                                            |
| Customer login/access | Existing `ACLD_GITHUB_CONFIG` and `ACLD_ACCESS_CONFIG` files with their referenced trust and provisioner material; follow [customer authentication](architecture.md), using admitted customer identities rather than development bootstrap.                                                                                                                                                |
| Hosting               | Existing `ACLD_HOSTING_CONFIG`; run the access and public gateways as separate services with `ACLD_GATEWAY_CONFIG` / `ACLD_PUBLIC_GATEWAY_CONFIG`, reachable HTTPS endpoints and durable receipt/state mounts. Provide the configured pinned Linux Caddy executable read-only for the public gateway. Gateway runtime receives its client identity/trust, never a CA provisioner password. |
| Backup capture        | Existing `ACLD_BACKUP_CONFIG`, separate writer/reader credentials, trusted encrypted-backup keyring and a durable bounded scratch mount sized for capture. Never put these in guest images.                                                                                                                                                                                                |
| Retention operator    | `ACLD_BACKUP_RETENTION_CONFIG`, control DB access and its separate deleter credential only. Do not mount it in API/capture workers or give this process the backup keyring.                                                                                                                                                                                                                |

Provide real network routes/firewalls, verified guest images, PKI, GitHub customer admission and public HTTPS using the existing subsystem setup. Do not expose PostgreSQL or a gateway's admin socket. Retain the API's private configuration and gateway credential separation when adding ingress. This image's Linux ARM64 simulated path has been exercised; real provider/container networking, public ACME, gateway binaries, external Object Lock and full customer deployment/restore still need their own acceptance run.

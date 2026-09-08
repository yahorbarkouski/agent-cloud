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
node scripts/self-host-smoke.mjs --restore
```

It builds a unique local image, uses fresh uniquely named volumes, verifies refused unscoped/public bootstrap and unauthenticated API access, authenticates the packaged CLI, creates a simulated machine, restarts PostgreSQL/API/worker, verifies the same identity and machine, then destroys it. It refuses any pre-existing project or image before mutation. Its `finally` removes that exact Compose project's containers, network, volumes and image tag and verifies no owned resources remain. Shared Docker build/base-image caches remain. It neither uses nor stops the normal development database/CA.

`--restore` adds a second isolated project. It quiesces the source API/worker, saves a bounded custom-format database dump and matching private configuration/credential, and records their SHA-256 hashes with the exact image ID and applied migration hashes. The temporary directory is 0700, files are 0600, and files/directories are synced. A damaged dump, missing credential and mismatched image are rejected before any target service exists. The target receives the saved files directly, without initialization or bootstrap. After transactional database restoration, its API/CLI verify the same principal, machine, usage and reservation history before the target worker starts. A new power-off operation affects only the restored copy; the original machine and history remain inspectable and unchanged. Both projects and private copies are removed. The fixture bounds the dump/transfer at 32 MiB and each private file at 16 KiB; it is an acceptance test for this small simulated installation, not a general backup utility.

## Update and back up before migration

Migrations run explicitly, never as an API startup side effect. Back up PostgreSQL and private configuration before changing the image or schema. A database dump contains tokens' hashes, private operational records and encrypted material: protect it even though it is not a plaintext token export.

```sh
umask 077
mkdir -p .local/self-host-backups
backup_directory="$(mktemp -d .local/self-host-backups/checkpoint.XXXXXX)"
docker inspect --format '{{.Image}}' "$(dco ps --all --quiet api)" > "$backup_directory/image-id"
dco run --rm --no-deps cli cli whoami > "$backup_directory/principal.json"
dco run --rm --no-deps cli cli usage history > "$backup_directory/reservation-history.json"
dco stop api worker
dco exec -T postgres pg_dump -U agentcloud -d agentcloud --format=custom > "$backup_directory/control.dump"
dco exec -T postgres psql -U agentcloud -d agentcloud -At -c "SELECT coalesce(json_agg(json_build_object('hash',hash,'createdAt',created_at::text) ORDER BY id),'[]'::json)::text FROM drizzle.__drizzle_migrations" > "$backup_directory/migrations.json"
dco run --rm --no-deps --entrypoint tar initialize -C /run/agent-cloud -czf - . > "$backup_directory/configuration.tar.gz"
dco run --rm --no-deps --entrypoint tar bootstrap -C /work/.local -czf - . > "$backup_directory/operator.tar.gz"
dco exec -T postgres pg_restore --list < "$backup_directory/control.dump" > /dev/null
(cd "$backup_directory" && shasum -a 256 control.dump configuration.tar.gz operator.tar.gz image-id migrations.json principal.json reservation-history.json > SHA256SUMS)
sync
```

The command creates a new private backup directory for each checkpoint. Move a verified, encrypted copy off the control host using your operator backup process. Preserve the current image ID and source revision with it. For a real deployment also back up runtime identity metadata, bootstrap encryption key, signer identities, configuration receipts, and the independent backup decryption keyring. These are not recoverable from the control DB alone.

Build the reviewed source revision with the same build command, update `ACLD_SELF_HOST_IMAGE` to its ID, run `dco run --rm --no-deps migrate`, then `dco up --detach --wait --force-recreate api worker`. Re-run CLI authentication and inspect a known machine. Applied migration files are immutable. Do not assume that an older image can use a migrated database; restore the saved dump with its matching configuration/image first, then perform an explicit upgrade.

## Restore the simulated control installation

These commands restore the trusted quickstart checkpoint above into a new project. Keep the source API/worker stopped during capture. They are never pointed at the target's volumes or database. Check the checksum file against your trusted offline checkpoint; checksums beside an attacker-modified archive are not authentication. Keep the recorded image available locally or export it privately before removing old images. An expired or revoked credential remains expired or revoked after restore; do not bootstrap a replacement identity to hide a failed recovery.

```sh
(cd "$backup_directory" && shasum -a 256 --check SHA256SUMS)
export ACLD_SELF_HOST_IMAGE="$(cat "$backup_directory/image-id")"
docker image inspect "$ACLD_SELF_HOST_IMAGE" --format '{{.Id}}'
restore_project="agent-cloud-restore-$(uuidgen | tr '[:upper:]' '[:lower:]')"
export ACLD_SELF_HOST_PORT=4320
rdco() { docker compose -p "$restore_project" -f infra/compose/self-host.yaml "$@"; }
test -z "$(docker container ls --all --filter "label=com.docker.compose.project=$restore_project" --quiet)" &&
test -z "$(docker volume ls --filter "label=com.docker.compose.project=$restore_project" --quiet)" &&
test -z "$(docker network ls --filter "label=com.docker.compose.project=$restore_project" --quiet)"
```

Stop on any failed command or collision; choose an unused loopback port. Inspect `rdco config --quiet`. Extract only trusted configuration archives created by the capture steps, which contain the small private files for this installation. Do not invoke `initialize-local`, `bootstrap-internal` or `migrate` on the restore target. The commands below reuse the setup services' volume mounts but replace their entrypoint with `tar`; they do not generate a password or identity.

```sh
rdco run --rm --no-deps -T --entrypoint tar initialize --extract --gzip --file=- --directory=/run/agent-cloud --no-same-owner < "$backup_directory/configuration.tar.gz"
rdco run --rm --no-deps -T --entrypoint tar bootstrap --extract --gzip --file=- --directory=/work/.local --no-same-owner < "$backup_directory/operator.tar.gz"
rdco up --detach --wait postgres
rdco exec -T postgres pg_restore -U agentcloud -d agentcloud --exit-on-error --single-transaction --no-owner --no-privileges < "$backup_directory/control.dump"
rdco exec -T postgres psql -U agentcloud -d agentcloud -At -c "SELECT coalesce(json_agg(json_build_object('hash',hash,'createdAt',created_at::text) ORDER BY id),'[]'::json)::text FROM drizzle.__drizzle_migrations" > "$backup_directory/restored-migrations.json"
cmp "$backup_directory/migrations.json" "$backup_directory/restored-migrations.json"
rdco up --detach --wait api
rdco run --rm --no-deps cli cli whoami > "$backup_directory/restored-principal.json"
rdco run --rm --no-deps cli cli usage history > "$backup_directory/restored-reservation-history.json"
cmp "$backup_directory/principal.json" "$backup_directory/restored-principal.json"
cmp "$backup_directory/reservation-history.json" "$backup_directory/restored-reservation-history.json"
rdco run --rm --no-deps cli cli machine inspect <saved-machine-id>
```

PostgreSQL's [single-transaction restore](https://www.postgresql.org/docs/17/app-pgrestore.html) rolls back on a restore error. Leave target API/worker stopped if archive validation, SQL restoration or migration comparison fails; leave its worker stopped if identity or history checks fail. A fresh empty target avoids mixing the checkpoint with unrelated data. Only after those checks pass, start `rdco up --detach --wait worker` and exercise a new simulated operation there. Resume the original quickstart using its original image/port settings and `dco up --detach --wait api worker`; inspect the original machine and reservation history to confirm it remains unchanged.

To remove only the test restore, use `rdco --profile setup --profile tools down --volumes --remove-orphans` and verify no resources carry its Compose project label. Keep the original project's volumes and your private checkpoint unless you intend to delete them. The disposable `--restore` smoke performs exact cleanup of both projects because it owns both from creation.

This verifies control-DB/private-identity recovery for the simulated provider. For a real provider, keep both old and restored workers, retention operators, scheduled jobs and other mutators fenced outside the database: restoring a DB also restores stale leases, intents and revocations. Do not run real customer data through this simulated quickstart or give a test restore live provider, CA-issuance or deletion credentials. A single operator must reconcile external resources against durable ownership receipts and current authority, choose the authoritative control instance, and account for changes after the checkpoint before enabling any mutator. Public routes, guest certificates and encrypted-backup keys need their separate matching recovery material. None of that external-state recovery is proven by this local fixture.

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

# Compose deployment and recovery

The customer CLI uploads ordinary Compose source through the existing authenticated SSH gateway. The guest stores a release and asks systemd to apply it. No internal reference endpoint or provider credential is involved. Docker owns the running containers after the CLI disconnects.

## Customer workflow

Prepare a small local deployment context containing a Compose file, Dockerfiles and the source/configuration they need. The helper includes **every regular file** in this directory: no implicit ignore rules. Keep credentials unrelated to the application, repository history and installed dependencies outside it. The context limit is 8 MiB/1024 files; symlinks and special files are refused. Prebuilt images avoid uploading large build contexts. Ordinary SSH and SFTP remain available for larger/custom workflows.

```sh
acld compose apply vm_... example --source ./deployment --file compose.yaml --release <UUIDv4>
acld compose wait vm_... example
acld compose inspect vm_... example
acld compose logs vm_... example --service backend

acld compose apply vm_... example --source ./deployment --file compose.yaml \
  --release <new-UUIDv4> --expected-release <current-UUIDv4>
acld compose wait vm_... example

acld compose recover vm_... example --from <successful-UUIDv4> \
  --release <new-recovery-UUIDv4> --expected-release <current-UUIDv4>
acld compose wait vm_... example
```

Admission returns a release, not a healthy application. `wait` uses one SSH connection for up to five minutes and exits 0 only when the observed current release succeeded; otherwise inspect its JSON state. The response includes the release ID, previous successful ID, pinned images, configuration digest and phase. `inspect` adds current container health; `logs` returns bounded application logs to the authorized caller. These commands require `machine:exec`, which grants root control of the entire VM. Apps on that VM are not separate security tenants.

Each intended mutation needs a fresh lowercase UUIDv4. Retry a lost reply with the **same ID and identical source/options**. A conflicting request is refused. An expected-release conflict requires inspection; do not blindly replace the expected ID. A pending release blocks another mutation of that app. Historical retries return their own saved result without moving the current head.

## Persistence and recovery

Guest data lives under `/var/lib/agent-cloud/compose/<app>/releases/<id>`. The request bundle, source, normalized build configuration and final runtime configuration stay on that machine. Root-only parent directories protect application secrets. Request and state files are 0600. Release files and their directory entries are synced before work can apply them. Source paths are validated relative paths; archive extraction is not used.

The stable Docker project is `acld-<app>`, independent of a source file's `name`. Use named volumes for PostgreSQL and other mutable data, and `restart: unless-stopped` for long-running services. Explicit external volumes and absolute bind paths retain ordinary Compose semantics; choose them deliberately because they can share data between apps. Anonymous volumes, including volumes declared by images without an explicit mount, are refused. Bind mounts from retained source must be read-only. The helper never runs `down`, removes volumes or prunes retained images/source.

Builds use distinct tags for each release and service. The worker pulls non-buildable images, resolves every service to a local image ID, saves a configuration with build removed and pull disabled, then runs `up --detach --wait --remove-orphans --no-build --pull never`. The Compose health deadline defaults to 120 seconds and can be set to 5–300 with `--wait-seconds`. Services without health checks can only be verified as running, so applications should define meaningful checks.

Recovery copies a previously succeeded runtime configuration, verifies its digest and retained image IDs, and applies it as a new release. It does not rebuild or fetch a newer mutable tag. Existing named volumes are reattached. Missing images or a changed runtime file fail recovery instead of falling back to new content. Retain source files: Compose bind mounts, configs and secrets can refer to the original release directory.

Recovery changes code/configuration and can interrupt service. **It does not reverse database migrations or restore database contents.** Run migrations explicitly through durable commands and inspect an uncertain outcome before doing anything again. Use a protected backup and isolated restore when data itself needs recovery. See [protected backups and isolated restore](protected-backups.md) for the supported PostgreSQL/file recovery path.

## Promote a verified restore

`acld compose promote <machine> <app> --release <new-uuid> --expected-release <isolated-release>` creates a new release from the current successful isolated configuration. It uses the retained image IDs and data mounts, replaces the internal default network with a distinct ordinary bridge, and forces container recreation. Published ports must remain on `127.0.0.1`; host networking and foreign networks are refused. The application gains egress and loopback ports. Route publication/movement and source-write fencing are separate authorized operations. Inspect and wait with the retained release ID after a lost reply.

## Interrupted operations and limits

The admission flock serializes head changes. A separate worker flock permits one managed deployment worker per VM while status and admissions remain available. It writes `preparing` before builds/pulls and `applying` before changing containers. The systemd timer handles a lost wakeup and queued releases after restart. It marks previously active work `interrupted`; it does not automatically repeat an uncertain build, hook or application start. The agent must inspect containers and explicitly choose a new apply or recovery release. Existing containers continue according to their Docker restart policy.

Current fixed guest limits are 32 apps, 128 retained releases/app, 32 services/release and at least 512 MiB free disk before admission. Docker build and application storage can exceed the uploaded source size; image/volume retention and broader resource management remain separate work. The worker has a 30-minute unit deadline, bounded Docker command time/output and no customer output in service logs. Guest records are customer diagnostics; a root-capable customer can change them, so the control plane never uses them as billing or authorization evidence.

## Verification

`pnpm smoke:compose` exercises the actual delegated CLI, access API, Graphile issuer, gateway, native Ubuntu SSH/systemd, Docker, Caddy and PostgreSQL. It uploads source, disconnects, verifies HTTPS with the fixture Caddy CA, reads health/logs, updates persisted data, admits an unhealthy release and recovers a prior successful release. It creates no provider resources. A successful smoke removes its exact owned VM and fixture services/database; failures preserve `.local/guest-image-machine.json` for inspection.

Focused tests in `tests/compose-deployment.test.ts` cover lost wakeups, idempotency conflicts, competing updates, interrupted work, retained configuration integrity, image pinning, anonymous storage rejection, source path/type checks, nested directory durability and case-sensitive service build tags. Current verification status and evidence belong in `docs/CONTEXT.md`.

Docker references: [Compose up](https://docs.docker.com/reference/cli/docker/compose/up/), [configuration rendering](https://docs.docker.com/reference/cli/docker/compose/config/) and [container status](https://docs.docker.com/reference/cli/docker/compose/ps/).

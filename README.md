# Agent-cloud

An open-source cloud that customers operate through their existing coding agents. The product supplies machines, credentials, lifecycle operations, and eventually application deployment and recovery. It does not contain an AI agent.

**Current status:** the internal reference application passed the complete CLI/API path on a cheap Hetzner VM: frontend/backend/PostgreSQL, public HTTPS, disconnect/reconnect, logs, an update preserving data, and verified infrastructure cleanup. See [the verification record](docs/reference-deployment-verification.json). Customer authentication/access, general deployments, domains and protected backup/recovery remain unfinished. Stripe is excluded. See [the current handoff](docs/CONTEXT.md) and [internal reference commands](docs/architecture/internal-reference.md).

Project-scoped delegation is available with `acld grant create`, `grant list` and `grant revoke`. Issued secrets are saved to an owner-only file; see [the agent instructions](skills/agent-cloud/SKILL.md#delegate-access). Browser/device sign-in and customer SSH are still in progress.

## Run locally

Requires Node.js 24+, Docker, and pnpm 12.3.4. If your global pnpm is older, run commands through `npm exec --yes --package=pnpm@12.3.4 -- pnpm ...`.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm db:up
pnpm db:migrate
pnpm dev:bootstrap
```

Bootstrap writes `.local/admin.credentials.json` with owner-only permissions and prints its path and project ID. It stores only a token hash in PostgreSQL. Rerunning bootstrap preserves the account and credential. The initial credential expires after 30 days.

Start the API and worker in separate terminals:

```sh
pnpm dev
pnpm worker
```

The API listens on `127.0.0.1:4319`. PostgreSQL uses `127.0.0.1:55439`. The development stack has its own Docker Compose project and volume.

```sh
pnpm acld whoami
pnpm acld project list
pnpm acld catalog
pnpm acld machine create example --project <project-id> --key <stable-request-key>
pnpm acld operation wait <operation-id>
pnpm acld machine inspect <machine-id>
```

Use IDs returned by bootstrap or the CLI. Retain each request key when retrying; keys need at least 12 characters. CLI results are JSON; errors go to stderr.

To destroy a machine and its disk after authorizing data loss:

```sh
pnpm acld machine destroy <machine-id> --expected-version <version> --allow-data-loss --key <another-stable-key>
pnpm acld operation wait <operation-id>
pnpm acld usage
```

The same destroy command accepts blocked provisioning and retained failed allocations. Cancelling an active create returns its original operation; `cancelled` means cleanup finished. A terminal failed create keeps its result while a new destroy operation handles cleanup. Unknown provider submissions and exhausted deletion retries remain blocked with reservations retained. See [machine cleanup](docs/architecture/machine-cleanup.md).

`power-off`, `power-on`, `reboot`, and `resize` use the same version/key flags. Resize requires an off machine and does not shrink disks. `operation wait` exits 0 for success, 1 for failure, and 2 when blocked.

## Verify

```sh
pnpm check
pnpm format:check
pnpm db:check
# With the API and worker running:
pnpm smoke:local
```

Integration tests create a uniquely named temporary database on the development PostgreSQL instance, apply real migrations, and remove that database afterward. Set `TEST_DATABASE_URL` to use another dedicated PostgreSQL server whose role can create databases. Tests do not truncate the database named in that URL. No cloud credentials are used.

The smoke test invokes the actual CLI against the HTTP server and Graphile worker. It requires the simulated provider and deletes the machine it creates. Tests cover quota races, tenant isolation, revoked grants, lost responses, delayed inventory, duplicate resources, worker crashes, and cleanup after a failed provider action.

For real local certificate and SSH checks, install the pinned Smallstep CLI and initialize a dedicated development CA:

```sh
pnpm setup:step
pnpm setup:pki
pnpm pki:up
pnpm smoke:cleanup
pnpm smoke:pki
pnpm smoke:ssh
pnpm smoke:customer-pki
pnpm smoke:enrollment
pnpm pki:down
```

The CA listens only on `127.0.0.1:9449`. Its state lives in ignored, owner-only `.local/pki`; repeated setup preserves its identity and updates the managed certificate templates. `pnpm pki:up` recreates the CA container to load its current configuration, including after a lost setup response. Setup omits the vendor access logger because it includes signing tokens. The encrypted root key stays outside the container mount. The control signer receives a provisioner credential and public trust, never the CA's private signing keys. These are development keys, not a production recovery setup.

The cleanup smoke runs the actual CLI against a local HTTP API, PostgreSQL and Graphile worker. It prepares a simulated lost create response, admits destroy while blocked, releases delayed inventory and verifies one source create plus complete VM/IP cleanup. Its database and credentials are disposable; it makes no cloud call.

The PKI smoke makes an actual TLS connection and checks allocation/hostname rejection. The SSH smoke starts one disposable local OpenSSH container and checks pinned host keys, CA trust, allocation-scoped user certificates and guest evidence. It removes the container and generated keys afterward. It does not boot a guest VM or deploy an application. The enrollment smoke composes admission, the provider journal, encrypted bootstrap, HTTP enrollment, real Smallstep and OpenSSH. It verifies the issued host certificate over SSH and TLS certificate over HTTPS, replay and wrong-key rejection. Its provider observations are local fixtures, so it still does not prove a cloud VM boot. CI runs these local smokes without cloud credentials.

The customer PKI smoke creates a separate temporary CA and OpenSSH container. It checks signed key binding, exact certificate permissions, native command/PTY authentication and rejected keys, sources, principals and signatures. A local TLS proxy drops a real signing response and checks that transport failures never trigger another POST. All fixture keys and containers are removed. This verifies the certificate protocol; customer API admission, gateway access and CLI integration remain in progress.

For an actual local Ubuntu first-boot check on macOS with OrbStack installed, keep the development PostgreSQL and CA services running:

```sh
pnpm build:guest
pnpm smoke:guest
pnpm smoke:reference
pnpm smoke:image
pnpm smoke:builder
```

The image build stages checksum-verified public inputs in `.local/guest-builds/<manifest-digest>`. `.local/guest-build.json` selects the latest build; each smoke captures and verifies its selection once. The VM smoke records one owned local machine in `.local/guest-image-machine.json` and deletes it after successful enrollment, secret scanning and reboot checks. It also verifies restricted runtime inspection and keeps creation pending with stopped Docker, a stopped proxy or insufficient disk space. Reboot completion requires a changed Linux boot ID. A failure preserves that machine for inspection. Read its recorded name, inspect it with `orb info`, then delete exactly that VM with `orb delete --force <recorded-name>` and remove the record before starting fresh. No Hetzner resource is created. See [guest image architecture](docs/architecture/guest-image.md) and [runtime readiness](docs/architecture/guest-runtime.md) for proof boundaries and unfinished activation/renewal work.

The image smoke sanitizes a separate disposable builder, checks refusal of allocation and Docker data, and boots two clones through the guest checks. It compares their machine IDs and SSH/TLS public keys. Builder ownership is in `.local/guest-image-builder.json`; a temporary refusal clone uses `.local/guest-image-refusal.json`. Failures preserve these records for the same targeted inspection and deletion procedure. Run VM smokes sequentially, and leave their selected input directories unchanged until they finish. The [sanitation design](docs/architecture/image-sanitation.md) describes retry limits and the separate Hetzner snapshot proof.

The builder smoke installs through the actual pinned SSH and SFTP transport. It checks rejection of changed uploaded code, concurrent installation requests, receipt recovery, removal of builder access and two fresh clone identities. It shares the builder/guest ownership records above and keeps private fixture access under `.local/image-builder-access/<builderId>`. On failure, remove that exact access directory only after deleting the recorded VMs. Both boot fixtures validate cloud-init's schema; local network and disk settings do not test Hetzner behavior. The builder smoke now continues through signed publication after deleting its actual temporary VMs, verifies the retained protocol snapshot, then cancels and cleans that snapshot too. It creates no paid resource.

## Guest certificate renewal

The guest library and configured `/guest/renew` endpoint renew SSH/TLS certificates while preserving the original VM keys. Signed requests, current provider ownership and pinned SSH proof authorize new issuance. Durable attempt limits survive restarts; a lost response reuses the saved result. A systemd timer retries certificate installation and reload without changing proxy routes. Operators with authorized root access can run `guestctl renew --json` after an outage. See [renewal and recovery](docs/architecture/guest-renewal.md).

The native enrollment smoke covers renewal with actual Smallstep, SSH and TLS. It advances issuance metadata only inside an isolated fixture to avoid a thirty-minute wait. The local Ubuntu smoke separately exercises the installed timer and real service reload. These checks do not enable customer Hetzner mode or prove renewal on a deployed customer VM.

## Operator recovery

For admitted customer cleanup that remains blocked, operators can inspect its retained evidence:

```sh
pnpm machine:recover inspect <cleanup-operation-id>
pnpm machine:recover apply <private-request.json>
```

The request file must be owner-only and at most 16 KiB. Inspection needs database access. Applying a recovery decision also checks the allocation's provider, without loading images, prices or signing keys. `close_create` records an explicit operator attestation of provider request completion and all resource IDs. `retry_delete` permits one further exact-target attempt after exhaustion. Existing customer destroy authority and worker cleanup remain required. See [operator recovery](docs/architecture/operator-recovery.md) for the request format and evidence requirements.

## Operator image builds

After `pnpm db:migrate`, operators can inspect and cancel a recorded image build without provider credentials:

```sh
pnpm image:build inspect <build-id>
pnpm image:build cancel <build-id>
# Queue explicit advancement for a configured image worker:
pnpm image:build start <build-id>
```

`pnpm image:build prepare <config.json>` verifies public image inputs and generates independent management and host SSH keys. The input supplies a stable build UUID, input directory/digest, pinned base-image ID, exact offer mapping, management IPv4 address, gross spending caps and deadline. Its schema is in `scripts/image-build.ts`. The JSON result is the complete public configuration for admission. Private keys stay in owner-only `.local/image-access/<buildId>`, configurable with `IMAGE_ACCESS_DIRECTORY`; preserve that directory for retries and recovery. Preparation needs neither a database nor a provider token.

`pnpm image:build admit <prepared-config.json>` checks the matching local key store, reads Hetzner pricing and reserves an operator allowance without creating resources. Reusing the same configuration returns its recorded admission; changed intent needs a new build ID. `start` records an immutable run request. Admission alone queues only deadline cleanup and cannot start a machine. `cancel` queues a full abort request; it does not claim cloud deletion or local key erasure has run.

The controller persists builder phases, stops and snapshots only after saved sanitation evidence, boots a verifier, removes temporary resources and signs a retained release. The configured Hetzner image factory connects these ports to the API and Graphile worker. Initialize its persistent keys with `pnpm setup:runtime <absolute-identity-directory>` and supply the strict runtime JSON described in [operator runtime](docs/architecture/operator-runtime.md). Public key policy reloads on every authorization. Customer endpoints and operations remain disabled in this mode. `start` can incur charges once the worker is running; use a reachable HTTPS enrollment origin, current inventory and explicit cheap caps before starting a build.

`pnpm image:build cleanup <build-id>` runs one exact-build cleanup pass without runtime signing keys, PKI, source inputs or pricing. Repeat until inspection confirms provider absence and local access removal, or leave the configured worker to reconcile. See [image publication](docs/architecture/image-release.md) for uncertain creates, retained storage and customer allocation pins. The actual Hetzner builder/snapshot/verifier drill passed, including signed selection and full cleanup. Its historical release is audit evidence; the snapshot was deleted.

## What is enforced

- Tenant keys and composite foreign keys keep records within their account and project.
- A transaction admits the request, reserves quota, persists its operation and idempotency key, and enqueues the job.
- Every provider mutation has a durable attempt before submission. Unknown outcomes retain their reservation and are reconciled before another create.
- Account and global admission limits cover active allocations and pending reservations. Powering off does not release a reservation.
- Delegated credentials cannot increase capabilities, project scope, spending limits, or lifetime. Revoking a parent invalidates its descendants.
- Grants are checked again before a fresh effect. Reconciliation continues after revocation to avoid orphaning submitted work.

Catalog entries specify the provider type, region, architecture, availability, and currency. Reservations include the VM and IPv4. `PROVIDER_CURRENCY` and `MAX_PROVIDER_HOURLY` define the deployment ceiling; use the currency returned by your provider account. There is no currency conversion. The simulator uses synthetic prices. An hourly reservation is not an invoice or a hard monthly cap; traffic and future ancillary services need separate limits before activation.

Hetzner catalog reads have been verified against a real account. The API refreshes catalog snapshots outside request transactions. Operator image jobs require explicit configuration and start; live customer admission remains disabled. The first bounded CPX12 image drill reached a snapshot and verifier, exposed a disk-durability failure, and was fully cleaned up. The correction passed local tests, native clone checks and a fresh Hetzner lifecycle through signed publication and selection. Both attempts were fully cleaned up; independent inventory confirmed zero resources. See the [failed drill](docs/research/m1-hetzner-image-drill.json) and [successful drill](docs/research/m1-hetzner-durability-drill.json). Customer deployment, renewal and recovery remain unfinished.

## Prepare Hetzner credentials

Create a dedicated project and a read/write token through the Hetzner console. `pnpm setup:hetzner` starts a one-use loopback form for saving that token into ignored `.local/hcloud-token`, mode 0600. Open the returned URL and paste the token there. The listener expires after ten minutes and refuses to overwrite an existing credential. Never put the token in command arguments or a guest.

The following command reads account pricing, capacity, Ubuntu 24.04 base-image metadata and counts of servers, IPs, snapshots, firewalls and SSH keys without creating resources:

```sh
PROVIDER_CURRENCY=USD pnpm hetzner:check
```

Use your account currency. The operator can explicitly map `HCLOUD_SERVER_TYPE_SMALL`, `HCLOUD_SERVER_TYPE_MEDIUM`, and `HCLOUD_SERVER_TYPE_LARGE`; defaults are CX23/CX33/CX43. Unavailable configured types do not trigger automatic substitution. `HCLOUD_ARCHITECTURE` defaults to `x86` and excludes incompatible offers. The read-only check is also useful before choosing a bounded development VM.

Stop the API and worker while applying migrations from an earlier checkpoint, then rebuild and restart both. The migration retains historical EUR denominations, credential limits, and the original provider type mapping and aggregate estimates. Migrated offers are marked `legacy_estimate`; their reconstructed VM/IP split is synthetic. Migration 0005 also upgrades server-only receipts and preserves legacy simulator allocations without inventing owned IPs. New allocations track the VM and IPv4 separately and release their reservation only after both are absent. The obsolete `MAX_PROVIDER_HOURLY_EUR` variable fails with a migration message instead of silently changing its meaning.

## Repository

| Path                     | Responsibility                                                        |
| ------------------------ | --------------------------------------------------------------------- |
| `packages/contracts`     | Public schemas, IDs, lifecycle states, provider contract              |
| `packages/db`            | Drizzle schema, migrations, connections, job insertion                |
| `packages/hetzner`       | Hetzner customer and image transport                                  |
| `packages/pki`           | Smallstep signing and certificate identity checks                     |
| `packages/guestctl`      | TypeScript guest first boot, certificate installation and identity    |
| `images`                 | Public image inputs, pinned artifacts and Linux service configuration |
| `packages/remote`        | Native SSH identity proof using explicit credentials                  |
| `packages/sdk`           | Typed HTTP client and operation waiting                               |
| `apps/control`           | Auth, admission, API, simulator, worker, bootstrap                    |
| `apps/cli`               | JSON CLI and local credential storage                                 |
| `tests`                  | Isolated PostgreSQL integration tests                                 |
| `scripts/smoke-local.ts` | CLI-to-worker verification and cleanup                                |
| `skills/agent-cloud`     | Customer agent instructions matching implemented commands             |
| `docs`                   | Architecture, progress, decisions, research, and handoff context      |

Read [AGENTS.md](AGENTS.md) before contributing and [docs/CONTEXT.md](docs/CONTEXT.md) for verification status. The [original plan](docs/archive/original-plan.md) is historical context. Code is licensed under [Apache 2.0](LICENSE).

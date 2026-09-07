# Agent-cloud

An open-source cloud that customers operate through their existing coding agents. The product supplies machines, credentials, lifecycle operations, and eventually application deployment and recovery. It does not contain an AI agent.

**Current status:** the local control plane works with a persistent simulated provider. The CLI, HTTP API, PostgreSQL, and background worker have been exercised together through creation and deletion. Live Hetzner activation, guest access, application deployment, routes, and backups are still in progress. Stripe is deferred.

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

`power-off`, `power-on`, `reboot`, and `resize` use the same version/key flags. Resize requires an off machine and does not shrink disks. `operation wait` exits 0 for success, 1 for failure, and 2 when blocked.

## Verify

```sh
pnpm check
pnpm format:check
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
pnpm smoke:pki
pnpm smoke:ssh
pnpm smoke:enrollment
pnpm pki:down
```

The CA listens only on `127.0.0.1:9449`. Its state lives in ignored, owner-only `.local/pki`; repeated setup preserves its identity and updates the managed certificate templates. When setup returns `restartRequired: true`, run `pnpm pki:down` followed by `pnpm pki:up` to load them. The encrypted root key stays outside the container mount. The control signer receives a provisioner credential and public trust, never the CA's private signing keys. These are development keys, not a production recovery setup.

The PKI smoke makes an actual TLS connection and checks allocation/hostname rejection. The SSH smoke starts one disposable local OpenSSH container and checks pinned host keys, CA trust, allocation-scoped user certificates and guest evidence. It removes the container and generated keys afterward. It does not boot a guest VM or deploy an application. The enrollment smoke composes admission, the provider journal, encrypted bootstrap, HTTP enrollment, real Smallstep and OpenSSH. It verifies the issued host certificate over SSH and TLS certificate over HTTPS, replay and wrong-key rejection. Its provider observations are local fixtures, so it still does not prove a cloud VM boot. CI runs all three smokes without cloud credentials.

For an actual local Ubuntu first-boot check on macOS with OrbStack installed, keep the development PostgreSQL and CA services running:

```sh
pnpm build:guest
pnpm smoke:guest
```

The image build stages checksum-verified public inputs in `.local/guest-build`. The VM smoke records one owned local machine in `.local/guest-image-machine.json` and deletes it after successful enrollment, secret scanning and reboot checks. It also verifies restricted runtime inspection and keeps creation pending with stopped Docker, a stopped proxy or insufficient disk space. Reboot completion requires a changed Linux boot ID. A failure preserves that machine for inspection. Read its recorded name, inspect it with `orb info`, then delete exactly that VM with `orb delete --force <recorded-name>` and remove the record before starting fresh. No Hetzner resource is created. See [guest image architecture](docs/architecture/guest-image.md) and [runtime readiness](docs/architecture/guest-runtime.md) for proof boundaries and unfinished activation/renewal work.

## What is enforced

- Tenant keys and composite foreign keys keep records within their account and project.
- A transaction admits the request, reserves quota, persists its operation and idempotency key, and enqueues the job.
- Every provider mutation has a durable attempt before submission. Unknown outcomes retain their reservation and are reconciled before another create.
- Account and global admission limits cover active allocations and pending reservations. Powering off does not release a reservation.
- Delegated credentials cannot increase capabilities, project scope, spending limits, or lifetime. Revoking a parent invalidates its descendants.
- Grants are checked again before a fresh effect. Reconciliation continues after revocation to avoid orphaning submitted work.

Catalog entries specify the provider type, region, architecture, availability, and currency. Reservations include the VM and IPv4. `PROVIDER_CURRENCY` and `MAX_PROVIDER_HOURLY` define the deployment ceiling; use the currency returned by your provider account. There is no currency conversion. The simulator uses synthetic prices. An hourly reservation is not an invoice or a hard monthly cap; traffic and future ancillary services need separate limits before activation.

Hetzner catalog reads have been verified against a real account. The API now refreshes catalog snapshots outside request transactions. Live mutation remains disabled until guest verification, operator recovery, and spending/cleanup checks are connected. No VM has been rented.

## Prepare Hetzner credentials

Create a dedicated project and a read/write token through the Hetzner console. `pnpm setup:hetzner` starts a one-use loopback form for saving that token into ignored `.local/hcloud-token`, mode 0600. Open the returned URL and paste the token there. The listener expires after ten minutes and refuses to overwrite an existing credential. Never put the token in command arguments or a guest.

The following command reads account pricing, capacity, and resource counts without creating resources:

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
| `packages/hetzner`       | Hetzner transport; live activation remains gated                      |
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

Read [AGENTS.md](AGENTS.md) before contributing and [docs/PROGRESS.md](docs/PROGRESS.md) for verification status. The [original plan](docs/archive/original-plan.md) is historical context. Code is licensed under [Apache 2.0](LICENSE).

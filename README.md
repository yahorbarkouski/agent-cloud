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

## What is enforced

- Tenant keys and composite foreign keys keep records within their account and project.
- A transaction admits the request, reserves quota, persists its operation and idempotency key, and enqueues the job.
- Every provider mutation has a durable attempt before submission. Unknown outcomes retain their reservation and are reconciled before another create.
- Account and global admission limits cover active allocations and pending reservations. Powering off does not release a reservation.
- Delegated credentials cannot increase capabilities, project scope, spending limits, or lifetime. Revoking a parent invalidates its descendants.
- Grants are checked again before a fresh effect. Reconciliation continues after revocation to avoid orphaning submitted work.

Provider prices currently shown are estimates, not a complete invoice or a hard monthly spending cap. Live activation is disabled until current pricing, guest verification, and complete provider-resource cleanup are connected. The implemented Hetzner transport has not been verified against a real account.

## Repository

| Path                     | Responsibility                                                   |
| ------------------------ | ---------------------------------------------------------------- |
| `packages/contracts`     | Public schemas, IDs, lifecycle states, provider contract         |
| `packages/db`            | Drizzle schema, migrations, connections, job insertion           |
| `packages/hetzner`       | Hetzner transport; live activation remains gated                 |
| `packages/sdk`           | Typed HTTP client and operation waiting                          |
| `apps/control`           | Auth, admission, API, simulator, worker, bootstrap               |
| `apps/cli`               | JSON CLI and local credential storage                            |
| `tests`                  | Isolated PostgreSQL integration tests                            |
| `scripts/smoke-local.ts` | CLI-to-worker verification and cleanup                           |
| `skills/agent-cloud`     | Customer agent instructions matching implemented commands        |
| `docs`                   | Architecture, progress, decisions, research, and handoff context |

Read [AGENTS.md](AGENTS.md) before contributing and [docs/PROGRESS.md](docs/PROGRESS.md) for verification status. The [original plan](docs/archive/original-plan.md) is historical context. Code is licensed under [Apache 2.0](LICENSE).

# PostgreSQL and Umami recipes

These deployment contexts use the ordinary customer `acld compose apply` path. PostgreSQL stores its data in a named volume on a private bridge. Umami adds a frontend on `127.0.0.1:3000`, ready for an authenticated cloud HTTPS route. They contain no provider credentials, public database port, external volume, or mutable image tag without a digest.

The maintained pins are PostgreSQL **17.11 / Alpine 3.24** and Umami **3.3.1**. Their exact multiarch image digests are in [the PostgreSQL recipe](../packages/recipes/assets/postgres/compose.yaml) and [the Umami recipe](../packages/recipes/assets/umami/compose.yaml). Both support Linux AMD64 and ARM64. Umami uses PostgreSQL 17 so its database fits the implemented protected-backup recipe.

## Prepare a private context

Use the installed CLI with Node 24 or newer; a source checkout is not needed. Choose a new destination outside version-controlled source; `.local` is ignored here.

```sh
acld recipe list
acld recipe inspect umami --version 1.0.0
acld recipe prepare postgres --version 1.0.0 --output .local/recipes/postgres
acld recipe prepare umami --version 1.0.0 --output .local/recipes/umami
```

`recipe list` and `recipe inspect` read versions bundled with the installed CLI and work offline. Preparation never downloads code or starts services. The authenticated API exposes the same server-bundled catalog at `GET /v1/recipes` and `GET /v1/recipes/:id?version=1.0.0`; the SDK has `recipes()` and `recipe(id, version)`. A server and CLI on different releases may have different catalogs. Select an available explicit version rather than assuming the latest. The catalog reports image digests, resource limits, secret paths and the actual backup scope.

The helper creates a 0700 directory, independent random database passwords, a saved initial `release-id`, and 0600 secret files. Umami also receives independent application-signing, two-factor-encryption, and initial administrator secrets. It prints the context path, selected version and saved release UUID, never credentials. `recipe.json` records the selection inside the context. An existing destination is refused, preserving its secrets and release identity. A failed partial preparation is also left for inspection; do not overwrite a context already submitted as a release. `--port 3001` selects another Umami loopback port when a machine already uses 3000.

Keep the entire generated context private. `acld compose apply` includes every regular file inside it, including application secrets; upload no unrelated files. The guest retains these files beneath its root-protected Compose directory. The bootstrap code is non-secret and readable by Umami's UID 1001. Docker reads the private Umami `env_file` and injects the environment, so that user does not need to read a root-owned 0600 secret bind. PostgreSQL's initial root entrypoint reads its password through `POSTGRES_PASSWORD_FILE` before dropping privileges.

Validate without printing expanded secrets:

```sh
docker compose --file .local/recipes/postgres/compose.yaml config --quiet
docker compose --file .local/recipes/umami/compose.yaml config --quiet
```

Avoid plain `docker compose config`, full container inspection, or environment dumps in agent transcripts: normalized configuration contains connection credentials. Retrieve a needed secret privately into a password manager or an authenticated request's memory, never a command argument or log.

## Deploy PostgreSQL 17

Use the saved UUID from `.local/recipes/postgres/release-id` as `<release-uuid>`:

```sh
acld compose apply <machine> postgres --source .local/recipes/postgres --release <release-uuid>
acld compose wait <machine> postgres
acld compose inspect <machine> postgres
```

The `database` service initializes database `app` and cluster administrator `app`. Its password is in `secrets/database-password`. The administrative role is intended for this owned database; create restricted application roles when sharing it with application code. No port is published. Add a customer's application service to this same Compose context and its `private` network to connect to `database:5432`; give only the frontend a loopback port and an ordinary edge network. Separate Compose apps do not share this private network automatically.

PostgreSQL has a 384 MiB memory limit, half a CPU, 50 connections, 128 MiB shared buffers, a health check and bounded local logs. Leave memory for the guest and other services; tune limits for measured workload. The volume remains attached across releases and container recreation. Initialization variables apply to a new volume: changing the password file alone does not change an existing database role's password.

Verify a query through customer SSH or a durable command, using the container returned by `compose inspect`:

```sh
acld ssh <machine> -- sudo docker exec <database-container-id> \
  psql -X -v ON_ERROR_STOP=1 -U app -d app -c 'select current_database(), version();'
```

## Deploy Umami and secure administration

Use the UUID from `.local/recipes/umami/release-id`:

```sh
acld compose apply <machine> umami --source .local/recipes/umami \
  --release <release-uuid> --wait-seconds 300
acld compose wait <machine> umami
acld compose inspect <machine> umami
```

Before the HTTP server starts, [the bootstrap](../packages/recipes/assets/umami/bootstrap.mjs) runs the pinned upstream database migrations and tracker configuration. PostgreSQL's bundled `pgcrypto` then replaces any administrator still using Umami's upstream default password with the generated 64-character password. An administrator already using another password is preserved, including after restoration. Failure stops startup before HTTP binds. This behavior is tied to Umami 3.3.1's user schema and must be reverified when upgrading. The recipe does not install packages at runtime.

The initial username is `admin`; its generated password is `RECIPE_ADMIN_PASSWORD` in the private `secrets/umami.env`. Once the application is healthy, publish its loopback port:

```sh
acld route publish <machine> --port 3000 --name analytics --key <saved-route-command-uuid>
```

Use the hostname in the route response. The operator must have configured managed HTTPS routing; publishing does not provision a gateway. Before collecting visitors, verify that the default password is rejected, sign in with the generated password, store a new administrator password in a password manager, and enable two-factor authentication. The generated environment retains only the original setup password; later starts do not use it to reset a changed account. Keep `TWO_FACTOR_ENCRYPTION_KEY` when upgrading or restoring so enrolled factors remain decryptable.

Umami has a 768 MiB memory limit, one CPU, a health check, bounded logs, and no Linux capabilities. Only Umami joins the edge bridge; the database remains on the internal bridge. Telemetry, automatic update checks and optional external Umami calls are disabled. This does not provide a network egress firewall: the frontend still has an ordinary bridge for loopback publication and product routing.

## Instrument the actual customer site

An analytics installation is complete only after a visitor and an intended event reach its database.

1. Sign in to Umami, open **Settings → Websites**, and add the actual site name and domain. Retain its website UUID. Agents using the API can supply a saved UUID to `POST /api/websites`; after an uncertain create, inspect that UUID instead of creating a duplicate.
2. Put the tracking snippet into the customer's deployed site's `<head>`, using the public HTTPS analytics hostname and this website UUID. Deploy the changed site through its usual release flow.

   ```html
   <script
     defer
     src="https://<analytics-hostname>/script.js"
     data-website-id="<website-uuid>"
   ></script>
   ```

3. Instrument one meaningful action without personal data, passwords or tokens. For example, add `data-umami-event="signup-click"` to the site's real signup button. A programmatic equivalent is `window.umami.track('signup-click')` after the tracker loads. Add the analytics origin to both `script-src` and `connect-src` if the site has a Content Security Policy. Framework applications should follow the upstream framework integration instructions rather than injecting duplicate trackers.
4. Visit the actual customer URL in a fresh browser session with tracking blockers disabled for this deliberate test. In developer tools, confirm `/script.js` loads and `/api/send` succeeds. Click the instrumented button once. A successful HTTP response alone is insufficient: bot filtering can acknowledge an event without recording it.
5. In that website's Umami overview, select a time range containing the visit and verify a pageview, a visitor, and the correct page path. In **Events**, verify `signup-click` increased by one. Record the site URL, website UUID, test time, counts and release UUID; omit authentication tokens and visitor details. The collection endpoint must never receive the administrator password or an API token.

For agent-driven readback, authenticate through `POST /api/auth/login`, keep the returned bearer token only in memory, then query `GET /api/websites/<website-uuid>/stats?startAt=<epoch-ms>&endAt=<epoch-ms>` and the website's events endpoint. Preserve the observed website binding and time range. Synthetic `/api/send` checks verify the collector; they do not prove that the customer's deployed HTML or button is instrumented. Repeat the browser visit after each tracking or routing change.

## Register a protected capture and verify a restore

Capture requires the exact current successful Compose release and a credential with backup permissions. Both recipes use service `database`; PostgreSQL uses database/user `app`, while Umami uses database/user `umami`.

```sh
acld backup capture <machine> postgres --id <saved-backup-uuid> --release <successful-release-uuid> \
  --service database --database app --user app
acld backup capture <machine> umami --id <saved-backup-uuid> --release <successful-release-uuid> \
  --service database --database umami --user umami
acld backup wait <saved-backup-uuid>
acld backup inspect <saved-backup-uuid>

acld backup restore <saved-backup-uuid> restored-analytics --id <saved-restore-uuid> \
  --name restored-analytics --size small --region nbg1
acld backup restore-wait <saved-restore-uuid>
acld backup restore-inspect <saved-restore-uuid>
```

Choose a distinct saved UUID for each intended capture or restore. Reuse the same UUID and identical input after a lost reply. These commands request manual captures. For daily capture, use `backup schedule` with the same PostgreSQL flags and a schedule UUID, then inspect `backup schedule-inspect <schedule-uuid>`. The admitting grant must stay valid. After updating the application, disable its old schedule and create a new one pinned to the successful release; see [daily capture](architecture/protected-backups.md#daily-capture). The operator must configure protected backup storage and wrapping keys first.

The source bundle, normalized configuration and source-local secrets are captured automatically. Neither recipe needs `--files` for its own database. That option declares additional regular files beneath `/var/lib/agent-customer`; it does not name a Docker volume or a source-bundle file. The database dump covers the selected database, not every database or arbitrary application volume.

Restoration allocates a new machine and new named volumes, preserves the existing Umami administrator hash and application keys, and collapses both bridges into an internal default network. The original machine and route stay unchanged. Verify PostgreSQL queries and Umami website/event counts on the isolated target before considering network promotion and route movement. See [protected backups](architecture/protected-backups.md) and [Compose promotion](architecture/compose-deployment.md#promote-a-verified-restore) for the supported recovery sequence. These recipes' normalized configurations are checked by the actual `isolatedBackupConfig` implementation; that check is not a separate proof of encrypted storage or native VM restoration.

## Upgrade and detect drift

Keep the private context and its secrets. For a new release, copy it to a new private context, retain all passwords and keys, and save a fresh release UUID before editing. Update image digests deliberately from the official registries, verify their matching upstream release and architecture manifests, and inspect the pinned Umami startup script and user schema. Never substitute `latest` without its digest or regenerate a deployed context's secrets.

Before applying an upgrade, capture a protected backup, perform an isolated restore, and check actual application data. Validate the new Compose config, run the local recipe smoke, then apply with `--release <new-uuid> --expected-release <current-uuid>`. Inspect a conflict or an uncertain response using the saved IDs. Compare `compose inspect`'s successful release, image IDs, configuration digest and container health against the intended release; directly changed Docker containers or files need investigation before another apply.

PostgreSQL minor updates remain on major 17 and the existing named volume. Changing to PostgreSQL 18 or another major requires a separate migration into a new volume; it is outside this maintained backup recipe. Umami starts with upstream schema migrations. Recovering an older Compose release changes code and configuration but does not undo SQL migrations. Use the verified isolated database restore when data must be recovered, and fence source writes before any eventual public cutover.

## Local verification and upstream references

Run `pnpm build` then `node --import tsx recipes/smoke.mjs` from the installed workspace with Docker. It pulls missing pinned images with bounded timeouts, validates generated Compose and isolated-restore configuration, checks owner-only secrets, SQL persistence, default-login rejection, administrator-password preservation, and collector readback. The smoke builds a production-only CLI in a temporary workspace, then runs it from outside the repository without credentials. Packaging is isolated because `pnpm deploy --prod` may prune its source workspace. Full UUID project names and an absence check precede Docker mutations; cleanup touches only the admitted project’s containers, networks and volumes; temporary contexts are removed in `finally`. It prints IDs and verification facts, never credentials. This fixture uses a local collector and does not claim customer-site instrumentation, provider storage enforcement, public ACME, or native VM verification.

For the full native customer-site check, use the existing local CA, guest build tools, OrbStack and installed Google Chrome on the development Mac:

```sh
pnpm build:guest
AGENT_CLOUD_ACCESS_SCENARIO=1 AGENT_CLOUD_HOSTING_SCENARIO=1 AGENT_CLOUD_ANALYTICS_SCENARIO=1 \
  node node_modules/tsx/dist/cli.mjs scripts/smoke-guest.ts
```

This scenario deploys the reference frontend/backend/PostgreSQL and the generated Umami context through the customer CLI, publishes both through the local HTTPS gateway, and updates the actual frontend to load the tracking script and tag its visit button. A fresh headless Chrome context visits the site and clicks once. It requires the application's persisted count to change, both tracker requests to succeed, and authenticated Umami API readback to show a pageview, visitor and one `record-visit` event. The fixture never sends collector events itself. Its deliberate browser visitor uses the installed browser version with the headless-only user-agent marker removed so analytics bot filtering does not discard the test.

The fresh browser context accepts the local test certificates and restricts network requests to the two local origins. API readback verifies that CA normally. This does not test public ACME or change Chrome's normal profile/certificate settings. The reference backend's allowed origin includes the gateway's temporary port; browser mutations must exercise the same origin checks as the application. The scenario removes both routes and its exact owned VM on success; a failure retains the VM receipt for targeted inspection and cleanup.

Native customer-site verification passed on2026-09-08 with Chrome152.0.7977.76: the actual frontend button changed PostgreSQL count1→2, and Umami API readback showed one pageview, visitor and `record-visit` event. Both routes and the exact owned Ubuntu VM were cleaned. Evidence: `.local/analytics-native-4.log`. Public ACME and final customer Hetzner deployment remain separate checks.

Local verification passed with Compose 2.39.2 and Linux ARM64 containers: PostgreSQL 17.11 retained SQL data after recreation; Umami rejected the default login, recorded one pageview/visitor/custom event, preserved an operator-changed password, and accepted that password after starting the actual isolated backup configuration. A preparation check under `umask 077` verified readable non-secret bootstrap code and unchanged secrets/release identity on a refused repeat.

Primary references: [PostgreSQL image initialization and secrets](https://github.com/docker-library/docs/blob/master/postgres/README.md), [PostgreSQL 17 password hashing](https://www.postgresql.org/docs/17/pgcrypto.html), [Umami 3.3.1](https://github.com/umami-software/umami/releases/tag/v3.3.1), [pinned startup sequence](https://github.com/umami-software/umami/blob/v3.3.1/scripts/start-docker.sh), [pinned user schema](https://github.com/umami-software/umami/blob/v3.3.1/prisma/schema.prisma), [tracking installation](https://docs.umami.is/docs/collect-data), [custom events](https://docs.umami.is/docs/track-events), [event readback](https://docs.umami.is/docs/api/events), [authentication](https://docs.umami.is/docs/api/authentication), [websites API](https://docs.umami.is/docs/api/websites), and [upgrade guidance](https://docs.umami.is/docs/updates).

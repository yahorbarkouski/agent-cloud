# Internal reference application

This implements the original plan's internal-identity deployment checkpoint. It is available only when a customer-mode control process sets `INTERNAL_REFERENCE_GRANT` to an existing root grant. The endpoint is absent by default. Delegated grants are rejected even if configured by mistake. This is not public customer onboarding or general command access.

## Operator flow

Authenticate using the existing `acld login --server URL --token-stdin`, create a machine with `acld machine create`, and wait for its operation. The image must contain the reference guest command and separate `agent-deploy` SSH account. The internal firewall profile requires ports22,8443,80,443. The ordinary customer profile still requires only22 and8443.

```sh
acld internal reference apply MACHINE --release UUID --revision 1
acld internal reference inspect MACHINE
acld internal reference logs MACHINE
acld internal reference apply MACHINE --release NEW_UUID --revision 2 --expected-release UUID
```

Generate and retain a UUID before each new release. Reuse it with exactly the same request after a lost response. An older or mismatched expected release fails instead of overwriting current work. Inspect a failed deployment before submitting a new recovery release. Destroy uses the existing versioned machine command with explicit data-loss authorization.

The API checks the exact active root identity under the existing account and machine locks, authorizes deployment/publication, and observes current provider ownership and IP assignment. It signs a short-lived deployment credential and sends bounded JSON over host-CA-verified SSH. A separate account/principals file and forced command allow only `guestctl reference --json`; the probe account retains identity/inspection permissions.

The guest records the release on disk before requesting a systemd job. An enabled timer resumes pending/running work after reboot or a lost wakeup. Work uses an independent lock, validates Compose, builds the backend, and starts services with health checks. The application keeps running after SSH exits. An unsuccessful application deployment records `failed`; a subsequent explicit release can recover it.

## Application and cost

The fixed recipe has a static frontend/Caddy container, a TypeScript HTTP backend and PostgreSQL17. Container image digests are pinned. CPU, memory, process and log limits bound this small stack. PostgreSQL and Caddy use stable named volumes. The backend and database have no published ports and use an internal Docker network. A random database password stays in a root-only guest directory and reaches the backend through a read-only secret mount. Service logs contain events, not passwords or request data.

Public test hostnames embed the observed owned IPv4 address beneath sslip.io. Requests cannot select an arbitrary hostname or cause arbitrary certificate issuance. Caddy manages public HTTPS and persists certificates. This temporary internal domain has an external DNS dependency; customer domain ownership, route recovery and platform hostnames remain separate unfinished scope. See [sslip.io TLS](https://nip.io/#tls) and [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https).

This recipe does not yet promise zero-downtime updates, automatic rollback, protected backups, general source upload, arbitrary Compose or public customer access. PostgreSQL data survives container replacement; deleting the VM destroys its local volumes. Complete the protected-backup/isolated-restore scope before treating it as durable customer hosting.

## Verification

`pnpm smoke:reference` exercises the actual CLI, authenticated API, native SSH, systemd and Docker on one owned local Ubuntu VM. It verifies frontend/backend/PostgreSQL, trusted local HTTPS, disconnected CLI, fresh status/logs, release replay and an update preserving a database value. The fixture substitutes `reference.localhost` only at its injected remote boundary and checks Caddy's local CA. It does not establish Hetzner or public ACME proof. Successful completion removes the VM, temporary credentials and isolated database. A failed run retains the exact VM record at `.local/guest-image-machine.json` for targeted recovery.

Focused tests cover disabled/internal/delegated/revoked access, provider ownership changes, forbidden hostnames, lost start responses, immutable release identity, concurrent admission, failed deployment recovery and secret/volume continuity. Paid verification reuses the existing image/provider journals and recorded cheap caps; its current status and cleanup obligations belong in `docs/CONTEXT.md`.

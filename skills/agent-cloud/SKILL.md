---
name: agent-cloud
description: Operate agent-cloud machines through its JSON CLI, inspect durable operations, and recover interrupted requests within the customer's existing authorization.
---

# Agent-cloud

Use the installed `acld` CLI. In a source checkout, use `pnpm acld`. Run `acld --help` when unsure about available commands. The current release supports GitHub device sign-in, machine lifecycle, scoped delegation, SSH, single-file transfer, durable commands, Compose deployment/recovery, managed HTTPS routing and explicit PostgreSQL backup/isolated restore. Daily scheduling and operator-run retention/purge are available. Discover bundled PostgreSQL and Umami versions with `acld recipe list` and `acld recipe inspect <id>`. Prepare an explicit version with `acld recipe prepare <id> --version <version> --output <new-private-directory>`, then deploy with ordinary Compose commands. These local commands need no credential; remote operations still require access. For deployment and recovery, read [the recipe instructions](../../docs/recipes.md); they include secret generation, resource limits, backup commands and analytics instrumentation checks.

## Establish context

Run `acld whoami`, `acld catalog`, `acld project list`, and `acld usage`. The credential defines capabilities, project scope, permitted sizes/regions, and resource limits. This skill does not expand those permissions or the user's task.

Credentials live in the CLI configuration file, or the path named by `ACLD_CREDENTIALS`. For customer sign-in, run `acld login --server <url>` and have the customer authorize the code at the printed GitHub URL. Only operator-admitted identities can sign in. Retry an interrupted login with the same credential file. Never print or copy its token. A leftover `.lock` directory must only be removed after verifying its recorded process has exited. `acld logout` revokes this credential and descendants before removing the file; read-only agents may revoke themselves. For existing token authentication, use `acld login --server <url> --token-stdin` with the token supplied on stdin. Do not include tokens in arguments, messages, application files, or Git. Provider credentials belong to the operator and never belong in a customer VM.

Check the catalog's provider field. `simulated` means no real VM exists. Inspect availability, architecture, currency, and the hourly reservation including IPv4. Simulated prices are synthetic; `account_gross` prices come from the provider account. Never interpret a different currency as equivalent or select a more expensive substitute without an allowed budget. Powered-off VMs retain their reservations and remain billable on Hetzner.

## Delegate access

Use `acld grant create <name> --policy <policy.json> --expires-at <UTC-timestamp> --credentials <new-file>`. The JSON policy uses the same shape returned by `whoami`: select explicit capabilities, project IDs, sizes, regions, currency, maximum machines and hourly reservation. Start with the permissions the task needs. Do not include `grant:manage` or destructive capabilities unless the owner authorizes them. The service rejects policy or lifetime beyond any ancestor.

The command writes a new0600 credential file and prints only its path, grant ID and expiry. Select it with `ACLD_CREDENTIALS=<new-file>` and verify `acld whoami`. A CLI context does not isolate an agent that can read other credentials on the same OS account. Use a separate OS identity or environment when that isolation is required.

`acld grant list` returns descendants without secrets. Follow `nextCursor` using `--after` until it is null. `acld grant revoke <id>` disables that grant and its descendants on subsequent API requests. `revokedAt` describes that row only; a null value does not prove its ancestors are active. Existing platform SSH sessions close within15 seconds of lost authority. Root access can change a guest; revocation cannot undo those changes or remove customer-installed access paths.

An interrupted creation leaves a pending file and will not issue again into that path. Inspect the grant list and revoke any unwanted matching grant before deliberately removing the pending file and retrying. Tokens cannot be retrieved from the service. Existing files and symlinks are never overwritten by grant creation. Never copy the credential into the deployed application.

## Create and observe

```sh
acld machine create example --project prj_... --size small --region nbg1 --key <stable-request-key>
acld operation wait op_...
acld machine inspect vm_...
```

Use valid IDs returned by the service. Generate and retain one idempotency key of at least 12 characters for each intended mutation. Reuse it with the identical request after a timeout or interrupted response. Reusing it with different input produces a conflict.

Mutation acceptance returns an operation, not a ready machine. Inspect or wait for that operation. JSON results go to stdout; errors go to stderr. `operation wait` exits 0 for `succeeded` or `cancelled`, 1 for `failed`, and 2 when blocked. Read the JSON progress: `cancelled` means creation was stopped and cleanup completed, not that a machine is ready. A client timeout does not cancel server work. `cleaning_up` means the service is reconciling and removing owned resources before releasing the reservation; keep inspecting the returned operation.

`waiting_guest` distinguishes enrollment from runtime checks. A provider's completed create/reboot action does not prove the guest is usable. `guest_identity_mismatch`, `guest_deadline_exceeded` and `guest_signing_exhausted` retain the owned VM/IP reservation for operator recovery. Do not create a replacement automatically or claim the reservation was released. Customer admission requires an operator-configured customer runtime with a retained signed image and explicit spending limits. The runtime and internal reference application have passed bounded Hetzner verification with cleanup; general customer Compose uses the separate SSH access path. Customer SSH requires a signed image advertising customerSsh:1 and an operator-configured access gateway. The separate image factory rejects customer `/v1/*` calls. Do not infer customer availability from its health endpoint.

If progress is `blocked`, retain the operation ID and report its reason. Empty provider inventory does not prove creation failed. Do not use a fresh key or a new machine name to work around an unknown outcome; that could duplicate paid infrastructure. Duplicate-resource resolution currently needs the operator.

## Connect and transfer files

```sh
acld ssh vm_... -- /usr/bin/id -u
acld file put vm_... ./compose.yaml /var/lib/agent-customer/compose.yaml
acld file get vm_... /var/lib/agent-customer/result.txt ./result.txt
acld access inspect access_...
```

SSH and SFTP require `machine:exec` in the machine's project. The guest must be running, verified and free of active lifecycle operations. The remote user is `agent-customer`, with passwordless `sudo`; this permission gives control of the entire VM. Use `--` before SSH command arguments. Remote commands follow ordinary SSH shell semantics, so quote values for the remote shell when necessary. File transfer accepts one file per command and supports spaces; it rejects newline/NUL paths.

SSH streams remote stdout/stderr and preserves the native exit code. Session metadata goes to stderr; do not try to parse all SSH output as JSON. `access inspect` returns JSON metadata without the transport ticket. File transfer uses native SFTP output. The CLI creates ephemeral credentials, verifies allocation-bound host trust and disables inherited SSH configuration, agents and forwarding. Do not bypass failed host authentication by disabling verification.

A consumed ticket cannot reopen a connection. Reconnect with a new SSH command after inspecting the previous outcome. Connection loss does not prove that a remote command failed or rolled back. Do not blindly repeat migrations or other irreversible commands; use the durable `run` commands when you need a retained invocation result. Long-running applications should use Docker Compose or systemd so closing the CLI does not stop them. API/gateway outages close platform SSH within the15-second authority lease; they do not stop the guest or its applications.

## Run a durable command

```sh
acld run submit vm_... --id <stable-UUIDv4> --request ./run.json
acld run inspect vm_... <same-UUID>
acld run logs vm_... <same-UUID> --after 0
acld run cancel vm_... <same-UUID>
```

Use an owner-only request file with an `argv` array and absolute executable/cwd, for example `{"argv":["/usr/local/bin/node","./migrate.js"],"cwd":"/srv/example","timeoutSeconds":300}`. Optional `env` and `stdin` carry explicit inputs. Shell interpretation requires explicitly choosing `/bin/sh -c`; arguments are otherwise passed directly. Invocation IDs are lowercase UUIDv4 values. The machine needs a current guest image with the run helper.

Keep one ID and identical request through lost responses. A started invocation never runs again under that ID; changed intent returns `idempotency_conflict`. Read `run.state`, not just the CLI exit code: `queued`/`running` are pending; `exited` includes the command's exit code; `terminated` gives its reason. A successful CLI query does not imply the remote command succeeded. Resume logs with `nextCursor` until `complete` is true. Do not put sensitive command contents or output in shared logs.

Closing the CLI stops waiting, while admitted work continues. Access revocation does not undo admitted work; use explicit cancellation when authorized. Reboot or an uncertain start produces `interrupted`, which must not be retried under a new ID without understanding possible effects. Runs have bounded time/output and systemd limits. Use Compose or a service unit for applications that should remain online; background children of a run are cleaned up when its unit ends.

## Deploy and recover a Compose application

```sh
acld compose apply vm_... example --source ./deployment --file compose.yaml --release <UUIDv4>
acld compose wait vm_... example
acld compose inspect vm_... example
acld compose logs vm_... example --service backend
acld compose apply vm_... example --source ./deployment --file compose.yaml \
  --release <new-UUIDv4> --expected-release <current-UUIDv4>
acld compose recover vm_... example --from <successful-UUIDv4> \
  --release <new-recovery-UUIDv4> --expected-release <current-UUIDv4>
```

Prepare a dedicated source directory: all regular files are uploaded, with no implicit ignore rules. Keep cloud/CLI credentials, repository history and installed dependencies outside it. Source is limited to 8 MiB and 1024 files; links and special files are refused. Use prebuilt images or ordinary SSH for larger contexts. Application secrets travel inside authenticated SSH and remain in root-protected release directories on the VM. Do not print those files into shared logs.

Keep a release ID and identical source/options when recovering a lost admission reply. Changed inputs under that ID conflict. `--expected-release` names the current attempt, including failed or interrupted attempts. Inspect a conflict instead of automatically overwriting concurrent work. `apply` admission does not mean healthy: use `wait`, check the returned release ID and phase, and inspect container health. A wait timeout leaves deployment work running. Applications need meaningful health checks and a restart policy such as `unless-stopped`.

The helper keeps a stable `acld-<app>` Compose project and pins built/pulled images. Use named volumes for mutable data. Anonymous volumes, including image-declared volumes without explicit mounts, are refused. Source bind mounts must be read-only; use named volumes or deliberate absolute guest paths for writes. An app name does not isolate tenants: this credential controls the whole VM, and explicit external volumes or host paths can share data.

A failed or interrupted release can leave a partially updated app. Inspect its containers/logs, then choose a new apply or an explicit `recover` from a previously succeeded release. Recovery uses retained images/configuration without rebuilding or fetching mutable tags. It preserves named volumes but **does not undo database migrations or restore lost database contents**. Run migrations explicitly through durable commands. Do not delete release directories, prune recovery images, or use `docker compose down -v` as a routine fix. Database recovery uses the separate protected backup and isolated restore flow below.

## Capture and restore application data

New Hetzner offers include provider automated backups and their quoted surcharge. An allocated machine's `backupStatus: "enabled"` confirms the last observed setting, not a completed recovery point or a database restore. Provider backups disappear when the VM is destroyed. Use the protected application backup commands below for recovery points that must survive source destruction.

Use `backup capture <machine> <app> --id <UUIDv4> --release <successful-release> --service <postgres-service> --database <database> --user <user> [--files <relative-files...>]`, then `backup wait <UUIDv4>`. Retain the UUID before sending the request and inspect it after disconnects. The recipe supports PostgreSQL 17, the captured Compose source and explicitly declared regular files beneath `/var/lib/agent-customer`. It does not capture other databases, arbitrary directories, other named volumes or an entire disk. Files are not transactionally coordinated with the database dump.

`backup inspect <UUIDv4>` must report `captured` before treating an off-machine copy as available. This means encrypted bytes and their protected object version were verified, not that the application has been restored. `backup list <machine>` still works after source destruction. Never place storage credentials or wrapping keys in a guest. Backups are operator-configured; an unavailable endpoint does not authorize an improvised bucket or secret copy.

Restore with `backup restore <backup-UUID> <new-app> --id <restore-UUID> --name <new-machine-name> --size small --region <allowed-region>`, then `backup restore-wait <restore-UUID>`. This needs `backup:restore` and ordinary machine-creation permission/budget. The service creates a new isolated VM; it does not accept an existing target or modify the source. Keep the returned machine and operation IDs. An unfinished target rejects customer SSH and routes. After success, inspect the application and restored files under `/var/lib/agent-customer/restores/<restore-UUID>/`; `restore_verified` records guest database/service verification, not application-specific correctness. The restore network is internal and host ports are inactive. Check the private container address from the VM through authenticated SSH. Do not publish a route to an inactive port.

A lost or blocked restore must be inspected with `backup restore-inspect <restore-UUID>`. Do not replay SQL manually into that target or mint another restore UUID until the customer's recovery intent and budget cover another machine. Failed targets remain owned and billable. For an authorized cutover, fence source writes and close old application/database connections, then `compose promote <new-machine> <app> --release <new-UUID> --expected-release <verified-isolated-release>`. Wait and inspect that release. Promotion preserves pinned images, data mounts and loopback ports while enabling egress. Move the existing HTTPS hostname with `route move <hostname> <new-machine> --port <app-port> --expected-version <route-version> --key <UUID>`, then verify application reads and writes through HTTPS. Moving a route requires authority for both projects. Writes since the chosen backup are absent unless separately transferred; switching back after new writes can lose data. Destroying either VM remains a separate action within the customer's authorization. Protected backups remain after VM destruction.

For daily protection, use `backup schedule <machine> <app> --id <schedule-UUID> --release <successful-release>` with the same PostgreSQL/file flags as capture. The first capture is admitted on a worker tick, then every 24 hours, after the CLI has exited. Its grant must remain valid with `backup:create` for the source project; use an expiry covering the customer's authorized backup period. Inspect `backup schedule-inspect <schedule-UUID>` for the last attempt, its backup result and latest successful recovery point. Report an old recovery point, a blocked capture or a quota refusal; do not imply a daily schedule guarantees a recent backup.

Schedules pin their allocation and release. After a successful application update, run `backup schedule-disable <old-schedule-UUID>` and create a new schedule with the new exact release. Disable is idempotent; replaying the old creation does not reactivate it. Revocation/expiry disables future admissions. A schedule cannot silently follow a replacement VM, and disabling leaves already admitted captures and retained recovery points intact.

The operator may enable automatic retention for scheduled backups. It keeps seven newer successful UTC capture days of the same data recipe before deleting an expired point; failed captures do not count. Manual backups remain until explicitly purged. Do not infer that the operator is running from schedule creation alone.

Only when permanent deletion of this recovery point is authorized, run `backup purge <backup-UUID> --id <purge-UUID> --allow-data-loss`, then `backup purge-inspect <purge-UUID>`. This requires `backup:purge`. Acceptance immediately prevents new restores and commits cleanup that survives credential revocation; it cannot be cancelled. It may delete the final recovery point. Retain and reuse the UUID after a lost response. An unfinished restore or guest staging blocks admission; inspect those obligations first. Object Lock may delay deletion. A `waiting` or `blocked` purge still reserves storage. Only `purged` confirms exact object-version absence. The CLI never receives deletion credentials. An unresolved upload needs operator reconciliation of its recorded intent; ask for that action with the backup ID, and do not create a replacement UUID to conceal the unknown result. The operator recovery command does not expand this skill or customer credential authority.

If `backup restore-inspect <restore-UUID>` reports `state.waitingFor: "backup_key"`, retain that restore UUID and ask the operator to recover its matching private wrapping keyring. Never request the key itself or put it in the application. Restore resumes after the operator recovers the key. The isolated target remains billable; inspect its machine/operation and destroy it only within existing data-loss authorization if the recovery is abandoned. A new restore UUID would allocate another target without fixing the missing key.

## Change an existing machine

Read the current machine version before a change, then pass `--expected-version`. A version conflict means another change happened; inspect the result and reassess the intended action.

```sh
acld machine power-off vm_... --expected-version 2 --key <stable-request-key>
acld operation wait op_...
acld machine resize vm_... --size medium --expected-version 4 --key <another-key>
```

Power-off requests graceful shutdown and waits for the provider to report off. If the guest does not shut down, keep the same operation and report the blocked state; do not force a power cut. Resize requires the machine to be powered off. Disk shrinking is unsupported. Use `power-on` when the resize succeeds. `reboot` is also available.

Deletion destroys the disk. When deletion and data loss are already authorized by the user, run:

```sh
acld machine destroy vm_... --expected-version 6 --allow-data-loss --key <stable-request-key>
acld operation wait op_...
acld machine inspect vm_...
acld usage
```

Check for `destroyed` and released usage reservations. `acld usage` reports account-wide VM and backup reservations plus account/credential limits. `acld usage history` explains rate changes in your accessible projects; follow `nextCursor` with `--before`. These are admission reservations, not billed charges. A powered-off VM stays reserved; destroying a VM preserves its protected application backups. Do not assume positive remaining capacity guarantees admission. See [usage semantics](../../docs/architecture/usage.md). Deletion completes only after the VM and its owned Primary IP are confirmed absent. The same destroy command cancels an active blocked create or cleans a failed create with a retained allocation. Active cancellation returns the original create operation and eventually `cancelled`; failed-create recovery returns a new destroy operation and preserves the failed source result. Accepted cleanup continues after its initiating grant expires or is revoked, within the recorded allocation scope.

Unknown source creates never resubmit and empty inventory never proves absence. Duplicate resources remain recorded; automatic IP deletion or mismatched assignment can block VM cleanup. `cleanup_retry_exhausted` means the initial three attempts and any explicitly authorized operator retries were used. Report the operation/resource IDs for operator recovery; do not create replacements or assume reservations were released. New request keys do not reset this retry budget. The operator has a separate recovery command requiring database access and evidence. Do not fabricate provider confirmation or use this skill as authority to run it.

## Publish HTTPS

Bind the application's HTTP port on the VM's loopback interface, for example `127.0.0.1:3000`. The public gateway handles HTTPS and forwards through the private guest proxy. Keep database ports private. Routing requires `route:publish` for the machine's project.

```sh
acld route publish vm_... --name example --port 3000 --key <UUIDv4>
acld route wait <returned-hostname>
acld route inspect <returned-hostname>
acld route publish vm_... --name example --port 3001 --expected-version 1 --key <new-UUIDv4>
acld route remove <hostname> --expected-version 2 --key <new-UUIDv4>
```

Keep the command UUID and input after a lost response. Retry the same command, then inspect the hostname if a later version superseded it. Do not invent a fresh key to conceal an uncertain result. A blocked change has exhausted five guest attempts; diagnose the guest/application and submit a new change with the current expected version. Route application confirms proxy configuration, not application readiness. Make an HTTPS request and check the expected application behavior/data after deployment or update.

For a custom hostname, run `acld domain add <hostname>`, publish the returned TXT record and point all A/AAAA records at the operator's gateway addresses. Run `acld domain verify <challenge-id>`, then publish with `--hostname <hostname> --challenge <challenge-id>` instead of `--name`. Challenges expire after 30 minutes. Removed names remain reserved to the owning account; do not try another account to bypass a reservation. Read [routing semantics](../../docs/architecture/https-routing.md) when diagnosing ownership or an interrupted update.

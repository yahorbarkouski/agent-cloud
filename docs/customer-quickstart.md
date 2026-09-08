# Deploy your application

Your existing agent uses `acld` to create one VM, upload an ordinary Compose project and publish HTTPS. The frontend, backend and PostgreSQL run on that VM after your agent disconnects. Customers do not need Hetzner credentials or access to the platform's source code.

This path passed a real hosted Hetzner deployment on 2026-09-08. The disposable service was removed after verification to bound costs. There is currently no persistent public endpoint to sign into. An operator must run the [customer service](self-host-customer.md) and provide its HTTPS origin and GitHub admission before these commands can work.

## Connect your agent

Install and verify the [published CLI](cli-install.md). It includes its dependencies and agent instructions. Node.js 24 and OpenSSH are required locally.

```sh
acld agent instructions
acld agent install --directory <existing-agent-skill-parent>/agent-cloud
acld login --server <operator-HTTPS-origin>
acld whoami
acld capabilities
acld catalog
acld usage
```

GitHub approval opens in the browser. The CLI saves a private cloud credential; never paste it into an agent prompt. The skill installation directory must be new and its parent must exist. `capabilities` reports configured services, while `whoami` reports the credential's permissions.

Give the agent this task, with your actual limits:

> Read the installed agent-cloud instructions. Deploy this project's frontend, backend and PostgreSQL on one allowed small VM. Keep PostgreSQL private and persistent. Prepare a deployment context containing only necessary application files and secrets. Use my authenticated CLI, retain request and release IDs, and return the HTTPS URL. Verify a database write, reconnect, inspect logs, and deploy an update that preserves it. Stay within my stated budget. Ask before deleting my application data.

## Start with the example or your own project

The [full-stack example](../examples/full-stack/README.md) contains the exact create, upload, publish, update and destroy commands exercised in the real deployment. Its preparation script copies only application files into a new private directory and generates a database password. No local backend dependency installation is required.

For an existing project, your agent prepares ordinary Dockerfiles and a Compose file. Bind the public entry service to a VM loopback port such as `127.0.0.1:3000:80`; publish it with `acld route publish`. Give PostgreSQL a named volume, health check and private network. Add explicit memory/CPU/process/log limits and restart policies. Preserve database credentials and volume names when updating.

`compose apply` uploads every regular file in its source directory. Its current limit is 8 MiB and 1,024 files. Exclude `.git`, local dependencies and unrelated credentials by preparing a separate directory. Use pinned prebuilt images or the documented SFTP path for larger projects. The VM performs Docker builds; there is no automatic framework detection.

## Operate and recover a release

```sh
acld machine inspect <machine-id>
acld compose inspect <machine-id> <app-name>
acld compose logs <machine-id> <app-name> --service <backend-service>
acld compose apply <machine-id> <app-name> --source <context> --file compose.yaml --release <new-uuid> --expected-release <current-release-uuid>
acld compose wait <machine-id> <app-name>
```

Save UUIDs before submission and reuse the same UUID and unchanged input after an uncertain response. A retryable `resource_busy` response means retry the same request after the current operation advances. Closing the CLI does not cancel admitted work.

If a release fails, inspect it and recover a retained successful release:

```sh
acld compose recover <machine-id> <app-name> --from <successful-release-uuid> --release <new-recovery-uuid> --expected-release <failed-release-uuid>
acld compose wait <machine-id> <app-name>
```

This restores application configuration and keeps named volumes. It does not undo database migrations or recover a lost VM. Protected off-machine restore requires the separate [backup configuration](architecture/protected-backups.md); its final Hetzner storage verification remains open.

Use the example's cleanup commands only after authorizing data loss. Inspect the final destroyed machine and `acld usage`; power-off still incurs provider charges. Logging out revokes access but leaves the application running.

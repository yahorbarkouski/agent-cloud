# Deploy the full-stack example

This is the existing reference application packaged as an ordinary customer project. A static frontend calls a TypeScript backend, which stores a visit counter in PostgreSQL. Docker Compose keeps all three services running on one VM. The database has a named volume and no public port.

Use Node.js 24, the installed `acld` CLI and an admitted account on your operator's real HTTPS origin. No local dependency install is needed to prepare the deployment; Docker installs the locked backend dependencies on the VM. Keep the prepared directory private because it contains the generated database password.

## Create the machine and reserve its hostname

```sh
acld login --server <operator-origin>
acld catalog
acld project list
acld project create demo
acld usage
acld machine create demo --project <project-id> --size small --region <allowed-region> --key <saved-request-key>
acld operation wait <operation-id>
acld route publish <machine-id> --name demo --port 3000 --key <saved-route-uuid>
acld route wait <returned-hostname>
```

Retain the returned IDs and each request key. The route reserves the public hostname before the backend is configured to accept same-origin writes. It can return an application error until deployment finishes.

## Prepare and deploy

From this example directory, choose a new directory whose parent already exists:

```sh
node prepare.mjs <returned-hostname> <new-private-context-directory>
acld compose apply <machine-id> demo --source <private-context-directory> --file compose.yaml --release <saved-release-uuid>
acld compose wait <machine-id> demo
acld compose inspect <machine-id> demo
acld compose logs <machine-id> demo --service backend
```

Open `https://<returned-hostname>` and click **Record a visit**. Close the deploying CLI or agent, reopen the website and verify that the count remains. The frontend binds only to VM loopback port3000; the platform supplies public HTTPS. The sample counter has no user accounts or private customer data.

The preparation command copies a fixed set of application files. It excludes repository history and local dependencies, refuses an existing destination and creates a private database secret. `acld compose apply` includes every regular file in its source directory, so use the prepared context rather than an entire repository.

## Update without replacing the database

In the existing private context, change `APP_REVISION: '1'` to `'2'` in `compose.yaml`. Change the frontend's visible `Release 1` text to `Release 2` if desired. Preserve `database-password`, the database name/user and the named volume.

```sh
acld compose apply <machine-id> demo --source <same-private-context-directory> --file compose.yaml --release <new-saved-uuid> --expected-release <previous-release-uuid>
acld compose wait <machine-id> demo
```

Open the website again: the backend revision changes and the existing counter remains. Retry an interrupted apply with the same UUID and unchanged source. Inspect an uncertain result before submitting another update. An application update does not reverse a database migration or provide an off-machine backup.

## Remove the disposable application

Inspect the route and machine to obtain current versions. Once deletion and data loss are authorized:

```sh
acld route inspect <hostname>
acld route remove <hostname> --expected-version <route-version> --key <saved-remove-uuid>
acld machine inspect <machine-id>
acld machine destroy <machine-id> --expected-version <machine-version> --allow-data-loss --key <saved-destroy-key>
acld operation wait <destroy-operation-id>
acld machine inspect <machine-id>
acld usage
```

Only confirmed destruction releases the VM reservation. Power-off remains billable. The private source context stays on your computer until you deliberately remove it.

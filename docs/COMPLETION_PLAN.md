# Finish the customer cloud

Prepared on 2026-09-08 against source `705101eb4a990948f31fd57e1c16f28aefe176af`; narrowed after tracing the production code at `222dfeb`. This is the remaining delivery plan for the original non-Stripe product. It replaces the old milestone ordering, not the working implementation. [CONTEXT.md](CONTEXT.md) remains the single current-state handoff.

## The result we owe the customer

An admitted owner can give an existing coding agent a normal project containing a frontend, backend and PostgreSQL. With the published CLI, a public API origin and scoped customer credentials, that agent can deploy the project onto one cheap Hetzner VM, return a working HTTPS URL, inspect it, update it without losing its data, recover it from a protected backup and remove the infrastructure. The operator prepares the cloud once; deploying each customer application must not require operator database edits, private scripts or access to the platform source checkout.

The customer deployment path is already implemented and connected in the production code. It is not currently available through a running, configured hosted service. An internal reference application passed a real Hetzner deployment, but its infrastructure was deliberately deleted. Customer Compose and recovery have connected native and container evidence. The final public customer deployment/recovery run is still unverified. These are different gaps: deploying the service, improving its first-use experience, and establishing provider evidence. Do not interpret them as missing login, provisioning, SSH, Compose or routing implementations.

There are two delivery points:

1. **Usable deployment preview:** you can actually deploy your fake project, open it in a browser, disconnect, reconnect, update it and delete it using customer access. Return the real endpoint and exact commands at this point. Protected application recovery can still be explicitly unavailable.
2. **Completed non-Stripe scope:** the same customer can delegate and revoke access, install analytics, use domains and durable commands, restore after losing the source VM, understand resource reservations, and operate a documented self-hosted installation with verified recovery procedures.

The first point is the immediate milestone. Do not make S3, a dashboard, further competitive research or a broad audit its prerequisites.

## Keep the existing product and stack

- TypeScript with the existing strict contracts, Hono API, PostgreSQL/Drizzle, Graphile Worker, SDK and CLI.
- Hetzner ordinary VMs, current image publication/enrollment, Smallstep identities, native SSH/SFTP, systemd and Docker Compose.
- Existing public Caddy gateway, allocation-bound guest proxy and access gateway. Customer database ports stay private.
- PostgreSQL and Umami recipes, protected application backups, retained release recovery and fenced control recovery.
- Apache-2.0, public source, signed CLI distribution, offline agent instructions, OpenAPI and `/llms.txt`.
- Operator-admitted GitHub identities with explicit capacity policies for the non-billing preview. No public internal bootstrap, payments, credit ledger or Stripe.

We are not building an agent, an application framework, a universal source detector, Kubernetes, a serverless runtime, a warm pool or a shared build service. Agents can prepare ordinary Compose files. Customer builds run on their own VM or use pinned prebuilt images. A single VM is a failure domain; code recovery does not reverse arbitrary database migrations.

## Production code trace: what delivery 1 does not need to rebuild

The following trace was checked in source, beyond CLI help or documentation claims. It establishes connected implementation, not a claim that the final hosted configuration has passed.

| Path                        | Existing connection                                                                                                                                                                                                                                                                                                              | Required delivery-1 action                                                                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer sign-in            | [CLI login](../apps/cli/src/login.ts) and [SDK exchange](../packages/sdk/src/login.ts) call the real GitHub device flow; [API startup](../apps/control/src/api.ts) constructs the production verifier and customer login service                                                                                                 | Supply the existing OAuth configuration at the public origin and admit the owner through the existing operator command                                                             |
| Machine lifecycle           | [CLI](../apps/cli/src/index.ts) calls the SDK/API; [customer runtime](../apps/control/src/customer-runtime.ts) constructs `HetznerProvider`, allocation-bound image selection, enrollment and readiness; [worker](../apps/control/src/worker.ts) runs the real lifecycle tasks                                                   | Deploy the runtime with current credentials, retained signed image, generation, firewall and explicit caps; no new provisioning engine                                             |
| Customer SSH and deployment | [Compose CLI](../apps/cli/src/compose.ts) uploads the context through [invokeGuest](../apps/cli/src/guest-command.ts), which uses a revocable verified customer SSH session; [guest CLI](../packages/guestctl/src/cli.ts) dispatches to the existing Compose manager/systemd worker                                              | Configure the access gateway and compatible guest image; use existing apply/wait/inspect/logs/recover commands                                                                     |
| HTTPS publication           | [Customer runtime](../apps/control/src/customer-runtime.ts) creates hosting when configured; [API routes](../apps/control/src/app.ts) expose customer publication, and the worker/public gateway apply the desired route                                                                                                         | Supply real domains, gateway identities/addresses and public ACME configuration; verify browser behavior                                                                           |
| Agent support               | [CLI agent commands](../apps/cli/src/agent.ts) expose/install bundled instructions; customer discovery is wired in the API                                                                                                                                                                                                       | Put the actual service origin and a short deploy/update/cleanup walkthrough beside the existing skill; no new agent integration protocol                                           |
| Full-stack example          | [Reference backend](../packages/guestctl/src/reference-app.ts), [frontend/Compose recipe](../packages/guestctl/src/reference-recipe.ts) and [customer hosting scenario](../scripts/support/hosting-scenario.ts) already provide the app and customer command sequence                                                            | Package these existing app sources as a normal example, with the customer gateway's loopback binding; remove dependence on the ignored guestctl build, not rewrite the application |
| Operator deployment         | [Container entrypoint](../infra/container/entrypoint.mjs) already exposes API, worker, migration, gateways, admission and recovery; [customer Compose](../infra/compose/customer.yaml) assembles them. Existing `setup:pki`, `setup:runtime`, `setup:hosting-gateway`, `image:build` and `customer` commands supply setup pieces | Run the existing commands in a documented order and fix the specific supervision/mount/configuration issues below. A general installer is not a prerequisite                       |

Most immediate work is deployment/configuration, with bounded packaging corrections and customer documentation. New implementation is justified by a specific missing behavior or a failure observed while configuring this path. Never rebuild an existing feature because its final live verification remains open.

## What exists and what must still be delivered

Evidence below is scoped to the recorded implementation. Native/container proof does not establish behavior on the final Hetzner topology. Older architecture documents sometimes contain historical status paragraphs; use their technical contracts and the current handoff rather than treating those paragraphs as a release status.

| Customer capability                | Reuse                                                                               | Remaining acceptance gap                                                                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Install the product interface      | Signed `cli-v0.1.0`, offline skill/recipes, tamper-checked download                 | Use the downloaded artifact against the deployed service; publish a new immutable version only if customer code changes                          |
| Sign in and delegate               | Real GitHub device login, admission operator, ancestry checks, revocation           | Configure the public service, admit the owner, authenticate there, exercise a project-limited grant and admission renewal                        |
| Get a real machine                 | Provider journals, costs, signed image selection, enrollment, cleanup               | Publish a current retained image and use customer identity for creation through the final service; verify automated VM backups actually enabled  |
| Upload and deploy a normal project | SFTP, durable commands, `compose apply/wait/inspect/logs/recover`                   | Ship an ordinary public example without fixture code; run it through the real customer access gateway                                            |
| Keep it running and update it      | Detached Compose, named volumes, pinned release history                             | Verify public app behavior after client exit, guest reboot, update and failed-release recovery on the customer VM                                |
| Publish HTTPS and custom domains   | Managed routes, DNS challenges, hostname ownership, persisted gateway state         | Configure real DNS/ACME and verify generated and custom hostnames on the deployed gateway                                                        |
| Install PostgreSQL and analytics   | Packaged PostgreSQL 17/Umami recipes, real local/native browser behavior            | Install through the customer CLI, instrument the public example and observe a real pageview/event                                                |
| Back up and restore                | Encrypted versioned objects, schedules, quotas, isolated restore, promotion/cutover | Configure protected Hetzner storage and independent keys; prove permissions and source-loss recovery against that provider                       |
| Know cost and capacity             | Account/grant/global reservations, history, backup-byte limits                      | Show live VM/IP/automated-backup rates, enforce concurrency caps, account for platform/storage/traffic costs outside customer reservation totals |
| Survive platform failure           | Durable work, gateway state, generation fencing, dump/WAL recovery                  | Deploy supervision and monitoring; recover the selected real installation and independent private material without resurrecting authority        |
| Self-host                          | Pinned runtime container and customer Compose topology                              | Connect first installation, CA/image setup, private configuration, upgrade and recovery into one usable operator procedure                       |
| Use an existing agent unaided      | CLI help, JSON results, skill, API discovery                                        | Complete the published customer walkthrough from a fresh environment without repository internals or operator help during deployment             |

## Concrete gaps found in the current tree

These are work items, not reasons to redesign the platform.

1. **Example packaging.** The frontend, backend and PostgreSQL recipe exist. `scripts/support/compose-scenario.ts` constructs their deployment using an ignored guest-build pointer and a copied `guestctl` bundle. Expose the same application as a normal customer context and reuse it in acceptance. The absence of an example folder does not block arbitrary supported customer Compose source.
2. **Operator configuration and first-use documentation.** `docs/self-host-customer.md` starts with private directories, an image publication, runtime identity, signer configuration, generation and firewall. Existing setup commands provide the functionality; complete the selected host's configuration using them and record their order. A single-input installer or new installation journal is optional later simplification, not required for delivery 1.
3. **Incomplete long-running host setup.** `infra/compose/customer.yaml` has no service restart policy and does not package CA startup. Add supervision for long-running roles and a documented CA deployment using the existing PKI tooling. One-off initialization/migration commands must never become restart loops. Verify a real host reboot.
4. **Credential mounts need to match role claims.** The API and worker currently share the entire `control` directory. Split mount contents by the credentials each role needs, including keeping GitHub OAuth secrets out of the worker. Gateways must retain their current separation from provider/DB/signing secrets. Container separation is not protection against host-root compromise.
5. **Deployment context needs clear preparation.** The existing uploader includes every regular file, with an 8 MiB/1,024-file limit and no implicit ignore rules. The walkthrough must prepare an explicit context and keep `.git`, dependencies and unrelated credentials out. Use prebuilt images or documented SFTP for larger projects. Do not silently raise upload limits or invent automatic framework conversion.
6. **Operating limits are not a provider invoice.** `acld usage` is an admission/reservation view. The persistent platform host, image storage, protected storage and edge transfer need their own bounded operating record. VM power-off does not stop allocation charges.
7. **No final provider recovery evidence.** MinIO/native restore results are useful foundations. Actual Hetzner Object Lock/IAM, source-VM loss, automated backups and the complete customer route cutover still need provider-specific verification.

## Deployment topology for this preview

Use the existing customer Compose topology on a small, dedicated trusted Linux host for the owner/invited preview. It runs the control API, worker, PostgreSQL and gateways, with the CA protected as a separate private service. Customer code, builds and application databases run on separate customer VMs. The laptop is an operator client, not a required runtime dependency.

```text
Owner / existing coding agent
        | GitHub login; scoped cloud credential
        | HTTPS CLI/API and authenticated SSH transport
        v
Public control origin ---- Trusted platform host
                           API + worker + control PostgreSQL
                           public gateway + access gateway
                           protected CA and role-specific files
                                     |
                       owned provisioning / verified access
                                     v
                             Customer Hetzner VM
                           Docker Compose + systemd
                           frontend -> backend -> PostgreSQL
                                     |
Browser -- application HTTPS --> public gateway --> guest proxy

Platform backup worker --> protected object storage in another location
Independent protected copy --> keys + platform recovery material
```

This co-location is an explicit low-budget preview choice, differing from the original proposal's three trusted infrastructure hosts. Public traffic can exhaust shared platform resources, and one host failure affects management and routing. Bound connections, processes, memory, disk and traffic; keep public containers free of signing/provider secrets. Recover the single host before claiming supported recovery. Do not promise high availability. A second gateway or dedicated backup-worker host is not required for the owner's first deployment; stronger shared-host isolation and availability claims require their corresponding topology later.

Use a stable control origin and a distinct application domain as required by the existing routing design. Do not register a paid domain or select an arbitrary domain owned by the user without establishing its use. Reuse an available authorized domain where possible. A disposable DNS service can support a bounded engineering run if compatible, but it is not a durable published service address. Record the chosen DNS records and exact gateway address. Internal endpoints and CA administration must not become customer-accessible.

## Milestone 1: the owner deploys a real project

**Acceptance:** starting with the downloaded CLI and a fresh customer credential, the owner or their existing agent deploys frontend/backend/PostgreSQL on one cheap Hetzner VM, opens trusted public HTTPS, writes a record, disconnects, reconnects, reads logs, updates the app and reads the same record. No internal reference endpoint, fixture GitHub verifier, simulated provider, manual database patch or private deployment script is part of the customer path.

Work in this order, connecting each change into the same acceptance scenario:

1. Package the existing reference backend, frontend and Compose recipe under `examples/full-stack/`. Retain the visible revision, persisted visit counter, health checks, named database volume, restart policies and resource/log limits already present. Use the customer hosting scenario's loopback frontend binding, not the internal reference's direct public 80/443 bindings. Give the example its own small application entrypoint/Dockerfile and lockfile instead of copying the entire guestctl bundle. Preserve generated database secrets on update. Do not build a new note application or a new deployment abstraction.
2. Validate the repackaged context through the existing Compose implementation before paid work. Document the current 8 MiB/1,024-file context contract, application secret handling and pinned-image alternative. Reuse the current skill and CLI; shorten the first-use instructions to installing, signing in, choosing capacity, deploying and opening HTTPS. No changes to machine/Compose/route commands are assumed necessary.
3. Configure the selected hosted installation with the existing PKI, runtime identity, gateway, image, migration/generation and customer admission commands. Record private configuration and existing resource/operation receipts so interrupted setup resumes safely. Validate paths, file ownership, ports, architecture, caps and required services. Add only a thin configuration check/helper if a concrete manual failure justifies it; do not block delivery on a general installer, new state machine or new installation database.
4. Install the trusted host with current code. For a new empty database, migrate and initialize its generation before creating admission or image records. For any preserved/restored installation, use the existing fenced recovery/upgrade path; do not reinitialize it. Keep the preserved development DB/CA/identity untouched unless a later migration explicitly needs them. Configure private CA reachability, public TLS, process supervision and narrow secret mounts. Make authenticated image/guest enrollment reachable at the correct setup phase; do not make the first image depend on an already-ready customer runtime. Customer login remains unavailable in factory mode.
5. Run the image factory through the existing durable journal, build and verify a current guest image containing customer SSH, run, Compose, routing and backup helpers, and retain the signed publication. Use the existing cheap recorded type/region when available and within the current quote; no silent fallback. Remove builder/verifier resources after publication. Start customer mode with that exact release and customer firewall. Keep image-factory and customer access modes separate.
6. Configure real GitHub identity and admit the owner's verified numeric GitHub ID with the exact project, size/region, machine count, expiry and spending policy. Start with a bounded invited preview. Use `acld login --server <actual-origin>` and issue a project-scoped deployment credential. Never return an internal bootstrap token as the customer's account.
7. Run the command path below against the real service. Store returned IDs outside source before subsequent operations. Retry the same request/release IDs after lost replies. Open the app in a real browser, increment and read the persisted counter, exit the CLI and close the deploying session, then reconnect from a fresh process. Update the visible version and prove the counter persists. Correct concrete failures in the existing layers; a failed live check is not a reason to start a replacement subsystem.
8. Exercise destroy on the disposable deployment and independently verify VM/IP cleanup and reservation release. Retained shared image/firewall/platform resources are separate obligations, not leaks or customer-owned deletions. For hands-on use, leave or recreate a sample only within an explicitly recorded running-cost budget and expiry; provide its URL and destroy instructions. Never present a deleted URL as a current demo.

### Customer commands we must make usable

These commands already exist. Values in angle brackets are returned IDs or selected configuration, not defaults that work today. The service origin and example preparation must be provided when this milestone is delivered.

```sh
acld login --server <actual-public-control-origin>
acld whoami
acld capabilities
acld catalog
acld project list
acld usage

acld machine create demo --project <project-id> --size small --region <allowed-region> --key <saved-create-key>
acld operation wait <operation-id>
acld machine inspect <machine-id>

acld route publish <machine-id> --name demo --port 3000 --key <saved-route-uuid>
acld route wait <returned-hostname>
# Prepare the example context with APP_HOSTNAME set to the returned hostname.
acld compose apply <machine-id> demo --source <prepared-context> --file compose.yaml --release <saved-release-uuid>
acld compose wait <machine-id> demo
acld compose inspect <machine-id> demo
acld compose logs <machine-id> demo --service backend
```

The packaged example will expose loopback port 3000. The frontend calls the backend through the same public origin; only the backend reaches PostgreSQL. The existing reference backend checks `APP_HOSTNAME` on writes: reuse the hosting scenario's ordering by reserving/publishing the hostname before finalizing that environment value and applying Compose. A configured route can briefly return an application error before deployment succeeds. A successful route operation must be followed by an actual HTTPS read/write, because proxy configuration is not application health. Updating uses the existing `--expected-release`; cleanup uses inspected machine/route versions and explicit data-loss authorization. The final walkthrough must show those concrete commands and returned IDs without requiring architecture documents.

**Delivery evidence:** exact source/image/CLI revisions, real customer principal and scoped policy without tokens, operation/release IDs, trusted URL, app version before/after, persisted marker, client disconnect/reconnect observation and ownership/cleanup inventory. Return these as product results, not a test count.

## Milestone 2: operate, interrupt and recover a deployment

**Acceptance:** the same customer can transfer files, run a migration once despite disconnecting, recover a failed application release, revoke an agent, and see the correct remaining reservation. Running application services survive client and control API disconnection.

The operation, recipe and recovery commands in milestones 2–4 already exist. Those milestones primarily configure their live dependencies and verify the selected deployment, with changes limited to demonstrated failures or explicitly identified operating gaps.

- Exercise file put/get with a content digest and private-file handling through actual SFTP. Do not require permanent SSH keys or unverified host trust.
- Submit a durable command, disconnect after submission, reconnect, inspect its retained result and resume logs. Re-submit the same ID to prove no second execution. An interrupted arbitrary migration stays inspectable and is not automatically replayed.
- Apply a deliberately unhealthy release and recover the last compatible successful release using retained images. Confirm PostgreSQL data is unchanged. Record the maintenance interval; no zero-downtime claim.
- Reboot the customer VM and verify service restart, guest renewal, authenticated access and public application data. Exercise power-off/power-on with reservation unchanged. Verify resize semantics in existing focused/provider protocol checks; a paid resize is optional only if it fits the recorded cap and answers an unresolved provider concern.
- Revoke the deployment grant from the owner credential while one platform SSH session is open. API calls must fail afterward and the session must close within the implemented 15-second lease. The website keeps running. Test a second admitted account with zero allocation allowance for forbidden inspect/access/route/restore/destroy requests; no extra VM is needed.
- Verify owner re-login and operator admission disable/renew preserve the account/project without reactivating revoked credentials. State that root changes and customer-installed access paths cannot be undone by platform revocation.
- Competing creates near a one-machine quota must admit at most one paid allocation. Conflicting updates must report the existing release/version; no forced overwrite. Provider-timeout/crash boundary permutations belong in existing focused fixtures unless a new provider behavior requires a live reproduction.
- Check actual catalog/reservation rates include IPv4 and automated backups. Confirm the provider reports backups enabled before readiness. Inspect create, power-off and deletion history. Retain reservations through unknown outcomes until owned cleanup is confirmed.
- Inspect VM/container CPU, memory, disk and logs through the existing commands. Bound managed builds and recipe logs. Report storage pressure before new managed work; never solve pressure by pruning database volumes, unverified backups or images required for recovery. Root remains able to change guest-local limits.

**Delivery evidence:** a customer walkthrough covering ordinary operation and the concrete failure outcomes above on the same live fixture. Preserve focused authorization/concurrency regression tests; do not run an independent expensive fleet drill for each item.

## Milestone 3: domains, database and analytics that the customer can use

**Acceptance:** the public example runs on a verified custom hostname, PostgreSQL remains private, and a pageview plus an explicit frontend event appears in the customer's Umami instance.

- Use existing `domain add/verify` and route commands with actual DNS. Verify TXT ownership, all A/AAAA targets, trusted ACME certificates, wrong-host refusal and stable ownership after removal. Keep managed and custom hostname paths in the published walkthrough.
- Run the packaged PostgreSQL recipe through the same deployment interface. Verify generated secrets, persistence across updates, health, documented resource bounds and manual major-version upgrade rules. Do not replace user-modified configuration silently.
- Run the packaged Umami recipe with its own database/role and private credentials. Replace default administrative access, register the example site, add the tracking script/site ID, then observe a browser pageview and event. Installing Umami alone is not analytics verification.
- Reuse the customer VM if the configured memory/disk budget fits. Sequence heavy builds/captures; do not resize or allocate another VM silently for analytics. Report insufficient capacity as a customer choice.
- Publish a static-site example by reusing the frontend portion of the same Compose project. Include worker/background-service guidance using ordinary Compose restart and health semantics where relevant; no new runtime abstraction.

**Delivery evidence:** generated and custom HTTPS URLs, failed public database connection, recorded site/event verification without administrator secrets, and explicit configuration/data preserved after recipe update.

## Milestone 4: recover after losing the source VM

**Acceptance:** capture the real customer app to protected Hetzner storage, destroy its source VM, restore PostgreSQL and declared files on a new isolated VM using the customer CLI, move the existing hostname, and successfully write/read new data. A capture becomes restore-verified only after the isolated application check succeeds.

1. Establish the actual storage quote, billing minimum, currency, retention cost and cap before creating a bucket. Use a distinct location and the existing cross-project principal model: bucket/admin identity separate from scoped writer, reader and retention identities. Provision versioning/Object Lock correctly at creation. Keep deletion/bypass authority out of ordinary workers and guests. No same-project broad-access keys disguised as restricted runtime keys.
2. Test actual permissions with tiny encrypted objects. Verify exact-version read/write and retention; writer/reader cannot delete protected data or shorten retention. Prove the retention role's allowed deletion only after policy permits it. Use a short-lived, isolated permission fixture where the provider allows it, separately from the production retention promise. If retention prevents immediate cleanup, record the exact object/version, expiry, cost and responsible cleanup process; do not mark it removed.
3. Configure independent backup wrapping keys and a protected recovery copy outside both the source VM and trusted host. Do not place plaintext keys in source, artifacts, transcripts or the backup bucket. Verify key recovery before claiming recoverability.
4. Capture a unique database marker and an explicitly supported application file; verify manifest, image/release pins, encrypted stored bytes and exact object version. Confirm the chosen app's consistency contract. Database dumps and live files do not imply one transactional snapshot.
5. Enable the existing daily schedule with a grant whose lifetime covers the desired protection period. Observe the initial automatic capture after CLI exit. Verify next-due/last-success/error reporting and seven-successful-day retention using controlled-clock checks. Do not wait seven days of paid runtime merely to count days, and do not describe accelerated checks as a real week of daily backups.
6. Destroy the disposable source via the product, verify provider absence, and prove the protected backup remains. Restore using the same retained backup ID to a separate allocation. Validate database rows, declared-file digests, private credentials, image pins and network isolation before promotion.
7. Promote the target and move the existing hostname, then create and read a second marker. For a live-source cutover, separately prove the old writer is fenced and old connections closed before production writes reach the replacement. Do not suggest that switching back after new writes is harmless.
8. Exercise one interrupted restore or temporary missing-key condition with the same restore ID. It must remain owned, isolated and inspectable without creating another VM or blindly executing SQL again. Reuse existing fixtures for corruption, wrong-key and uncertain-upload permutations.
9. Destroy targets and remove test routes. Purge only explicitly disposable recovery points after retention permits it, and verify exact-version absence before releasing storage. Keep manual backups until authorized purge; automatically retain the last good point when a scheduled capture fails.

**Delivery evidence:** before/after app data and file digests, original VM absence, recovered HTTPS write/read, permission denials under the actual provider identities, key-recovery result, charged/retained resources and confirmed cleanup. Target the original small-reference restore within 60 minutes once capacity is available; record actual time and causes if missed. This is not a universal SLA or application PITR promise.

## Milestone 5: the operator can keep the cloud running and self-host it

**Acceptance:** a clean operator installation can run the same customer scenario from published files, survive a host restart, perform a supported upgrade, and recover the control installation and private identities with stale authority fenced.

- Finish the self-host runbook using the setup commands exercised in milestone 1. It must work without `.local` history, a proprietary activation service or manual SQL patches. Add a packaged configuration helper only where repeated manual setup causes concrete errors. Preserve existing identities and operation receipts; a new general installer is not a required product component. Never expose unauthenticated public setup.
- Verify current container/guest protocol compatibility, initialization retry behavior and recovery from an incomplete setup. Retain immutable runtime/image inputs. Upgrade the deployed checkpoint only after a protected database/configuration backup, run required migrations explicitly and verify the same customer app afterward. Do not invent an upgrade path from a version that never shipped that configuration.
- Run control PostgreSQL backup/WAL archival and gateway configuration/certificate backups on the chosen real host. Prove restoration in isolation with independently recovered bootstrap encryption material, backup keyring, image signing metadata and CA material. A VM disk backup alone is insufficient.
- Use the existing external generation and execution lease. Fence old processes and their provider/signing/storage mutation access, reconcile owned provider resources and post-checkpoint effects, then resume the chosen control instance. Restored revoked credentials and old backup schedules must not become live authority.
- Close recovery states actually encountered by the supported customer path. Give unresolved provider attempts a concrete operator evidence/closure procedure. Never bypass the recovery gate, force a DB-ready flag or expand a retry budget to make a drill pass. Remaining unsupported states must remain explicit blockers for their affected operations, not a claim of universal recovery.
- Add a small operator status/check command or existing-service probes covering queue age, stuck/unknown operations, real provider ownership, reservation age, public app/API HTTPS, guest/gateway/CA certificate expiry, disk headroom, backup age and failure, and control backup freshness. Keep identifiers and outcome codes; exclude customer code, commands, tokens and data.
- Provide actionable degraded-protection status to the customer through existing API/CLI observations. Document the operator incident/contact path for the invite-only preview. Configure any external email/chat notification destination only with the owner's authorization; do not send messages as part of this plan.
- Exercise worker termination, API outage, public-gateway restart and the host reboot in a bounded maintenance window. Existing apps should survive management outages; one gateway/host outage may interrupt HTTP and must be measured and disclosed. Check certificate renewal using real configured identities without repeatedly issuing new public certificates.
- Keep a deployment ownership inventory and a deadline-aware operator cleanup/reconciliation process independent of the individual test client. Expiry is not proof of deletion. Cleanup must match exact recorded IDs and preserve non-test customer data. Record manual escalation if provider uncertainty prevents removal.
- Document host/guest security updates, pinned dependency/image updates, canary verification, reboot policy, major database upgrades and root-modification limitations. Keep security reporting, contribution guidance and original dependency notices already shipped.

For low-cost verification, restore control state on an isolated local/native target first and run only the unresolved live credentials/network/provider portion on paid infrastructure. This is engineering verification; the delivered customer experience remains the real cloud. Separate a production host from recovery test targets. Never run two active control installations against independent copies of the same authority.

## Milestone 6: finish the agent-facing release

**Acceptance:** an existing coding agent in a fresh environment completes deployment, update, backup, source-loss restore, revocation and cleanup using only the public release, the example, the service URL and a scoped customer credential. The operator does not intervene to patch records or execute a hidden customer step.

- Update the one published agent skill and concise customer walkthrough to match actual commands, failure states, costs and supported recovery scope. Preserve user authorization, idempotency keys, expected versions and private credential handling. Skill installation remains explicit and path-specific.
- Give that agent a normal task, not a transcript of the implementation: deploy the example, return HTTPS, preserve its marker through an update, install analytics, recover it from the selected backup and clean up within its granted policy. Missing permissions must produce a clear refusal, not an internal workaround.
- Run from a downloaded signed artifact outside the repository with no development credentials. Use another clean session for reconnection/recovery. This is a bounded product acceptance run, not a new agent framework or ongoing evaluation project.
- Fix concrete interface/docs failures in the existing layers. Run focused checks, required integration for changed behavior, then publish a new immutable CLI/runtime release only when needed. Never overwrite the existing preview tag or assets.
- Keep the public frontend to a small setup/status/documentation entry point if useful. GitHub device login and CLI account operations already cover the essential preview flow. No dashboard build is a release prerequisite.
- Publish the real endpoint, supported region/type, sample commands, service limitations, current evidence and cleanup instructions. Distinguish a currently running demo from historical verification and state its expiry if bounded.

The agreed scope is complete only when this acceptance passes and the operational recovery obligations above have evidence or a clearly delimited unsupported behavior consistent with the original preview promise. A blocked required step is still unfinished work.

## Files and ownership

Keep existing boundaries. Names marked **new** are proposed additions, not commands or files available today. Add a new module only when the connected change needs it.

```text
examples/full-stack/                         NEW packaging of the existing reference app
  README.md, compose.yaml, Dockerfile(s)
  backend/, frontend/, private-context preparation
apps/control/src/
  customer-main.ts, control-recovery-main.ts  existing operator entrypoints
  customer-login.ts                          existing admission and identity
  customer-runtime.ts, runtime-config.ts      existing image/runtime selection
  hosting*.ts, backup*.ts, control-recovery*   existing runtime and recovery
apps/cli/src/                                existing commands; fill demonstrated UX gaps
packages/contracts/, sdk/, db/               existing contracts/storage; migrations only as needed
packages/guestctl/, remote/, images/         existing guest Compose/run/backup/identity
packages/recipes/                            existing PostgreSQL/Umami assets and manifests
packages/hetzner/, backup-store/, pki/        existing provider/crypto transport boundaries
apps/public-gateway/, access-gateway/        existing gateway ownership and renewal
infra/compose/customer.yaml                  finish supervision and role mounts
infra/container/                            package installer and current runtime
scripts/setup-*.ts, image-build.ts           existing operator setup/publication commands
scripts/customer-acceptance.ts               optional thin driver reusing existing scenarios
tests/                                      focused gap regressions, reuse current fixtures
skills/agent-cloud/SKILL.md                   customer agent workflow
docs/customer-quickstart.md                  NEW short real-cloud user walkthrough
docs/self-host-customer.md                   canonical installation/upgrade procedure
docs/COMPLETION_PLAN.md                      this remaining delivery plan
docs/CONTEXT.md                              sole current-state handoff
```

The acceptance driver invokes the actual published CLI and public application. It may manage an exact-owned disposable fixture and write a private continuation receipt; it may not insert successful customer states in SQL, bypass GitHub verification, call internal deployment endpoints or patch a guest to conceal a product failure. Its receipt contains source/artifact revisions, request IDs, provider ownership, deadline, caps and pending cleanup. Keep tokens/key material separate. A restart resumes the recorded operation rather than repeating paid setup.

## Verification and delivery loop

For each connected capability, state the acceptance condition, inspect the relevant code, implement the smallest sound change, run focused checks and exercise the actual CLI/API/application. Fix concrete failures, run required checks, commit, and continue. Do not repeatedly stop after adding a contract or helper when the remaining wiring is available.

| Concern                          | Conclusive check                                                                               | Where to spend provider time                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Public login and access          | Real device approval, scoped credential, forbidden account requests, revocation closure        | Final hosted service; reuse one application VM                                                |
| Provisioning and ownership       | Current signed image, enrolled identity, exact VM/IP/backups/readiness, independent cleanup    | One sequential builder/verifier publication and bounded customer lifecycle                    |
| Updates and persistence          | Browser/API marker before/after update, failed-release recovery, guest reboot                  | Same customer VM                                                                              |
| HTTPS/domain ownership           | Real DNS/certificate chain, wrong-host refusal, retained routes after control outage           | Same gateway and customer VM                                                                  |
| Provider uncertainty/concurrency | Independent provider-state fixtures, crash/delayed-response boundaries, locks and reservations | Live only for a demonstrated provider-specific discrepancy                                    |
| Protected storage                | Exact identity allow/deny, retention/version observation, encrypted restore                    | Tiny permission fixtures plus one bounded app backup                                          |
| Source-loss recovery             | Source provider absence, isolated target data/files, safe cutover, new write                   | Delete source before target where possible; brief two-VM overlap only for live-source fencing |
| Platform recovery                | Restored DB plus independent keys, external fencing, reconciliation, no stale authority        | Local/native first; bounded real topology/credential drill for remaining concerns             |
| Agent usability/self-hosting     | Clean environment and published artifacts, no private history or hidden operator intervention  | Reuse the already configured preview within its budget                                        |

Existing meaningful checks for secrets, authorization, concurrent admission, idempotency, interrupted work, ownership, data persistence and recovery remain. Use `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>`. Source checkpoints require `check`, `format:check` and relevant integration. CI already distinguishes documentation-only changes and cancels obsolete runs. Do not redesign it or rerun unchanged full suites for this plan, a review or a fast-forward. Do not run builds concurrently in one checkout; production dependency packaging stays in an isolated copy.

Use one implementation stream. A consequential security/concurrency/recovery change gets one focused independent review with named files, concrete questions and a stop after blockers are resolved. No repeated architecture competition, broad audit or document-based milestone loop.

Record one short acceptance result per milestone with references to retained redacted evidence. Update the handoff at meaningful checkpoints and before compaction. Historical detail belongs in git or subsystem documentation; do not clone current status across files. Report progress as “the customer can now do X,” qualified by local/native/live evidence where necessary.

## Budget, resource lifetime and external dependencies

The last recorded provider inventory reported zero development servers, Primary IPs, snapshots, firewalls and SSH keys. It is historical, not a fresh inventory for this planning change. Recheck before paid work. Preserve the existing local development DB, CA and runtime identity; their locations and cleanup obligations are in the handoff.

| Item                                       | Existing authority or missing input                                                  | Execution rule                                                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image VM/IP cap                            | Recorded `120000` USD millionths, or $0.12, in the previous bounded image scenario   | Preserve its exact existing admission semantics; do not multiply it into unrestricted repeated builds                                                      |
| Customer VM/IP cap                         | Recorded `60000` USD millionths, or $0.06, in the previous bounded customer scenario | Use actual current quote including automated backups; add no hidden fallback or unapproved overlap                                                         |
| Retained image storage                     | Recorded monthly ceiling `1000000` USD millionths, or $1.00                          | Record snapshot ownership/expiry and pins; never delete an image under an unresolved create                                                                |
| Persistent platform host and hands-on demo | No ongoing host/demo budget or lifetime recorded                                     | Prepare a concrete current quote and reuse authorized infrastructure if available; obtain only the missing recurring-spend/lifetime decision before rental |
| Protected object storage                   | No approved storage cap or actual hourly/minimum billing quote recorded              | Obtain provider quote and exact cap before creation; include retention that can outlive the test                                                           |
| Domains/DNS                                | No chosen permanent control/application domain recorded                              | Check available authorized DNS access; ask only for an unavailable domain choice/delegation, without purchasing speculatively                              |
| Hetzner VM API                             | Existing development-project token is recorded                                       | Use read-only preflight, then exact-owned bounded mutations; default project remains untouched                                                             |
| GitHub                                     | OAuth app and successful browser sign-in are recorded                                | Reuse them. A fresh device flow still requires the customer's GitHub approval; never substitute CLI/operator credentials                                   |
| Hetzner console/storage setup              | Prior handoff records an expired console session and locked Mac                      | Recheck only when progressing that setup. Continue example/install work independently; do not treat the old observation as a permanent current blocker     |
| Independent recovery copy                  | Actual destination and successful recovery are not established                       | Use an owner-approved protected location outside the platform host; record retrieval proof without exposing private material                               |

These are recorded caps, not updated price claims or an invoice. Prices must be refreshed at execution and must use the account's currency. An API admission cap cannot stop upstream billing while resources remain. Record host count, quote, run deadline and maximum exposure before each paid scenario. Stop admitting new effects when the cap/deadline is reached and prioritize exact cleanup. Do not delete customer data merely because a temporary spending or management limit has been reached.

Keep one platform host and one customer VM during ordinary preview verification. Builder and verifier VMs run sequentially and are removed after publication. A restore can delete the disposable source before creating the target; allow two customer VMs simultaneously only for the explicitly bounded live-source cutover test. No expensive machine, warm pool, provider benchmark or arbitrary region/type substitution.

Cleanup after a test is not the same as leaving a service available for the user. Before a hands-on demonstration, give the owner the exact continuing cost/lifetime decision if it is not already authorized. After a disposable test, say that the URL is gone. Locked backup objects remain an explicit cost and cleanup obligation until their exact versions can be deleted.

## Completion checklist

- [ ] A public customer endpoint runs independently of the developer laptop.
- [ ] The owner signs in using real GitHub identity and can delegate one project without internal access.
- [ ] A normal published frontend/backend/PostgreSQL example deploys through the released CLI to a real Hetzner VM.
- [ ] Trusted HTTPS, client disconnection, logs, update and persistence work; the user receives an actual usable walkthrough.
- [ ] SFTP, durable commands, grant revocation, competing mutations and failed-release recovery have connected evidence.
- [ ] Managed/custom domains, private PostgreSQL and actual Umami instrumentation work through customer access.
- [ ] Provider automated backups and protected Hetzner storage permissions are verified; daily protection and retained-byte limits are observable.
- [ ] The source VM can be lost and the app recovered to an isolated replacement with correct data, safe cutover and a new successful write.
- [ ] Independent recovery keys, control restore/fencing, certificate renewal, host restart, monitoring and exact cleanup have appropriate evidence.
- [ ] A fresh self-host installation and supported upgrade use public files and explicit private inputs without hidden state.
- [ ] A fresh existing-agent session completes the agreed workflow from published artifacts and customer authority alone.
- [ ] Active resources, any retained objects, actual blockers and unsupported behaviors are accurately recorded; no required blocked capability is called complete.

Start with milestone 1: configure and run the existing customer stack, package the existing reference app for ordinary use, and verify the existing CLI path through a real customer login. Deliver that usable result before expanding the remaining recovery work.

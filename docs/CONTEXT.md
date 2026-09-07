# Current handoff

Updated2026-09-07. The full non-Stripe goal remains active. User authorizes implementation, private GitHub pushes and bounded cheap Hetzner tests. Deliver connected customer capabilities. Do not expand prerequisites.

## What works

- **First internal deployment live verified:** existing identity → product CLI provisions CPX12 → frontend/backend/PostgreSQL → public HTTPS → disconnect/reconnect → status/logs → update preserving data → destroy and verified cleanup. Source4d2bffa and cleanup correction86b6b1b passed Linux CI. Public evidence: `docs/reference-deployment-verification.json`. The historical URL is no longer live.
- Signed image build, guest enrollment, SSH health, lifecycle operations, renewal and exact owned cleanup. Budget admission and current delegated authority are enforced by control. Provider IP detachment lag now remains in verification with its reservation retained; foreign assignments remain blocked.
- **Delegated CLI access locally verified:** `grant create/list/revoke`, selected-project authority, escalation denial, descendant revocation, pagination,0600 exclusive credential delivery and lost-response recovery. Secrets/hashes are absent from listing. Credential directory entries are synced before issuance. Commit055c2e8 and Linux CI34150610928 passed.
- **Customer SSH and file transfer locally/native verified:** actual CLI → HTTP API → PostgreSQL/Graphile issuer → separate gateway → Smallstep/native SSH on Ubuntu. Sudo and SFTP round trip with spaces passed. Revocation closed the CLI in4611ms; API outage in14663ms. Revoked credentials cannot reconnect; the guest file remains. Successful `pnpm smoke:access` cleaned its VM, database, API, worker, gateway and scratch. OrbStack inventory is empty. This capability is not yet verified through Hetzner.

## Current checkpoint and next acceptance scenario

Customer access is connected and the source checkpoint has passed required local checks. It reuses migration0020 and the existing single-attempt signer. API/gateway are available only in configured customer mode. Internal reference access remains separately limited to its configured root grant. The gateway has no database/provider/CA credentials. Access-capable signed images carry optional `customerSsh:1`; old images remain valid without customer access. Operator configuration and protocol details are in `docs/architecture/customer-ssh.md`; commands are in the customer skill.

Next: an authorized agent submits a durable command, disconnects, reconnects and reads its saved result/output; replaying the same invocation cannot repeat a migration. Cancellation and a guest restart must give an explicit result without automatic replay. Reuse guestctl, native customer SSH and systemd. Then connect general Compose deployment/recovery and hosting through those working paths.

## Verification and lessons

- `.local/customer-access-native-5.log`: complete actual native acceptance and cleanup, exit0. Guest image digest `c47eb417b27d3e497486c0732896b594ec370d6480d07ab3775f484931a387eb` is immutable.
- Earlier native failures found Ubuntu's repeated `allowusers` lines/trailing subsystem whitespace and OrbStack's inbound alias differing from actual SSH egress. Parser regressions pass; the fixture now observes one real guest TCP peer. No staged image bytes were patched.
- Bounded security review fixed local OpenSSH option injection with `--` before hostname and allowed exec-only grants to inspect their own sessions. Ancestor inspection still requires read permission.
- The outage scenario found the hidden proxy waiting for duplex stream closure while SSH kept stdin open. It now exits on WebSocket closure. Actual child-process regressions failed before/passed after with stdin open. Separate actual gateway testing confirms the15s cutoff. Gateway protocol tests cover denied authority, malformed upgrade cleanup, binary forwarding, invalid frames and byte limits.
- `.local/customer-access-check.log`: earlier full493-test/typecheck/lint pass. Final `pnpm check` passed507 tests across47 files, typecheck and lint after the proxy fix in `.local/customer-access-check-final.log`. Final formatting passed `.local/customer-access-format.log`. `pnpm db:check` verified all21 immutable hashes in `.local/access-db-check.log`. No migration was added.
- Commit/push this verified access checkpoint, inspect Linux CI once, then continue durable commands. Do not rerun unchanged broad suites for documentation, review or an unchanged commit.

## What remains

Browser/device customer login; durable commands; general Compose deployment and recovery; routes/domains; database/analytics recipes; protected backups and isolated restore; remaining limits/usage; self-hosting; discoverable agent documentation; budget-appropriate failure verification. Delegation, revocation and file transfer are now connected. Do not mistake the first deployment or access checkpoint for product completion.

## Resume commands and resources

Repository `/Users/yahorbarkouski/Documents/ChatGPT/learning/agent-cloud`, branch `yahor/agent-cloud`, private origin `yahorbarkouski/agent-cloud`. Use `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>`. Required coherent source checks: `check`, `format:check` and relevant actual-path integrations. Native smokes are sequential. `smoke:access` and `smoke:reference` use one owned local Ubuntu VM and preserve it only on failure.

**No paid or local VM resources remain.** Hetzner project `agent-cloud-development`15945891 was verified empty after the live reference scenario; subsequent access work made no provider calls. Live reservations are zero. All six temporary live processes stopped. Private token `.local/hcloud-token`; Default project untouched. Prior live DB was privately archived under `.local/archives/` and dropped; the dump was listed, not restored.

Main local PostgreSQL17 container `agent-cloud-dev-postgres-1` uses localhost55439, DB`agentcloud`. Native CA container `agent-cloud-pki-ca-1` uses https://localhost:9449; original keys remain in `.local/pki` and `.local/runtime-identity`. Never print raw CA logs or credentials. Main simulated API PID15176/session25749 on4319 and worker PID15190/session89064 still run older loaded code; restart when needed. No access fixture service remains.

Existing live caps: image VM/IP120000µUSD, customer VM/IP60000µUSD, snapshot monthly1000000µUSD. First scenario estimated VM/IP cost83394µUSD (~$0.0834), excluding snapshot storage; not an invoice. Future paid checks still require exact ownership, deadlines, these caps and cleanup. Do not rent expensive machines or benchmark providers.

No user action blocks implementation. Preserved untracked drafts in `.local/customer-ssh` are historical and must not become prerequisites. Read subsystem docs for details; `docs/archive/` preserves history, not a second current status.

# Current handoff

Updated2026-09-07. The original non-Stripe goal remains active. The user authorizes implementation, private GitHub pushes and bounded cheap Hetzner tests. Deliver connected customer capabilities, keep one primary stream and do not expand prerequisites. Read AGENTS.md for durable rules.

## What works

- **Live Hetzner deployment:** internal identity → CLI provisions CPX12 → frontend/backend/PostgreSQL → public HTTPS → disconnect/reconnect → logs → update preserving data → destroy and verified cleanup. Source4d2bffa plus cleanup fix86b6b1b passed Linux CI. Evidence: `docs/reference-deployment-verification.json`. Historical URL is deleted.
- Signed image build, enrollment, pinned SSH health, lifecycle operations, renewal, quotas and exact owned cleanup. Provider IP detachment lag retains its reservation until absence; foreign assignment stays blocked.
- **Delegation:** CLI grant create/list/revoke, scoped authority, escalation denial, descendant revocation and0600 exclusive credential delivery with lost-response recovery. Commit055c2e8 passed Linux CI34150610928.
- **Customer SSH/SFTP:** actual CLI/API/Graphile/gateway/Smallstep/native Ubuntu path, sudo, file round trip, revocation in4611ms and outage closure in14663ms, with retained guest data and complete cleanup. Commit45a3f8a passed Linux CI34154296690. Native evidence `.local/customer-access-native-5.log`. This capability is locally/native verified, not yet Hetzner verified.
- **Durable commands:** actual CLI submit/inspect/logs/cancel through authenticated SSH and guest systemd passed. CLI exited while work continued; replay executed once; logs and typed conflict errors were recovered; cancellation worked; timeout reaped a detached helper; actual reboot returned interrupted without replay. Evidence `.local/durable-runs-native-2.log`, exit0. All temporary resources cleaned. Source checkpoint is ready for commit/push.

## Next acceptance scenario

Commit/push the verified durable-command change, then connect general Compose deployment and hosting. An authorized agent should apply a normal Compose application, inspect health/logs, update it while retaining PostgreSQL data and recover a failed release. Reuse working customer SSH, file transfer, durable commands and reference application components. Keep internal reference access separate from customer features.

Dedicated run HTTP endpoints remain unfinished: current commands use CLI → existing access API/gateway → guestctl. Continue connecting the original API scope; do not claim every planned endpoint exists. Command semantics, limits and implementation details are in `docs/architecture/durable-commands.md`; access configuration is in `docs/architecture/customer-ssh.md`.

## Checks, evidence and lessons

- Final durable source check passed515 tests across48 files, typecheck and lint: `.local/runs-check-final.log`. Formatting passed `.local/runs-format-final.log`. No migration was added; all21 existing hashes were verified in `.local/access-db-check.log`.
- Latest locally booted immutable image: `f2bfe3e5720981fc47f4043dd035b2349f1398c44d678ae8a7adc6c45479ead6`. Never patch staged image inputs. Source checkpoints require `pnpm check`, `format:check` and relevant actual-path integration. Do not repeat unchanged broad suites for docs, reviews or unchanged commits.
- Bounded access review fixed native SSH option injection and exec-only session inspection. Native failures fixed Ubuntu SSH output parsing, actual OrbStack egress discovery and proxy shutdown while stdin remains open. Source regressions plus actual CLI checks cover them.
- Bounded command review fixed initial directory-entry fsync and detached output pipes delaying timeout. Expected command errors now use structured stdout replies; SSH stderr remains transport diagnostics. No third review blocker. Invocation receipts precede spawn; uncertain commands never replay. Root can tamper with guest diagnostics, so they are not billing/security authority.

## What remains

Browser/device sign-in; dedicated command HTTP endpoints; general Compose deployment/recovery; routes/domains; database/analytics recipes; protected backups and isolated restore; remaining limits/usage; self-hosting; discoverable agent documentation; budget-appropriate operational failures. The first deployment and these checkpoints are not product completion.

## Resume and resource ownership

Repo `/Users/yahorbarkouski/Documents/ChatGPT/learning/agent-cloud`, branch `yahor/agent-cloud`, private origin `yahorbarkouski/agent-cloud`. Use `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>`. VM smokes are sequential: `smoke:access`, `smoke:runs`, `smoke:reference`. A failed VM is preserved in `.local/guest-image-machine.json`; inspect/delete only its exact recorded name.

**No paid or local VM resources remain.** OrbStack inventory is empty. All access/run fixture services, databases and scratch are cleaned. Hetzner project `agent-cloud-development`15945891 was verified empty after the live scenario; subsequent work created no provider resources. Live reservations are zero and all six temporary live processes stopped. Token `.local/hcloud-token`; Default project untouched. The old live DB was privately archived then dropped; that dump was listed, not restored.

Main local PostgreSQL17 container `agent-cloud-dev-postgres-1` uses localhost55439, DB`agentcloud`. Native CA `agent-cloud-pki-ca-1` uses https://localhost:9449; preserve original keys in `.local/pki` and `.local/runtime-identity`. Never print raw CA logs or credentials. Main simulated API PID15176/session25749 on4319 and worker PID15190/session89064 still run older loaded code; restart when needed.

Live caps remain image VM/IP120000µUSD, customer VM/IP60000µUSD, snapshot monthly1000000µUSD. First scenario estimated VM/IP cost83394µUSD (~$0.0834), excluding snapshot storage; not an invoice. Future paid tests need exact ownership, deadlines, these caps and cleanup. No expensive VMs or benchmarks.

No user action blocks implementation. Preserved `.local/customer-ssh` drafts are historical, not prerequisites. Subsystem docs own details; `docs/archive/` preserves history without duplicating current status.

# Current handoff

Updated 2026-09-07. The original non-Stripe goal remains active. The user authorizes implementation, private GitHub pushes and bounded cheap Hetzner tests. Deliver customer capabilities in one primary stream; read AGENTS.md for durable rules.

## What works

- **Live internal deployment:** cheap CPX12 → frontend/backend/PostgreSQL → public HTTPS → disconnect/reconnect → logs → update preserving data → destroy and verified cleanup. Source 4d2bffa and cleanup fix 86b6b1b passed Linux CI. Evidence: `docs/reference-deployment-verification.json`; its historical URL is deleted.
- **Delegated credentials:** CLI create/list/revoke, scoped authority, escalation denial, descendant revocation and exclusive 0600 credential delivery with lost-response recovery. Source 055c2e8 passed CI 34150610928.
- **Customer SSH/SFTP:** actual CLI/API/Graphile/gateway/Smallstep/native Ubuntu path. Sudo and file round trip passed; revocation closed SSH in 4611 ms and API outage in 14663 ms, with retained guest data and cleanup. Source 45a3f8a passed CI 34154296690. Evidence `.local/customer-access-native-5.log`.
- **Durable commands:** CLI submit/inspect/logs/cancel, disconnect survival, duplicate executed once, typed conflict, cancellation, timeout reaping a detached helper and reboot interruption without replay. Source 39c5922 passed CI 34156526769. Native evidence `.local/durable-runs-native-2.log`, exit 0, cleanup complete.
- **General Compose deployment/recovery:** delegated customer CLI uploads a local context, starts three healthy services, verifies HTTPS, reads logs, updates a PostgreSQL counter and recovers an earlier code/config release after a deliberately unhealthy attempt. Evidence `.local/compose-native-2.log`, exit 0. Actual CLI/API/gateway/SSH/systemd/Docker/Caddy/PostgreSQL; no internal deployment endpoint. All fixture resources cleaned. Source checkpoint is ready to commit/push.

Customer access, commands and general Compose are locally/native verified, not yet Hetzner verified. Signed images, enrollment, lifecycle, renewal, exact owned cleanup and quotas remain working foundations. Guest records are customer diagnostics, never billing or authorization evidence.

## Next acceptance scenario

Commit/push the verified Compose capability, then connect customer browser/device sign-in. An approved customer should authenticate with GitHub, receive a bounded cloud credential, delegate it to an existing agent, use the customer API and revoke that agent. Keep internal identity access separate. Use the existing grants/ancestry/account limits instead of another authorization system. GitHub supports device flow and PKCE; official documentation was checked. No sign-in source changes have been made yet.

The user has just signed into GitHub in the in-app browser. Continue registering the product OAuth application and connecting actual device sign-in. Existing `gh` CLI access also works. No OAuth application, client ID or secret has been created yet; no user action currently blocks implementation.

## Verification and lessons

- Final Compose source checks passed **523 tests / 49 files**, typecheck and lint: `.local/compose-check-final.log`. The native scenario passed before equivalent lint adjustments and a separately tested UTF-8 input decoder correction; do not claim it booted a later byte-identical image. The decoder preserves Unicode split across SSH chunks and enforces input byte limits. Final formatting passed `.local/compose-format-final-2.log`; the final verified build is `.local/compose-final-build-2.log`, digest `0f0be4daadf3bd59a5fd1db281f5f75331eec31b1cb9be1eef551b7741b23774`.
- Last natively booted immutable image: `0971b671e0502f514d50b363043ebec95107066033cd6d782b281993bbab9df4`. `.local/guest-build.json` selects the latest separately verified build; never patch staged inputs. No migration was added; all 21 existing hashes were last verified in `.local/access-db-check.log`.
- One bounded recovery review found three concrete issues, all fixed with focused checks: image-declared anonymous volumes could lose their association during recovery; nested source-directory entries needed fsync; case-sensitive service names needed distinct build tags. The first native fixture failed on invalid Caddy block syntax, was corrected and validated with Caddy, and its exact VM was deleted. The second scenario passed.
- Compose semantics and limits: `docs/architecture/compose-deployment.md`. Command semantics: `docs/architecture/durable-commands.md`. Access configuration/leases: `docs/architecture/customer-ssh.md`. README and customer skill describe the connected commands. No additional broad review is pending.

## What remains

Customer sign-in; dedicated command HTTP endpoints (current run/Compose CLI uses the access API and guest SSH helper); managed routing/domains; database/analytics recipes; protected backups and isolated restore; remaining limits/usage/retention; self-hosting; discoverable agent API documentation; budget-appropriate operational failures and a final customer live deployment. The internal live deployment and these capabilities are checkpoints, not product completion.

## Resume and resource ownership

Repo `/Users/yahorbarkouski/Documents/ChatGPT/learning/agent-cloud`, branch `yahor/agent-cloud`, private origin `yahorbarkouski/agent-cloud`. Use `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>`. Source checkpoints require `check`, `format:check` and relevant integration; do not repeat unchanged full suites for documentation, reviews or fast-forwards. VM smokes are sequential: `smoke:compose`, `smoke:runs`, `smoke:access`, `smoke:reference`. Failure preserves its exact VM in `.local/guest-image-machine.json`.

**No paid or local VM resources remain.** OrbStack inventory is empty; both Compose fixtures and their API/worker/gateway/database/scratch are cleaned. Hetzner project `agent-cloud-development` 15945891 was verified empty after the live scenario. Subsequent work made no provider calls. Live reservations are zero; temporary live processes stopped. Token `.local/hcloud-token`; Default project untouched. The old live DB was privately archived and dropped; its dump was listed, not restored.

Main local PostgreSQL 17 container `agent-cloud-dev-postgres-1` uses localhost 55439, DB `agentcloud`. Native CA `agent-cloud-pki-ca-1` uses https://localhost:9449. Preserve original keys in `.local/pki` and `.local/runtime-identity`; never print raw CA logs or credentials. Main simulated API PID 15176/session 25749 on 4319 and worker PID 15190/session 89064 still run older loaded code; restart when needed.

Live caps remain image VM/IP 120000 µUSD, customer VM/IP 60000 µUSD and snapshot monthly 1000000 µUSD. First scenario estimated VM/IP cost was 83394 µUSD (~$0.0834), excluding snapshot storage; not an invoice. Future paid tests require exact ownership, deadlines, these caps and cleanup. No expensive VMs or benchmarks. Historical `.local/customer-ssh` drafts are preserved and are not prerequisites.

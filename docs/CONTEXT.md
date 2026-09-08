# Current handoff

Updated 2026-09-08. Work on `yahor/agent-cloud` under AGENTS.md. Continue the existing TypeScript/Hetzner/Compose product for customers' agents, without Stripe. The old goal-tool blocked state is stale.

## What works

**The customer deployment path passed on real Hetzner infrastructure. No persistent service remains.** The published CLI used real GitHub approval against a hosted platform, provisioned CPX12 and deployed the ordinary frontend/backend/PostgreSQL example over trusted HTTPS. Browser data survived CLI exit, update, failed-build recovery and customer/platform reboots. Scoped read access, denied creation, revocation, logout and destruction passed. Automated VM backups were enabled; restoration was not tested. See the [walkthrough](customer-quickstart.md) and [verification](customer-deployment-verification.json).

`0737a78` packages existing setup commands, private CA, supervision and the example. `c2ea540` fixes the live SQL rejection of customer SSH image identity/proof and excludes SQL parameters from worker logs. Login, lifecycle, SSH/SFTP, durable commands, Compose, hosting, recipes, protected backups, restore, usage and control recovery already have connected implementations. Reuse them.

Local source checks passed: typecheck/lint, 764 tests, formatting and focused failing-before/passing-after regressions. The live run used that runtime. `pnpm db:check` matched all 29 migrations against an isolated restored copy of the final hosted DB; that copy was deleted. CI 0737 run 34225198701 and CI c2ea run 34228723656 passed, including required integration checks. The following documentation checkpoint uses lightweight CI. Do not rerun unchanged comprehensive local checks.

## What remains and next acceptance

[COMPLETION_PLAN.md](COMPLETION_PLAN.md) owns remaining acceptance. The next outcomes are a retained usable preview and provider-backed recovery. Ongoing preview lifetime/budget, permanent domain, protected Hetzner storage permissions/Object Lock/budget and independent recovery material remain unresolved. The optional 24-hour preview question was unanswered; it did not block the authorized disposable test.

Remaining live evidence includes custom DNS, public Umami instrumentation, durable-command interruption/revocation, protected source-loss restore and final platform recovery. An independent fresh-agent usability run and complete public operator setup/upgrade procedure remain. Do not call the entire non-Stripe scope complete.

## Resources, evidence and resume

At 2026-09-08T13:00:51Z, all 13 exact provider resources returned 404/not_found. Development inventory had zero servers, Primary IPs, snapshots, backup images and firewalls. Customer usage showed zero reservations. Image build 9210534e-eb35-4fb5-a512-59c4341ac7b3 reached cleaned. Platform 165139597, customer 165144231 and snapshot 429563896 are absent. No provider cleanup obligation remains.

Private `.local/customer-preview/record.json` owns receipts, caps and cleanup. The verification document hashes the retained CLI/application/check logs. Task drivers invoke the real customer CLI; run shared-record drivers sequentially to prevent stale continuation writes. Do not reuse their deleted resources, expired admissions or revoked credentials.

Owner-only `control-final.dump` and `host-private-final.tar.gz` preserve the final disposable journal/private material. They are local evidence copies, not verified protected backups. Do not start restored mutators without the documented external fence. The private application context and revoked descendant credential remain under `/tmp/agent-cloud-customer-2e6f8dca-f8c0-4cc9-91a0-f88ebf5ee4dc`; logout removed the primary credential. The public CLI v0.1.0 at ce9a0d8 is unchanged; its bundled skill installed successfully.

Commands: `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>`, `gh run view 34228723656`, and read-only `node .local/customer-preview/platform.mjs inspect`. Fresh paid work needs new ownership/admission/expiry records within existing authority. Never replay the old platform create intent.

Preserve main PG `agent-cloud-dev-postgres-1` on 55439, main CA `agent-cloud-pki-ca-1` on 9449, `.local/pki` and `.local/runtime-identity`; main DB remains through 0026. Provider token `.local/hcloud-token` is for development project 15945891; OAuth `.local/github-oauth.json` is app 3843400. Never print secrets/full process arguments. Unrelated Docker services/default Hetzner project are untouched. Preview PKI and identity remain isolated under `.local/customer-preview`; the offline root stayed off the host. Guest manifest 3be19009da79b7620a5e93910d3330d528633277e7f96298fa2d51407ae96a84 remains immutable locally; its provider snapshot is deleted.

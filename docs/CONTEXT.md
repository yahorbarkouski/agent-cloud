# Current handoff context

Updated 2026-09-07. Full agent-cloud goal remains active, excluding Stripe. M0 is complete; M1 and M2–M7 remain open. This continuation made verified progress and is not blocked. No paid cloud resource has been created. Do not mark the full goal complete after an image checkpoint.

## Scope and repository

Customers bring Codex, Claude Code or another coding agent. We build their CLI/API/skills. TypeScript, ordinary Linux VMs, Compose, SSH and Hetzner. Keep costs low; no benchmarks, expensive plans, warm pool or automatic size/region fallback. Continued implementation, private GitHub pushes and Hetzner setup are authorized.

Work only in `/Users/yahorbarkouski/Documents/ChatGPT/learning/agent-cloud`, standalone Git inside an unrelated workspace. Branch `yahor/agent-cloud`; private origin `https://github.com/yahorbarkouski/agent-cloud.git`. Implementation **5445f410f34d73aa8810a9b77b230defec28ff84** is committed and pushed. The verifier evidence/context documentation checkpoint is complete. **Linux CI 34094753361 passed in 3m11s** against that implementation, including frozen install, all checks, fresh PKI, native PKI/SSH/enrollment and cleanup. Final gpt-5.6-sol artifact/trail review found no implementation blocker. Its evidence-reference corrections are applied; report `docs/research/m1-image-verifier-review.md`.

## Implemented foundation

Contracts/Zod, PostgreSQL/Drizzle, Hono/Graphile, SDK and JSON CLI. Tenant grants/delegation/revocation, idempotency, quotas, gross currency/VM/IPv4 prices and pinned offers. Customer journals own IP before VM, persist intent before external I/O, never retry unknown creates, and release reservations only after authoritative VM/IP absence. Catalog refresh stays outside admission transactions.

Encrypted customer bootstrap, immutable claimed/issued identities, durable signing budgets, pinned provider-address SSH proof and atomic certificate/token-erasure/runtime handoff. Restricted readiness checks image/keys, components, disk, proxy and boot ID; reboot/power-on require a changed boot ID. Thirty-minute customer operation deadlines gate fresh effects and completion. Production `createTasks` still does not supply GuestProvisioning, and live activation remains gated.

## Platform verifier checkpoint

Customer wire version 1 stays allocation-owned. Verifier wire version 2 explicitly names `{kind:'image_verifier',id:ImageBuildId}`. Shared PKI and remote APIs take `subject`. Customer names remain stable; verifier DNS is `verify-<UUID>.guest.agent-cloud.internal`. Credential/proof subjects must match. Guestctl shares atomic keys, certificate installation, cloud-init enrollment and runtime inspection, with metadata at `/var/lib/agent-cloud/guest.json`. Verifier runtime includes Linux machine ID for comparison with the sanitized builder.

Builds use sibling operator journals, never fake customer allocations. The pure image planner dispatches to separately locked provider, builder, verifier and cleanup executors. Builder phases persist before SSH; lost installation responses recover without reinstalling, unknown sanitation requests full abort, and snapshot creation requires saved sanitation plus a confirmed stopped source. Exact effect IDs bind labels, resources and observations. Access is removed only after authoritative cleanup.

New verifier modules own encrypted bootstrap preparation/recovery, public inspection, signing reservations, `/image/enroll` and runtime completion. The exact confirmed snapshot, verifier server/effect and assigned IP bind enrollment. Keys are claimed after pinned direct SSH proof. Signing slots/cooldown survive restarts; issuance and token erasure commit together. Runtime checks actual provider boot source, pinned keys/manifest, healthy component versions, disk/proxy and a machine ID different from the builder. Cancellation/expiry are rechecked in completion transactions. Unconfigured controller callers retain the explicit `verification_required` gate; configured ports reach `verified`. **No live advancement CLI, retained release promotion or production wiring yet.**

## Database and verification

All **15 migrations through 0014** are applied to the base development database; all hashes match, check d2a9ff. **Never edit applied0014 or older migrations.** Latest hash `26b87121b342de36f4f81b33de5be04c0a78882843a9f14c5ec2be52c002c4cd`. 0014 adds build-owned bootstrap, identity, signing and completion records with immutable ownership/evidence guards. Tests create and remove isolated databases.

Evidence: `docs/research/m1-image-verifier-verification.json`. Full check 96323 passed **306 tests in 28 files**, typecheck and lint after the SSH startup fix. Format 60055 passed. Native PKI 99134 and SSH 81642 passed allocation and verifier namespaces. Native customer enrollment 28817 passed lost-response/key/certificate replay and actual TLS/SSH. Post-migration local CLI/API/worker 21371 passed create/inspect/destroy/cleanup for `vm_60f10b89-28b0-4da8-8302-30e1665ac119`. Check abf872 found zero active allocations, simulator servers/IPs and open base image builds.

Native builder 45162 passed the final image with actual SSH/SFTP/cloud-init, lost installation response recovery, sanitation, stopped-source ordering, two customer clone boots and a build-owned verifier. The verifier rejected stopped Docker/proxy, then saved fresh healthy runtime evidence and completed full abort. Cleanup 517b33 confirmed empty OrbStack inventory, no smoke ownership records and empty private fixture directories. **No VM or native smoke remains active.** This is local native execution using protocol provider observations, not Hetzner snapshot proof.

The extra unseeded check in 16223 found a transient port22 listener despite sanitation disabling SSH; sshd had no host key and failed authentication. Diagnosis d7b2eb showed the units enabled again during boot. Sanitation now installs `ConditionPathExists` for the guest host key on both SSH systemd units, preventing startup even if re-enabled. This happens after installation so builder access/recovery stays intact. Manual dc00d5 and fresh 45162 passed. The failed fixture was inspected and its exact VMs/records/private directories removed before the rebuilt run.

OrbStack starts the clone before NoCloud seed installation. The fixture now verifies the unseeded guest has no identity, principals or product listeners, then tests the seeded reboot. It still cannot prove bootstrap injection on the initial provider boot. Keep that distinction when reporting results.

Selected verified public input tree:

- Manifest `dc801bea953d4414bd15755412893f1b837b75424a366596258bf46ee8d25b65`
- Version `dev-c83d20245cffabbe6e61f173`
- Inputs `c83d20245cffabbe6e61f1732426e33dfa760c5fcc05f84ecdd849d18476af8d`
- Transfer checksum `fdc19ce2ee497f7ed9058e47ed6bdc489a8355299ed5716ffe881121af301867`

Only `guestctl.mjs` changed in the final SSH-startup fix. Published `.local/guest-builds/<digest>` trees are immutable. Capture and validate the selected pointer before use; never rebuild or mutate inputs during a VM smoke.

## Local runtime and ownership

Run `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>`. For targeted tests use `pnpm exec vitest run tests/file.test.ts`; `pnpm test -- file` forwards poorly and ran the full suite. Node 24 intended; system 26.5, pnpm runtime 24.10.0.

Docker/OrbStack healthy. PostgreSQL 17 project agent-cloud-dev at 127.0.0.1:55439, db/user agentcloud, password local-development-only. **API 59716** on 127.0.0.1:4319 and **worker 78718** run the current simulated provider code. Inspect process command/cwd before stopping. `.env` uses simulation. `.local/admin.credentials.json` and `.local/hcloud-token` are 0600; never print them or put credentials in argv/guest metadata.

Smallstep `.local/tools/step-0.30.6`, step-ca 0.30.2 digest-pinned, project agent-cloud-pki at https://localhost:9449, 256 MiB / 0.5 CPU. Issuer `.local/pki/issuer`; offline root private/provisioner password stay outside CA mount. Public trust `.local/pki/public`. Preserve keys. The CA template now recognizes both runtime namespaces and forces only guestctl inspect. Certificate renewal and production recovery remain unfinished.

VM ownership paths and native fixture cleanup rules are in AGENTS.md. Builder/image/guest smokes must run sequentially. While a smoke is active, leave VM commands to it; even diagnostic `orb run` can restart a sanitized stopped source. On failure inspect/delete only recorded machines and their exact private fixture directories. Operator key store defaults to `.local/image-access/<buildId>`.

Reviewer `/root/image_release_judge`, gpt-5.6-sol, found no code/SQL blocker, requested the runtime cancellation regression and exposed the Orb seed-timing limitation. Both have code/tests/docs updates; the reviewer also approved the systemd condition fix. Grounding report came from completed gpt-5.5 explainer `verifier_identity_grounding`. No transcript directory was supplied; final review is an artifact/trail audit.

## Next work

1. Implement retained snapshot publication, signed promotion/consumption, certificate renewal/operator recovery and production GuestProvisioning wiring. Existing `packages/images/src/release.ts` authenticates caller-supplied recorded evidence; promotion must construct it from the persisted build/verifier results and current owned snapshot, with a distinct successful retention cleanup path. `cancel` must remain full abort. Keep the full goal active.
2. Then run one bounded cheap Hetzner drill. Last read-only inventory at 04:17:12Z found 0 resources; refresh before paid mutations. Dedicated verified project agent-cloud-development15945891, Ubuntu 24.04 x86 image 161547269. Historical CPX12 + IPv4 price of 27,798 gross micro-USD/hour and snapshot price of 24,477 gross micro-USD/GB-month are not current admission authority. Do not create paid capacity until the complete bounded lifecycle/cleanup is ready.
3. Continue M2 login/customer SSH, M3 transfers/commands/Compose/routes, M4 recipes/off-VM backup/isolated restore, M5 usage/traffic/alerts/cost caps, M6 self-hosting, M7 full end-to-end/failure proof.

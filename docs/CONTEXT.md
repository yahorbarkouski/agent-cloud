# Current handoff context

Updated 2026-09-07. The goal is the full agent-operated cloud in `docs/archive/original-plan.md`, excluding Stripe. M0 is complete; M1 is in progress. Substantial product work remains, so the goal stays active.

## Constraints and repository

Customers bring their existing coding agents. Build the cloud interface, not an agent. Use TypeScript, Linux VMs, Docker Compose, SSH and Hetzner. Keep infrastructure cheap, avoid costly fallback types or provider benchmarks, and maintain AGENTS.md, customer skills, decisions, progress and this summary. Continue authorized work without repeated approval.

Repo `/Users/yahorbarkouski/Documents/ChatGPT/learning/agent-cloud` is a standalone Git repository inside an unrelated parent workspace. Only work here. Branch `yahor/agent-cloud`; private origin `https://github.com/yahorbarkouski/agent-cloud.git`. Enrollment/provisioning checkpoint `12cee632fda2e86b655e052916e81f9bd69d98f4` is committed and pushed. Linux CI `34066756174` passed frozen installation, the 94-test full check, formatting, fresh Smallstep setup, all three native smokes and cleanup. Earlier guest/PKI checkpoint `d70d80f` and its Linux CI `34064759704` passed. Inspect Git state before repeating work.

## Implemented and verified

The TypeScript workspace has Zod contracts, PostgreSQL/Drizzle, Hetzner transport, SDK, Hono API/Graphile worker, JSON CLI, Smallstep PKI and native OpenSSH packages. Tenant isolation, opaque hashed credentials, scoped delegation/revocation, idempotency, optimistic versions, admission locks and allocation reservations work locally.

Price reservations carry explicit currency, gross VM plus IPv4 prices in integer micro-units, and pinned offers. Fresh effects recheck current catalog, grant and account/global limits. Submitted effects reconcile without current capacity. The API now refreshes complete catalog snapshots outside transactions. Expired snapshots cannot admit work; currency disagreement clears the cache.

The immutable effect journal tracks an owned Primary IP before a VM and observes both absent before releasing reservations. Unknown or conflicting submissions block instead of resubmitting or compensating blindly. Migration 0005 preserves all legacy create/resize submission stages. Live API and worker remain gated off.

The new guest slice stores one encrypted token bound to immutable allocation/image/endpoint metadata. Migration 0006 adds immutable claimed/issued guest identity records and rejects invalid certificate fields before token erasure. Preparation, recovery and concurrent/failure cases pass. `docs/architecture/guest-bootstrap.md` owns the selected design. Provider reference commands and enrollment are now connected in the tested control path; preserve legacy command parsing. Live startup stays gated.

`packages/pki` signs through pinned Smallstep. It validates returned key, CA, exact principal/name, privileges and lifetime. SSH keys are Ed25519; guest TLS keys are ECDSA P-256. One-hour host/TLS certificates and five-minute probe credentials are development policies, not a completed renewal solution. The user certificate forces the identity command without forwarding or PTY. TLS leaves are server-only.

`packages/remote` performs bounded SSH identity reads using explicit reusable probe credentials. It ignores inherited SSH config/agents and pins either a proposed raw host key or a host CA. It does not issue credentials during reads. Enrollment must provide a provider-observed IP and compare every proof field. Readiness using host-CA mode must compare against persisted identity.

The previous checkpoint passed 78 tests in 12 files; the current enrollment checkpoint passes 94 tests in 14 files, typecheck/build and strict lint. Real local `smoke:pki` and `smoke:ssh` pass, including wrong allocation/name/key/CA, extra SAN, wrong TLS curve, malformed certificate response and mismatched guest evidence. Configured gpt-5.6-sol independently reran both smokes and inspector test; report `docs/research/m1-bootstrap-review.md`. No real guest VM, application deployment or restore is verified.

Migration 0007 is applied to development, with eight migrations recorded. Restarted CLI/API/DB/worker smoke passed for `vm_c89019a1-3aab-43dc-b0d5-fcfc18b3b197`. SQL confirmed zero active allocations, simulator VMs and IPs. Disposable SSH containers and keys were removed. Customer skill validation and formatting passed. CI now verifies Smallstep setup and all three native smokes.

## Runtime and secrets

- Node 24 LTS intended. Use `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>`; global pnpm is older. Dependencies installed. Build before tests. Do not run simultaneous build commands against shared output directories.
- Dedicated Docker Compose project `agent-cloud-dev`, PostgreSQL at `127.0.0.1:55439`. Tests create/drop unique databases. Never touch unrelated services.
- Ignored `.env` uses simulated provider. `.local/admin.credentials.json` and `.local/hcloud-token` are owner-only secrets. Never print them or pass their values as command arguments.
- API port 4319, exec session 48784; worker session 33358. Both run the new compiled slice. Inspect process command/cwd before restarting.
- `.local/tools/step-0.30.6` is installed from pinned verified official archive. `pnpm setup:step` reinstalls atomically.
- Dedicated local CA Compose project `agent-cloud-pki` is healthy at loopback `https://localhost:9449`. `pnpm setup:pki` preserves identity; `pnpm pki:up` and `pki:down` manage it. State `.local/pki` is owner-only. Root private key is in `offline/`, outside the issuer mount. Provisioner password is outside the mount. Public trust is in `public/`. Do not print any private material or rotate these keys silently.
- Smallstep CA is digest-pinned 0.30.2, CLI 0.30.6. CA image requires NET_BIND_SERVICE to execute its file-capability binary; all other capabilities dropped. It has no-new-privileges and memory/CPU limits.
- `pnpm smoke:ssh` uses a disposable Alpine/OpenSSH container, not a VM image. Its entrypoint copies trust files to root-owned paths for Linux StrictModes.

## Hetzner

Verification and credential setup are complete. Dedicated project `agent-cloud-development`, ID 15945891; Default untouched. RW token `agent-cloud-local-development` is saved in `.local/hcloud-token`. No paid resources have been created.

Account uses USD with 23% VAT. Last durable check `docs/research/hetzner-catalog-check-2026-09-06.json` returned zero VMs/IPs. CX23/CX33/CX43 were unavailable; explicitly configured CPX12 was available at gross USD 0.027798/hour with IPv4. The new runtime also returned these offers at 21:56:37 UTC, but that later observation has no durable artifact. Refresh before any live test, set explicit currency/ceiling/deadline and cleanup, and never silently substitute a more expensive type. Current simulated .env ceiling is EUR .02/hour, not the live configuration.

Read-only check: `PROVIDER_CURRENCY=USD HCLOUD_SERVER_TYPE_SMALL=cpx12 pnpm hetzner:check`. Official API notes are in `docs/research/hetzner-contract-notes.md`; saved spec `/tmp/agent-cloud-hetzner-openapi.json`. No browser action is pending.

## Current enrollment checkpoint

Enrollment service, bootstrap-authenticated endpoint, migration 0007 signing budgets and waiting_guest phases are implemented. Confirmed VM history, authoritative labels and direct SSH proof precede immutable key claims. Issuance, token erasure and runtime handoff commit atomically; replay repairs only the matching enrollment stage. The native PKI signer exposes frozen trust and read-only CSR validation. Enrollment reviewer guest_design_judge (gpt-5.6-sol) passed 9 focused tests; report m1-enrollment-review.md.

New create_guest commands carry a bootstrap reference. The renderer requires the exact prepared attempt, live allocation and pinned offer; it returns the stored image plus cloud-init data only at initial submission. Legacy create remains reconcilable but fresh live legacy submits are rejected. Unknown guest creates never rerender/resubmit. The controller and effect journal recognize both create variants. Real guest boot/service and startup activation are not wired yet.

Composed smoke:enrollment passed real Smallstep/pinned OpenSSH enrollment, wrong-key rejection, same-certificate replay, installed host-certificate SSH and native TLS connections. Provider observations are simulated loopback fixtures, not Hetzner. Shared SSH fixture cleanup removed container/keys and the isolated database. All three native smokes pass. Provider-reference review found no high-confidence blocker; report m1-provisioning-review.md. Full check passes 94 tests in 14 files plus typecheck/build and strict lint. Migration 0007 applied to development with owned services stopped; restarted CLI smoke passed vm_c89019a1-3aab-43dc-b0d5-fcfc18b3b197. SQL shows 8 migrations and zero active allocations/simulated VMs/IPs. API session 48784 and worker 33358 run current built code. Final gpt-5.6-sol trail review passed the four new TSV decisions and independently reran 21 focused tests plus the composed native enrollment smoke. Skill validation and formatting pass. Implementation is committed as `12cee63`; remote CI `34066756174` passed. No paid resource created.

## Next concrete work

1. Committed enrollment checkpoint `12cee63` and Linux CI `34066756174` are complete. Resume actual guest image work. Do not repeat the completed enrollment slice or claim M1 completion.
2. Preserve the distinction between composed local protocol proof and actual VM boot. The renderer calls `agent-cloud-enroll.service`, which the new image must supply. It must consume the root-only bootstrap, generate fresh keys, enroll, install certificates, and erase bootstrap/cloud-init cached copies. Node/TypeScript guestctl and Linux first-boot/sanitation still need implementation.
3. Build/sanitize the actual guest image and guestctl, implement runtime readiness and ongoing certificate renewal. Add owned snapshot cleanup before a bounded cheap image-build/boot test. Implement explicit operator resolution for unknown/duplicate provider effects. Only then enable a bounded live drill. Optional local VM fixture is available through installed OrbStack: `orb create -a amd64 ubuntu:noble <owned-name>` supports cloud-init via `--user-data`; `orb list` currently returned no user Linux machines. Help was inspected only; no VM was created. It can test Linux boot before any paid cloud rental, but does not prove Hetzner-specific behavior.
4. M2: device/browser auth, CLI grants and customer SSH/gateway access/revocation. M3: transfers, durable command runs, Compose deployments and Caddy HTTPS routes. M4: recipes, off-VM backups and isolated restore. M5: usage/traffic/alerts and other cost limits. M6 self-hosting, M7 failure drills and end-to-end proof.

Keep `docs/DECISIONS.tsv` append-only. The show-me-your-work skill requires a different-model trail audit and an Attention note before handback. The existing guest_design_judge agent is configured gpt-5.6-sol and available for a final trail spot-check. No transcript directory is supplied, so do not claim a transcript audit.

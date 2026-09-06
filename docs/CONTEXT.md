# Current handoff context

Updated 2026-09-07. The goal is the full agent-operated cloud in `docs/archive/original-plan.md`, excluding Stripe. M0 is complete; M1 is in progress. Substantial product work remains, so the goal stays active.

## Constraints and repository

Customers bring their existing coding agents. Build the cloud interface, not an agent. Use TypeScript, Linux VMs, Docker Compose, SSH and Hetzner. Keep infrastructure cheap, avoid costly fallback types or provider benchmarks, and maintain AGENTS.md, customer skills, decisions, progress and this summary. Continue authorized work without repeated approval.

Repo `/Users/yahorbarkouski/Documents/ChatGPT/learning/agent-cloud` is a standalone Git repository inside an unrelated parent workspace. Only work here. Branch `yahor/agent-cloud`; private origin `https://github.com/yahorbarkouski/agent-cloud.git`. Resource commit `8f416ba` passed Linux CI `34061962745`; HEAD before this checkpoint is docs commit `7a3f6f6`. Guest/catalog/PKI/SSH checkpoint `d70d80f68eae9ba69482e3824b462214f3077967` is committed and pushed. Linux CI `34064759704` passed frozen installation, full checks, fresh Smallstep setup, both native identity smokes and cleanup. Inspect Git state before repeating work.

## Implemented and verified

The TypeScript workspace has Zod contracts, PostgreSQL/Drizzle, Hetzner transport, SDK, Hono API/Graphile worker, JSON CLI, Smallstep PKI and native OpenSSH packages. Tenant isolation, opaque hashed credentials, scoped delegation/revocation, idempotency, optimistic versions, admission locks and allocation reservations work locally.

Price reservations carry explicit currency, gross VM plus IPv4 prices in integer micro-units, and pinned offers. Fresh effects recheck current catalog, grant and account/global limits. Submitted effects reconcile without current capacity. The API now refreshes complete catalog snapshots outside transactions. Expired snapshots cannot admit work; currency disagreement clears the cache.

The immutable effect journal tracks an owned Primary IP before a VM and observes both absent before releasing reservations. Unknown or conflicting submissions block instead of resubmitting or compensating blindly. Migration 0005 preserves all legacy create/resize submission stages. Live API and worker remain gated off.

The new guest slice stores one encrypted token bound to immutable allocation/image/endpoint metadata. Migration 0006 adds immutable claimed/issued guest identity records and rejects invalid certificate fields before token erasure. Preparation, recovery and concurrent/failure cases pass. `docs/architecture/guest-bootstrap.md` owns the selected design. Provider commands still lack the bootstrap reference; preserve legacy command parsing when wiring it.

`packages/pki` signs through pinned Smallstep. It validates returned key, CA, exact principal/name, privileges and lifetime. SSH keys are Ed25519; guest TLS keys are ECDSA P-256. One-hour host/TLS certificates and five-minute probe credentials are development policies, not a completed renewal solution. The user certificate forces the identity command without forwarding or PTY. TLS leaves are server-only.

`packages/remote` performs bounded SSH identity reads using explicit reusable probe credentials. It ignores inherited SSH config/agents and pins either a proposed raw host key or a host CA. It does not issue credentials during reads. Enrollment must provide a provider-observed IP and compare every proof field. Readiness using host-CA mode must compare against persisted identity.

Latest full check passes 78 tests in 12 files, typecheck/build and strict lint. Real local `smoke:pki` and `smoke:ssh` pass, including wrong allocation/name/key/CA, extra SAN, wrong TLS curve, malformed certificate response and mismatched guest evidence. Configured gpt-5.6-sol independently reran both smokes and inspector test; report `docs/research/m1-bootstrap-review.md`. No real guest VM, application deployment or restore is verified.

Migration 0006 applied locally after stopping owned services. Restarted CLI/API/DB/worker smoke passed for `vm_a07cf525-ab4d-40f8-a4d0-a7de55ef49a0`. SQL confirmed zero active allocations, simulator VMs and simulator IPs. Disposable SSH containers were removed. Customer skill validation passed. Linux CI now verifies Smallstep setup and both smokes; run `34064759704` passed on the implementation commit.

## Runtime and secrets

- Node 24 LTS intended. Use `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>`; global pnpm is older. Dependencies installed. Build before tests. Do not run simultaneous build commands against shared output directories.
- Dedicated Docker Compose project `agent-cloud-dev`, PostgreSQL at `127.0.0.1:55439`. Tests create/drop unique databases. Never touch unrelated services.
- Ignored `.env` uses simulated provider. `.local/admin.credentials.json` and `.local/hcloud-token` are owner-only secrets. Never print them or pass their values as command arguments.
- API port 4319, exec session 59705; worker session 46666. Both run the new compiled slice. Inspect process command/cwd before restarting.
- `.local/tools/step-0.30.6` is installed from pinned verified official archive. `pnpm setup:step` reinstalls atomically.
- Dedicated local CA Compose project `agent-cloud-pki` is healthy at loopback `https://localhost:9449`. `pnpm setup:pki` preserves identity; `pnpm pki:up` and `pki:down` manage it. State `.local/pki` is owner-only. Root private key is in `offline/`, outside the issuer mount. Provisioner password is outside the mount. Public trust is in `public/`. Do not print any private material or rotate these keys silently.
- Smallstep CA is digest-pinned 0.30.2, CLI 0.30.6. CA image requires NET_BIND_SERVICE to execute its file-capability binary; all other capabilities dropped. It has no-new-privileges and memory/CPU limits.
- `pnpm smoke:ssh` uses a disposable Alpine/OpenSSH container, not a VM image. Its entrypoint copies trust files to root-owned paths for Linux StrictModes.

## Hetzner

Verification and credential setup are complete. Dedicated project `agent-cloud-development`, ID 15945891; Default untouched. RW token `agent-cloud-local-development` is saved in `.local/hcloud-token`. No paid resources have been created.

Account uses USD with 23% VAT. Last durable check `docs/research/hetzner-catalog-check-2026-09-06.json` returned zero VMs/IPs. CX23/CX33/CX43 were unavailable; explicitly configured CPX12 was available at gross USD 0.027798/hour with IPv4. The new runtime also returned these offers at 21:56:37 UTC, but that later observation has no durable artifact. Refresh before any live test, set explicit currency/ceiling/deadline and cleanup, and never silently substitute a more expensive type. Current simulated .env ceiling is EUR .02/hour, not the live configuration.

Read-only check: `PROVIDER_CURRENCY=USD HCLOUD_SERVER_TYPE_SMALL=cpx12 pnpm hetzner:check`. Official API notes are in `docs/research/hetzner-contract-notes.md`; saved spec `/tmp/agent-cloud-hetzner-openapi.json`. No browser action is pending.

## Next concrete work

1. The reviewed guest/catalog/PKI/SSH implementation checkpoint `d70d80f` is pushed and Linux CI `34064759704` passed. Resume enrollment and guest integration rather than repeating this checkpoint. Do not claim M1 completion.
2. Connect bootstrap preparation/reference-only provider commands and a narrow enrollment service. Preserve old attempts, including unknown outcomes, without re-submission. Enrollment must verify immutable token/allocation state and direct pinned-key SSH proof at the provider-recorded IP, then claim keys and persist the first certificates. Bound credential issuance with persisted attempts; reuse short-lived credentials within a run. Never trust proxy source headers.
3. Build/sanitize the actual guest image and guestctl, implement runtime readiness and ongoing certificate renewal. Add owned snapshot cleanup before a bounded cheap image-build/boot test. Implement explicit operator resolution for unknown/duplicate provider effects. Only then enable a bounded live drill.
4. M2: device/browser auth, CLI grants and customer SSH/gateway access/revocation. M3: transfers, durable command runs, Compose deployments and Caddy HTTPS routes. M4: recipes, off-VM backups and isolated restore. M5: usage/traffic/alerts and other cost limits. M6 self-hosting, M7 failure drills and end-to-end proof.

Keep `docs/DECISIONS.tsv` append-only. The show-me-your-work skill requires a different-model trail audit and an Attention note before handback. The existing guest_design_judge agent is configured gpt-5.6-sol and available for a final trail spot-check. No transcript directory is supplied, so do not claim a transcript audit.

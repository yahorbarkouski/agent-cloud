# Current handoff context

Updated 2026-09-07. Implement the full agent-operated cloud in `docs/archive/original-plan.md`, excluding Stripe. M0 is complete; M1 is in progress. Keep the active goal open until the product works end to end.

## Scope and repository

Customers bring their own coding agents. Build their CLI/API/skills, not an agent. TypeScript, Linux VMs, Docker Compose, SSH and Hetzner. Keep infrastructure cheap; no provider benchmarks, expensive fallback or warm pool. Maintain AGENTS.md, architecture, progress, append-only decisions and this concise summary. Continue authorized work without repeated approvals.

Repo `/Users/yahorbarkouski/Documents/ChatGPT/learning/agent-cloud` is a standalone Git repository inside an unrelated workspace. Work only here. Branch `yahor/agent-cloud`; private origin `https://github.com/yahorbarkouski/agent-cloud.git`. Runtime implementation ca03da9ef6330357559d06d65eb83dc672a6a6a3 is committed and pushed. Linux CI34071617896 passed frozen install,121-test full check, formatting, fresh PKI setup, all three native smokes and cleanup. Previous guest implementation a43cc32/CI34069508351 also passed.

## Implemented control path

Zod contracts, PostgreSQL/Drizzle, Hetzner transport, SDK, Hono API/Graphile worker and JSON CLI. Tenant isolation, hashed credentials, delegation/revocation, idempotency, admission locks, gross VM+IPv4 integer-currency reservations and pinned offers have local proof. Catalog refresh is outside DB transactions and fails closed on expiry/currency disagreement.

The effect journal persists intent before I/O, owns Primary IP before VM, never resubmits an unknown create and waits for both resources to be absent before releasing quota. Legacy create/resize migrations pass. Live startup remains gated.

Migration0006 stores metadata-bound encrypted bootstrap and immutable claimed/issued guest identities. Migration0007 gives durable12-probe/4-identity signing ceilings. Exact prepared create_guest attempts render cloud-init once. Enrollment verifies confirmed create/ownership/provider IP, CSR and native SSH raw-key proof, then commits issued certificates, ciphertext erasure and runtime handoff together. Lost responses preserve keys/certificates.

## Guest and runtime checkpoint

`packages/guestctl` publishes keys/certificates atomically, validates private/public correspondence and stored certificates on retry, activates SSH/Caddy through actual systemd and erases cloud-init token copies. Explicit chmod handles UMask0077. Cloud-init combined runtime JSON and decoded journals require scanning; the scanner skips FIFOs/symlinks and bounds total bytes.

Public image tooling stages eight checksum-pinned artifacts: Node24.20.0, Smallstep0.30.6, Caddy2.11.4, Docker29.8.0, Compose5.5.1 and Docker dependencies. Ubuntu package versions are recorded, not bit-reproducible. Snapshot sanitation/release is unfinished.

New guestctl inspect reports pinned versions, Docker daemon access, disk headroom, allocation-specific loopback proxy health and boot ID. A separate five-minute runtime SSH certificate forces exactly `sudo -n -- /usr/local/bin/guestctl inspect --json`. Exact sudoers permission, no Docker group/general sudo; identity command stays unprivileged. `packages/remote` requires the matching purpose and host-CA trust for runtime reads.

`guest-readiness.ts` checks current provider ownership, pinned image/keys and runtime evidence. Migration0008 stores immutable consecutive signing attempts with12-attempt per-operation cap. Service cooldown30s survives restart; credentials reused in memory. Create/reboot/power-on require fresh evidence, and reboot/power-on require a changed boot ID. Thirty-minute admission deadline checked before fresh effects and in completion transaction after SSH. Expiry blocks an owned VM; uncertain effects still reconcile; unused IP cleanup still runs. Review found the late-SSH completion race and its regression now passes.

Local evidence: full check121tests/18files, typecheck/lint passed session29425. Native runtime PKI policy passed71057. SSH and enrollment smokes passed97851. Fresh owned Ubuntu smoke46053 passed real cloud-init/systemd, restricted sudo denials, stopped Docker/socket, stopped proxy,32MiB temporary state filesystem, restored readiness, old-boot waiting and actual reboot completion. Token scan135files/18,358,624bytes/no matches. VM deleted; orb list[] and ownership record absent. Image dev-3e7f5c0ea7e8, digestb14b11bdb05883e7af0307a3817f31c047b0fcb10e3b9c382e1381dd0c2834c5. Provider observations simulated; no Hetzner boot claim.

Migration0008 applied after stopping owned API/worker. Restarted CLI smoke73214 passed for vm_d527c4fb-11a0-4b5e-b0cf-dd6e7ebd75c2. DB counts:9migrations,0activeallocations,0simulatedVMs/IPs. Updated customer skill, shell syntax and formatting valid. Different-model artifact/trail review complete; no remaining concrete runtime finding. Implementation commit and CI are complete.

## Local runtime and secrets

- Use `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>`. Node24 intended; system26.5/pnpm runtime24.10.0. Avoid concurrent builds sharing output.
- Dedicated Docker project agent-cloud-dev PostgreSQL17 at127.0.0.1:55439, DB/user agentcloud, local-development-only password. Tests own isolated temporary DBs. Base migrated through0008.
- API exec29969 at127.0.0.1:4319; worker6585, both current code with simulated provider. Inspect command/cwd before stopping.
- Ignored .env is simulated. `.local/admin.credentials.json` and `.local/hcloud-token` are0600. Never print values or pass secrets in argv/guests.
- `.local/tools/step-0.30.6`; healthy CAprojectagent-cloud-pki at https://localhost:9449. Issuer state `.local/pki/issuer`, rootprivate/provisionerpassword outside mount. Public trust `.local/pki/public`. Preserve keys.
- step-ca0.30.2 digest-pinned, NET_BIND_SERVICE only, no-new-privileges,256MiB/.5CPU. SSHkeysEd25519, CAkeysP256, TLSkeysP256. Host/TLS1h, identity/runtimeprobe5m. TLSserveronly; renewal/clientissuance unfinished. setup:pki updates managed templates and returns restartRequired; pki:down/up loads them without rotating keys. Updated runtime template passed native issuance.
- No local OrbStack VM exists. smoke:guest records ownership before creation, deletes on success and preserves failures. Inspect/delete only its recorded VM before retrying. No paid resources exist.

## Hetzner

Verified account, dedicated project agent-cloud-development15945891; Default untouched. RW token agent-cloud-local-development saved privately. USD/23%VAT. Last saved catalog docs/research/hetzner-catalog-check-2026-09-06.json showed0VMs/IPs; CX23/33/43 unavailable, explicitly selected CPX12 grossUSD0.027798/hour includingIPv4. Refresh before mutation. SimulatedEUR.02/hour ceiling is not live configuration.

Read-only `PROVIDER_CURRENCY=USD HCLOUD_SERVER_TYPE_SMALL=cpx12 pnpm hetzner:check`. Never silently substitute a more expensive type. Live drill needs explicit currency/price/deadline and VM/IP/snapshot cleanup. No browser action pending.

## Next work

1. Runtime checkpoint ca03da9/CI34071617896 is complete. Continue the next implementation slice; do not repeat completed local VM or control drills unless code changes justify it.
2. Image sanitation/cloned fresh identity proof, snapshot ownership/cleanup, certificate renewal and operator recovery. Production createTasks/API/worker configuration still cannot enable GuestProvisioning; wire it when prerequisites exist. Then bounded cheap Hetzner build/boot/cleanup.
3. M2 browser/device login, CLI grants and customer SSH/gateway/revocation; M3 transfers/durable commands/Compose/routes; M4 recipes/off-VM backups/isolated restore; M5 usage/traffic/alerts/costlimits; M6 self-hosting; M7 failure/end-to-end proof.

Architect/how/arena work is already complete for guest architecture; don't repeat absent new friction. Applied show-me-your-work requires a different-model artifact/trail audit before handback. Existing guest_design_judge is gpt-5.6-sol; final runtime review/trail audit is docs/research/m1-guest-runtime-review.md. No transcript directory supplied; do not claim transcript audit. Keep goal active.

Sanitation preparation is recorded in docs/architecture/guest-image.md with fresh official cloud-init/Hetzner references. Local orbctl clone supports stopped clones with independent state; its help was read, but no clone drill or sanitation implementation has run. Never use orb stop without an explicit owned machine name because omission stops all OrbStack services.

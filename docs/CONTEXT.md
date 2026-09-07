# Current handoff context

Updated 2026-09-07. Full agent-cloud goal remains active, excluding Stripe. M0 is complete; M1 and M2–M7 remain open. This continuation made verified progress and is not blocked. No paid cloud resource has been created. Do not mark the full goal complete after an image checkpoint.

## Scope and repository

Customers bring Codex, Claude Code or another coding agent. We build their CLI/API/skills. TypeScript, ordinary Linux VMs, Compose, SSH and Hetzner. Keep costs low; no benchmarks, expensive plans, warm pool or automatic size/region fallback. Continued implementation, private GitHub pushes and Hetzner setup are authorized.

Work only in `/Users/yahorbarkouski/Documents/ChatGPT/learning/agent-cloud`, standalone Git inside an unrelated workspace. Branch `yahor/agent-cloud`; private origin `https://github.com/yahorbarkouski/agent-cloud.git`. Previous verifier implementation `5445f410f34d73aa8810a9b77b230defec28ff84` and reviewed evidence checkpoint `c6ff55d` are pushed. Current uncommitted work implements retained publication and its verification. The verifier's Linux CI 34094753361 passed; the publication checkpoint still needs its own commit/CI.

## Implemented foundation

Contracts/Zod, PostgreSQL/Drizzle, Hono/Graphile, SDK and JSON CLI. Tenant grants/delegation/revocation, idempotency, quotas, gross currency/VM/IPv4 prices and pinned offers. Customer journals own IP before VM, persist intent before external I/O, never retry unknown creates, and release reservations only after authoritative VM/IP absence. Catalog refresh stays outside admission transactions.

Encrypted customer bootstrap, immutable claimed/issued identities, durable signing budgets, pinned provider-address SSH proof and atomic certificate/token-erasure/runtime handoff. Restricted readiness checks image/keys, components, disk, proxy and boot ID; reboot/power-on require a changed boot ID. Thirty-minute customer operation deadlines gate fresh effects and completion. `GuestProvisioning` is in `advance-operation.ts`; production `createTasks` still does not supply it. Config has no production image/key/enrollment wiring. Live activation remains gated.

Customer wire version 1 remains allocation-owned. Verifier wire version 2 names `{kind:'image_verifier',id:ImageBuildId}`. PKI and remote APIs use `subject`; customer names stay stable, verifier DNS is `verify-<UUID>.guest.agent-cloud.internal`. Credentials and returned proof must match the subject. Guestctl shares atomic keys, certificates, enrollment and runtime inspection, with metadata at `/var/lib/agent-cloud/guest.json`. Verifier runtime includes machine ID for comparison with its sanitized builder.

Builds use sibling operator journals, never fake customer allocations. Pure planning dispatches to separately locked provider, builder, verifier and cleanup executors. Builder phases persist before SSH; lost installation responses recover without reinstalling, unknown sanitation requests full abort, and snapshots require saved sanitation plus confirmed source shutdown. Effect IDs bind current provider labels and recorded ownership. Encrypted verifier bootstrap and signing attempts bind the exact confirmed snapshot, server/effect and assigned IP. Pinned proof precedes key claim; runtime checks actual boot source and healthy distinct identity. Cancellation/expiry are rechecked before durable completion.

## Retained publication checkpoint

`image-publication.ts` now captures immutable unsigned evidence from persisted admission, sanitized builder, confirmed stop/snapshot and verified runtime. Current ownership is checked before evidence and `releasing` state commit together. Caller-supplied reports cannot authorize a release.

Retained cleanup reconciles effects and removes temporary servers before dependencies, preserving only the exact snapshot. Both TS policy and SQL forbid snapshot deletion while releasing. Once temporary resources are absent, the controller removes local keys, re-observes the snapshot, signs with a separate Ed25519 key, verifies that signature and commits the release plus `retained` state atomically. A failure resumes from saved intent; it never creates replacement capacity. Cancellation from running/releasing/retained always requests full abort. Expiry triggers full abort on the next controller pass.

`readPublishedImage`, retained controller responses and publication replay share signature/key-policy/current-snapshot validation. After provider I/O they recheck cancellation and key validity. Review caught the original replay bypass; it is fixed and tested. A null provider source is allowed only after saved verified provenance and complete temporary cleanup; a different nonnull source is refused. Inspection returns recorded audit evidence, not deployment authorization.

Retained builds release VM/open-build allowance but keep their full monthly snapshot cap until absence. Cleaning builds conservatively hold full caps. Signed evidence remains for audit after deletion. No scheduling loop exists for image work or retention expiry yet. No production customer path consumes releases or pins their lifetime through uncertain VM creation. No live image advancement command exists.

## Verification and schema

Evidence: `docs/research/m1-image-publication-verification.json`. Full check 70745 passed **321 tests in 29 files**, typecheck and lint. Final 2970 passed typecheck, lint and all 15 publication cases after adding replay revocation checks and extending the native smoke. Existing image builder/verifier checks 99721 passed 75 tests before the new publication suite. The shared verifier fixture now lives in `tests/image-verifier-fixture.ts`.

Native builder/publication 27055 passed, completion 17636e. It exercised actual SSH/SFTP/cloud-init, installation response recovery, sanitation, two distinct customer clones, verifier enrollment/runtime, actual temporary VM deletion before signing, retained snapshot selection and full abort. Cleanup 1908e3 confirmed empty Orb inventory, all four ownership records absent and empty private native fixture directories. **No VM or smoke remains active.** Provider resources/snapshot observations were protocol fixtures. Orb's seeded reboot is not Hetzner initial-boot injection proof.

All **16 migrations through 0015** are applied to the base development database; all hashes match check 74a5d4. **Never edit applied 0015 or older migrations.** Latest SHA256 `adbc2e2f429eddee001864851447641feead32b3d749be6cf10a86c0fe312899`. Application 897340 ran with owned API/worker stopped. Restarted CLI smoke 85974 passed for `vm_635feaf1-f869-479a-a780-21f9300a2aa4`; d09ef3 found zero active allocations, simulated servers/IPs and open base image builds.

The earlier SSH startup bug is structurally fixed: sanitation installs host-key `ConditionPathExists` drop-ins on both ssh.service/socket, preventing an unseeded clone listener even if boot re-enables those units. Builder access remains available until sanitation; enrollment explicitly starts SSH only after publishing new keys/principals. Fresh native 27055 passed that check again.

Selected verified public input tree from 27055:

- Manifest `06e2977ed433a27bd2e91ac741a126cb791be99f41746966789329b37d296764`
- Version `dev-842538bfbd610382f2bcb728`
- Inputs `842538bfbd610382f2bcb7289cde21a97bc157d7428012f1059494020c5ba7c8`
- Transfer checksum `1f4229064498676568d91be6743affe45dc1993083c94907389e82b91f2c0b3d`

Published `.local/guest-builds/<digest>` trees are immutable. Capture and validate the selected pointer before use; never rebuild or change selected inputs during a VM smoke. Public contract changes changed the guest bundle and selected manifest, so the extended native smoke verified a new tree.

## Local runtime and ownership

Run `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>`. For targeted tests use `pnpm exec vitest run tests/file.test.ts`; `pnpm test -- file` forwards poorly and ran the full suite. Node 24 intended; system 26.5, pnpm runtime 24.10.0.

Docker/OrbStack healthy. PostgreSQL 17 project agent-cloud-dev at 127.0.0.1:55439, db/user agentcloud, password local-development-only. **API 32218** on 127.0.0.1:4319 and **worker 33856** run current simulated code. Inspect process command/cwd before stopping. `.env` uses simulation. `.local/admin.credentials.json` and `.local/hcloud-token` are 0600; never print credentials or put them in argv/guest metadata.

Smallstep `.local/tools/step-0.30.6`, step-ca 0.30.2 digest-pinned, project agent-cloud-pki at https://localhost:9449, 256 MiB / 0.5 CPU. Issuer `.local/pki/issuer`; offline root private/provisioner password stay outside CA mount. Public trust `.local/pki/public`. Preserve keys. Runtime certificates in both namespaces force only guestctl inspect. Certificate renewal and production recovery remain unfinished. The native publication signing key was ephemeral and is not an operator production configuration.

VM ownership paths and cleanup rules are in AGENTS.md. Smokes run sequentially. While one is active, leave VM commands to it; even diagnostic `orb run` can restart a sanitized stopped source. On failure inspect/delete only recorded machines and their exact private fixture directories. Operator key store defaults to `.local/image-access/<buildId>`.

Reviewer `/root/image_release_judge`, gpt-5.6-sol, reviewed publication code/SQL and the replay fix, finding no remaining blocker. Final publication artifact/trail audit is pending. No transcript directory was supplied; review is an artifact/trail audit.

## Next work

1. Finish publication formatting, final review, commit/push and exact-head CI. Do not repeat passed native checks without a new change or unresolved concern. Keep the full goal active.
2. Connect production image selection to customer admission and pin snapshot lifetime through uncertain creates. Add durable scheduled image advancement/expiry cleanup, operator signing-key configuration, certificate renewal/recovery and production GuestProvisioning wiring. The existing internal image reader is not full allocation consumption.
3. Then run one bounded cheap Hetzner drill. Last read-only inventory at 04:17:12Z found 0 resources; refresh before paid mutations. Dedicated verified project agent-cloud-development15945891, Ubuntu 24.04 x86 image 161547269. Historical CPX12 + IPv4 price of 27,798 gross micro-USD/hour and snapshot price of 24,477 gross micro-USD/GB-month are not current admission authority. Do not create paid capacity until the complete bounded lifecycle/cleanup is ready.
4. Continue M2 login/customer SSH, M3 transfers/commands/Compose/routes, M4 recipes/off-VM backup/isolated restore, M5 usage/traffic/alerts/cost caps, M6 self-hosting, M7 full end-to-end/failure proof.

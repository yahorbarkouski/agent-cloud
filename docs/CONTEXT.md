# Current handoff context

Updated 2026-09-07. Full agent-cloud goal remains active, excluding Stripe. M0 is complete; M1 and M2–M7 remain open. This continuation is making progress, not blocked. No paid resource has been created.

## Scope and repository

Customers bring Codex, Claude Code or another coding agent. We build the CLI/API/skills they use. TypeScript, Linux VMs, Compose, SSH and Hetzner. Use cheap local tests first; no expensive plans, benchmarks, warm pool or automatic size/region fallback. Private GitHub pushes and Hetzner setup are authorized.

Work only in `/Users/yahorbarkouski/Documents/ChatGPT/learning/agent-cloud`, standalone Git inside an unrelated workspace. Branch `yahor/agent-cloud`, private origin `https://github.com/yahorbarkouski/agent-cloud.git`. Last clean pushed HEAD `f440c55`, prior implementation `cbc8cc62184639246c9356a04febfed192c8253a`. Prior Linux CI `34089677202` passed. Current verifier changes are dirty and uncommitted.

## Current verifier implementation, still under verification

The selected image-publication design now has shared guest subjects and a build-owned verifier lifecycle. Customer wire version 1 stays allocation-owned. Verifier version 2 names `{kind:'image_verifier',id:ImageBuildId}`. PKI and remote APIs take `subject`; customer names remain unchanged, verifier uses `verify-<UUID>.guest.agent-cloud.internal`. Credentials reject cross-subject use before SSH. Guestctl shares atomic key generation, certificate installation, cloud-init enrollment and runtime inspection. Metadata is now `/var/lib/agent-cloud/guest.json`. Verifier runtime includes Linux machine ID for comparison with the sanitized builder receipt.

New modules: `image-verifier-records.ts` owns public inspection and signing reservations; `image-verifier.ts` prepares/retrieves encrypted bootstraps and checks current provider ownership; `image-verifier-enrollment.ts` handles `/image/enroll`; `image-verifier-runtime.ts` saves healthy, distinct boot evidence. Controller/renderer/policy now support verifier IP/server creation from the exact confirmed snapshot. Verifier cloud-init grants no builder management access. Bootstrap intent is immutable; key claim follows pinned direct SSH proof; signing budgets/cooldown persist; issuance and token erasure commit together. Runtime checks fresh provider ownership, installed manifest, keys, machine identity, components, disk and proxy. Full abort still removes everything. Retained publication is not yet implemented.

`advanceImageBuild` has optional verifier ports while older native builder fixtures still use the explicit `verification_required` gate. No live advancement CLI is exposed. Production GuestProvisioning, certificate renewal/recovery, retained release promotion/consumption and live snapshot proof remain open.

## Database and checks

All **15 migrations through0014** are now applied to the base development DB. **Never rewrite0014 or any older applied migration.** Application56277a succeeded after confirming and stopping the owned API/worker. Follow-up migration is required for any SQL correction. Tests use isolated disposable databases.

Native SSH session81642 passed both allocation and image-verifier namespaces. Native PKI99134 passed both, including exact runtime forced command and TLS. The CA template needed explicit `runtime-verify_` handling, now fixed and CA restarted without rotating keys. Initial PKI regex failure only expected old wording and is corrected. Shared changes previously passed292tests; newer controller/SQL changes need a fresh full check.

First verifier test run accidentally ran the whole suite because of script argument forwarding. Migration failed to parse unparenthesized CASE in an IF; corrected before application. Targeted23889 then passed7/11, with4 expectation-only failures: ownership errors correctly return409, tests expected503. Expectations corrected. Typecheck38735 found one unused import, removed.

Full check70929 passed306tests/28files, typecheck and lint. Its format check needed a second Prettier pass on tests/image-verifier.test.ts;99485 passed. New selected guest manifest967c638737f43e16821ddf9d696974637039dfe1f830378e47266cda81cdb5ac, inputs44ca34982c3edc1d51620c006c04bd957cb8345319b10689f8f7b1f1b051ccc1, checksum4409e6cbc08baeab50ab6d551ab99de411e82a4100d06ff8fd4cd9bf96b9d593. Native builder78422 passed two customer clones plus a real build-owned verifier, unhealthy services and full cleanup. Orb inventory was empty907865/a9df3f. Native customer enrollment28817 passed. Reviewer identified that Orb starts before NoCloud seeding. Added explicit unseeded no-identity/principals/listeners checks and documented initial provider-boot limitation. **Native builder16223 FAILED** at the new unseeded listener assertion. Port22 briefly listened; later sshd failed without host keys. Diagnosedd7b2eb showed ssh.service/socket enabled despite sanitation disabling them. Added systemd ConditionPathExists for the guest host key to both units in guestctl sanitation. Manualdc00d5 kept both inactive with no listeners. Recorded verifier and stopped builder were deleted497a26/498d26 and exact records/private fixture directories removed. Full check96323 passed306tests/28files, typecheck and lint after the fix. **Fresh native smoke:builder45162 is ACTIVE**, log `.local/verifier-builder-ssh-gate.log`. It builds new immutable guest inputs before VM creation. Do not run VM commands or another input build while it is active. Previous immutable967c... source predates this fix.

Reviewer `/root/image_release_judge`, gpt-5.6-sol, reviewed verifier code/SQL/integration without a product blocker, requested runtime cancellation regression and reported the Orb pre-seeding limitation. Both have code/documentation updates; final native evidence and trail review remain pending. Parent still owes final verification evidence and decision-trail audit. Grounding report `docs/research/image-verifier-identity-grounding.md` came from the completed gpt-5.5 explainer. Design in `docs/architecture/image-verifier.md`.

## Local runtime

Run `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>`. Use `pnpm exec vitest run tests/file.test.ts` for a targeted run; `pnpm test -- file` forwards poorly and runs all. Node24 intended; system26.5, pnpm runtime24.10.0.

Docker/OrbStack healthy. PostgreSQL17 projectagent-cloud-dev at127.0.0.1:55439, db/useragentcloud, passwordlocal-development-only. API59716 on127.0.0.1:4319 and worker78718 now run current simulated code. Post-migration CLI/API/worker21371 passed create/inspect/destroy/cleanup for vm_60f10b89-28b0-4da8-8302-30e1665ac119. All15migration hashes match, latest0014 hash26b87121b342de36f4f81b33de5be04c0a78882843a9f14c5ec2be52c002c4cd, checkd2a9ff. Inspect process command/cwd before stopping. `.env` uses simulator. `.local/admin.credentials.json` and `.local/hcloud-token` are0600. Never print secrets or pass them in argv/guest metadata.

Smallstep `.local/tools/step-0.30.6`, step-ca0.30.2 digest-pinned, projectagent-cloud-pki at https://localhost:9449,256MiB/.5CPU. Issuer `.local/pki/issuer`; offline root private/provisioner password remain outside CA mount. Public trust `.local/pki/public`. Preserve keys. Runtime SSH forces only guestctl inspect; no Docker/general sudo.

Native builder45162 is active after failed16223 fixture cleanup, with new guest inputs containing SSH unit conditions. Native smokes share `.local/guest-image-builder.json`, `guest-image-refusal.json`, `guest-image-machine.json`, `guest-image-verifier.json`; never run concurrently. While a VM smoke runs, use its output only, since diagnostic `orb run` can restart a sanitized stopped builder. Preserve failed ownership records and inspect/delete only recorded machines. Operator keys `.local/image-access/<buildId>`; native fixture keys `.local/image-builder-access/<builderId>`.

Prior complete native builder proof6670 and cleanup are in `docs/research/m1-image-builder-work-verification.json`; it verified two customer clone boots and full abort. It does not prove the new verifier lifecycle or Hetzner snapshots.

## Next work

1. Finish verifier tests, independent review and native enrollment/boot proof. Preserve meaningful failures and corrections in docs/DECISIONS.tsv. Apply0014 only after required checks, then restart owned local API/worker and verify cleanup. Commit/push coherent verified progress.
2. Implement retained snapshot publication, signed promotion/consumption, certificate renewal/operator recovery and production GuestProvisioning wiring. Then one bounded cheap Hetzner drill. Last read-only inventory04:17:12Z had0resources; refresh before paid effects. Dedicated verified projectagent-cloud-development15945891, Ubuntu24.04x86161547269. Historical CPX12+IPv4 price27798grossmicroUSD/hour and snapshot24477grossmicroUSD/GB-month, not current admission authority.
3. Continue M2 login/customer SSH, M3 transfer/commands/Compose/routes, M4 recipes/off-VM backup/isolated restore, M5 usage/traffic/alerts/cost caps, M6 self-hosting, M7 full end-to-end/failure proof. Do not mark the full goal complete after M1.

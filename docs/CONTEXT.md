# Current handoff

Updated 2026-09-08. Work on `yahor/agent-cloud` under AGENTS.md. Build the original TypeScript/Hetzner/Compose cloud for existing agents; no Stripe. The user authorized delivery and required real deployment verification. Reuse existing functionality. The goal tool's old blocked state is stale.

## What works

Customer GitHub login, admission/delegation/revocation, real Hetzner lifecycle, SSH/SFTP, durable commands, Compose, hosting, recipes, protected backups, restore, usage and control recovery are implemented. Production entrypoints already connect the customer path. **The hosted customer service is not running yet.** [COMPLETION_PLAN.md](COMPLETION_PLAN.md) owns remaining product acceptance; historical architecture status paragraphs are not current release claims.

This checkpoint packages the existing image-build, runtime-identity and gateway-setup commands in the production image. Customer Compose now supervises persistent services, includes a private CA and mounts GitHub credentials only in the API. Retention remains an explicit one-shot command; review caught and removed its restart loop. `examples/full-stack` packages the existing counter frontend/backend/PostgreSQL as an ordinary source context with a generated private secret. No new installer or deployment subsystem.

Verified this checkpoint:

- `pnpm check` and `pnpm format:check` passed; `.local/customer-preview/{check,format-check}.log`.
- The actual example Docker build, HTTP counter, update and PostgreSQL persistence passed; `.local/full-stack-example-check-2.log`. Both disposable fixtures cleaned. Direct local bind mounts must model guestctl's staging: source files become0644 beneath a private parent; mounting the original0600 secret directly incorrectly denied the nonroot backend access.
- Production amd64 image `sha256:b89577306e9d67a91fe93c3bd8028ef2173379e581c6f9fb7c0b44ce123a5e8e`, local tag `agent-cloud:preview-2e6f8dca`. `.local/customer-preview/packaged-setup.log` proves packaged identity setup/replay, gateway certificate issuance/replay, CA DNS name `ca`, UID1000 and CA restart. Its owned containers/volumes/network cleaned. This is container proof, not Hetzner proof.
- Historical real internal app: [verification](reference-deployment-verification.json), `4d2bffa`/`86b6b1b`: CPX12 frontend/backend/PostgreSQL, HTTPS, disconnect/reconnect, persistent update and exact cleanup. Its snapshot/URL are gone.
- Existing native/packaged customer, recovery and recipe proofs remain valid: `.local/selfhost-customer-packaged-2.log`, `-recipes-1.log`, `-ssh-smoke-1.log`; provider simulated/private CA. Control recovery `6a74f2e`, CI34192771022. See subsystem guides for recovery boundaries.
- Signed public [CLI v0.1.0](https://github.com/yahorbarkouski/agent-cloud/releases/tag/cli-v0.1.0) at `ce9a0d8264ab3b10352fe82860e150fd8e75832c`; CI34198076587 and release34199568712 passed. `.local/public-cli-download-verification-1.log` proves download/attestation/external extraction. Artifact `.local/releases/cli-0.1.0-github-ce9a0d8/agent-cloud-cli-0.1.0.tar.gz`, SHA256`9b47030be2db94369f691891bedd69c6f274a8f5a497a853931ee72a6fd3c4da`. Published assets are immutable; customer CLI code has not changed this checkpoint.

## Next acceptance and exact preparation

Provision the bounded trusted platform host, run the prepared image in `image_factory` mode, publish a retained guest image, switch the same DB/identity to customer mode, admit the real GitHub owner and use the downloaded CLI to deploy the example. Verify public ACME, disconnect/reconnect, logs, persistent update and exact cleanup. No laptop tunnel or internal grant. Protected S3 is subsequent work, not a first-deployment dependency.

Private preparation is `.local/customer-preview/`, owner `2e6f8dca-f8c0-4cc9-91a0-f88ebf5ee4dc`; `record.json` has no paid resources. Fresh isolated PKI is `pki-setup/.local/pki`; only its issuer was copied to `platform/ca`, with `ca` added to `dnsNames`. Offline root stays outside the host. `platform/identity` is initialized; preserve it. Provisioner/public trust and provider token are in `platform/control`, OAuth in `platform/auth`. These are private local copies, not deployed files. Set remote owner UID/GID1000 and private permissions before startup.

New public guest input `3be19009da79b7620a5e93910d3330d528633277e7f96298fa2d51407ae96a84` is staged immutably in `.local/guest-builds`; receipt `customer-preview/guest-build.json`. It matches the fresh isolated trust and is not provider-published. Build with `ACLD_IMAGE_TRUST_DIRECTORY=<that-pki>/public` to reproduce. `.local/guest-build.json` now points to it; retain explicit digests.

Task-only `customer-preview/configure-host.mjs` is a syntax-checked draft, not run: it requires a recorded owned host/id/IP/deadline, writes existing validated config schemas and a worker-only factory mount override. Inspect before use; a partial write intentionally refuses overwrite and needs exact reconciliation. Planned temporary DNS: `cloud.<dash-ip>.sslip.io` and separate application namespace `apps.<dash-ip>.nip.io`; real DNS/ACME unverified. Use pre-generated verified SSH host trust, not TOFU. Initialize a new host DB generation with existing `control-recover` commands. Refresh quotes before effects; retain intent/receipt/exact labels before any provider mutation.

## Resources, budget and blockers

Read-only inventory 2026-09-08T11:47:29Z: zero development servers/IPs/snapshots/firewalls/SSH keys. CPX12 available nbg1/fsn1/hel1; Ubuntu24.04 x86 system image161547269. USD gross hourly server26568µ + IPv41230µ + automated backups5314µ =33112µ. Two such hosts for24h total1.589376USD. Snapshot24477µUSD/GB-month. Refresh expired quotes; never automatically substitute a larger machine.

**One budget/lifetime question remains pending**: keep platform/sample for24h under a combined1.60USD VM/IP/backup cap then clean up, or delete immediately after verification. Existing recorded caps cover disposable image VM/IP120000µUSD, customer VM/IP60000µUSD and snapshot monthly1000000µUSD; ongoing platform/demo lifetime had no recorded cap. No answer received and no paid resources created. Do not treat the preselected answer or elapsed time as approval, or ask the same question again. Continue independent preparation while pending.

GitHub CLI verified owner94449298 (`yahorbarkouski`); OAuth credentials exist. Fresh real device approval still needs the GitHub browser flow. CUA `getState()` this turn showed an in-app browser with no tabs; no lock error observed. Previous console/locked-Mac reports were not re-established. Do not ask the user to sign in again without actual evidence.

Preserve main PG `agent-cloud-dev-postgres-1` localhost55439, main CA `agent-cloud-pki-ca-1` https://localhost:9449, `.local/pki`, `.local/runtime-identity`; main DB through0026. Old API15176/worker15190 need PID/command-name-only inspection. Unrelated Docker services remain untouched. Credentials `.local/hcloud-token` belong to dev project15945891, `.local/github-oauth.json` to app3843400. Never print secrets/full process arguments. Previously exposed unrelated credentials were reported; rotation unverified.

S3 permissions/Object Lock, independent recovery destination, permanent domain and final provider recovery remain open. They do not block first deployment. Standard commands: `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>`. Do not repeat unchanged comprehensive checks for handoff edits. Relevant guides own subsystem detail; git preserves earlier handoffs.

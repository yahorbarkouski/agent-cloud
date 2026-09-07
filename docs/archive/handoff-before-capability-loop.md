# Current handoff context

Updated2026-09-07 during M2. The full cloud goal remains active, excluding Stripe. Customers bring existing agents. Implementation, private GitHub pushes and bounded cheap Hetzner tests are authorized. M0/M1 are complete; M2–M7 remain open. No expensive plans, benchmarks, warm pool or automatic type/region fallback.

## Current repositories

Root branch `yahor/agent-cloud`, private origin https://github.com/yahorbarkouski/agent-cloud.git. Customer signer checkpointb441661802a2fe0e5a79e32e1a1e538890c1472a is pushed on yahor/customer-ssh and fast-forward integrated into the root branch. Exact Linux CI34145188845 passed the full suite, formatting, native customer PKI/SSH and existing native smokes. Logging checkpointb79a3d0cb4daa8abfbb148f50b5f4d095e6ac947 and exact CI34143911101 passed earlier. Storage integration521162403960e40ceffbacc552e7c1b7a2041131 and its exact Linux CI34141499939 passed earlier. The sole canonical append-only decision trail is `docs/DECISIONS.tsv` here.

Isolated worktree `.local/customer-ssh`, branch `yahor/customer-ssh`, was fast-forwarded to b79a3d0. Its customer signer is committed at b441661. Only the next image-capability grounding document is uncommitted. It has no provider credentials. Keep root's newer progress/trail when integrating. Do not edit applied migration0020.

## Logging correction in progress

The first native customer certificate test exposed four consumed fixture OTTs in Smallstep's default text access logger. Its disposable CA had already been removed. Saved diagnostic output was redacted. A private in-memory audit counted363 historical OTT occurrences in the main CA's retained container output without printing them. No other root .local log required redaction. This does not audit external log copies.

Setup now omits the logger for new and existing CAs. Existing setup always reports restartRequired because matching files cannot establish loaded runtime configuration. `pki:up` always recreates the container. This closes the review finding about a crash after config rename. Main CA was recreated with original keys, discarding its previous container logs. Native signing in both guest namespaces passed, with no tokens in subsequent output. `scripts/smoke-pki.ts` checks config and actual service logs without displaying them.

Evidence: `.local/pki-log-policy-{setup,replay,audit}.json`, `.local/pki-log-policy-{smoke,replay-smoke,check}.log`. Full check passed445tests/38files113.58s. Replay setup, supported recreation and native signing passed afterwards. Review is `docs/research/pki-logging-review.md`. Formatting/review passed; logging checkpointb79a3d0 is pushed and exact Linux CI34143911101 passed.

## Customer signer next

Selected design is `docs/architecture/customer-ssh.md`. Immutable storage and authority traversal are implemented; customer admission, issuer worker, gateway, access-capable image and CLI are still open.

Draft `customer-ssh.ts` derives signed exact key/allocation/source/absolute-expiry claims, generates one OTT in memory and sends one bounded TLS POST. Its inspector checks exact policy on the authenticated CA response; OpenSSH later verifies signatures. `step-tooling.ts` shares existing private-workspace handling. The native template compares requested key wire bytes against the signed claim and gives customers only PTY plus source-address restrictions. Old host/probe/runtime policy remains intact.

The final reproducible native smoke passed in `.local/m2-customer-signer-final-native.log`. It proves exact certificate policy, key substitution/malformed/unsigned claim rejection, request-option isolation, near-expiry validity and old credential compatibility. A trusted local TLS proxy proves one POST under lost response after real CA issuance, rejection, redirect, oversize, truncation and cancellation. Broken token generation fails before any POST. Workspace permissions and cleanup pass. Native OpenSSH accepts command/PTY and rejects corrupted signatures, wrong key/user/source/allocation, forwarding and wrong host CA; the same server preserves the probe forced command. Fresh CA and SSH containers and private fixtures are fully removed. Fixture private NAT ranges and disabled source penalties are not production image policy.

Full check `.local/m2-customer-signer-full-check-final.log` passed448tests/39files108.60s plus typecheck/lint. Formatting passed. The native run preceded only an equivalent cleanup callback lint correction. `docs/research/m2-customer-signer-verification.json` and implementation review record the exact bounds and earlier type/lint/fixture failures. Source includes explicit pre-submission failed versus submitted unknown results; neither permits another attempt. Template IDs and duplicate checks were tightened; full CIDR validation remains the typed boundary. Signer integration and exact Linux CI are complete. Root integration typecheck/build and existing native PKI smoke passed after template update and CA recreation. Restarted actual CLI lifecycle cleaned vm_c661e5cf-3752-434d-ae28-04cdb31bef4e. Root evidence files use .local/m2-customer-signer-integration-\*. The next prerequisite is the signed customer-access image capability, followed by access admission/issuer/gateway/CLI. No actual customer API, worker, gateway or access-capable image is implemented.

## Local services and schema

Main database `agentcloud`, PostgreSQL17 on localhost55439, Docker containerf493732f6c73. Migration0020 applied and all21 hashes matched. Its SHA256 is8aba369eaf07a3d028ac848d3228b478ea820d25ee776890d5bcafffdf23b25f. Actual CLI create/inspect/destroy cleaned simulated machinevm_cae6e7df-7048-4998-90a5-633cb7688501. Evidence `.local/access-storage-integration-{migration-check,cli}.log`.

API session25749/PID15176 and worker89064/PID15190 run `node --env-file=.env apps/control/dist/{api,worker}.js`, logs `.local/simulated-{api,worker}-customer-signer.log`. API4319. Original CA https://localhost:9449,256MiB/.5CPU, Step0.30.6/step-ca0.30.2. Its customer template is now the verified b441661 template, preserving original CA keys. No OrbStack guest, temporary tunnel, paid server or snapshot exists.

## Completed M1 live proof

M1 evidence commit42a5c617207b1bcb13f12e3e6d729ac2cd727510 and CI34138682426 passed. Third customer drill owner2224a90a-acad-42f4-9081-e8fc08822ff7 passed signed snapshot boot, create/replay, enrollment/readiness, graceful power-off/on and reboot. Real timer renewal issued15:15:25.006Z after2101271ms. Newly served SSH/TLS certificates matched, with original public-key/CSR continuity. TLS observation proves the server leaf, not an authenticated application request.

Destroy, image cleanup and independent inventory confirmed servers, IPs, snapshots, firewalls, SSH keys and SQL reservations zero15:17:06Z. Six temporary processes stopped. Owned live database was privately archived, archive contents listed and database dropped. Archive listing is not restore proof. Public records `docs/research/m1-customer-live-*.json` preserve exact IDs and evidence. The private207426-byte `.local/customer-drill-database.dump` has SHA256d6e4c65c2747d1af8ad78f3b6c28ef39e7bc4e0e16d70b559da18a715574ac03 and must never be committed or printed.

Three customer VM/IP attempts estimated56826µUSD under60000µUSDcap, not an invoice. Image VM/IP and snapshot caps were separate. Projectagent-cloud-development15945891 is empty; Default is untouched. `.local/hcloud-token`, runtime and CA credentials are owner-only. No further paid proof is needed until a verified access-capable image is ready.

## Commands and remaining milestones

Use `npm exec --yes --package=pnpm@12.3.4 -- pnpm <command>`. Run `pnpm check` and `pnpm format:check` at checkpoints. Use `set -e` for dependent shell mutations. Never print raw CA logs or secret subprocess errors. Native fixtures have exact names and finally cleanup. No active workspace transcript directory was supplied; review artifacts and the canonical trail honestly.

After M2 access and device login, implement M3 files/durable commands/Compose/routes, M4 backup/restore, M5 usage, M6 self-hosting and M7 failure/availability verification. Preserve product limitations until actual protocol and provider proof exists.

# M1 catalog and bootstrap storage checkpoint review

Reviewed the uncommitted checkpoint against `7a3f6f6` using the configured **gpt-5.6-sol** reviewer. The review covered the catalog cache/runtime, private file reader, API/config/HTTP changes, bootstrap sealing and storage, guest contracts, migration 0006, the focused tests, and the pinned Smallstep installer added after the reported 77-test check. The selected design in `docs/architecture/guest-bootstrap.md` is the specification.

No `agent-transcripts/` directory exists in the repository, so earlier command and live-read claims were not transcript-audited. I inspected the current files, migration SQL, decision trail, and evidence paths. I independently ran the three focused test files after the review fix: 10 tests passed. I also ran the installed workspace-local `step` binary and confirmed CLI 0.30.6 on Darwin arm64. I did not rerun the installer download, the reported 77-test full check, formatting, a migrated service restart, or any live Hetzner read. No credential was read and no cloud or CA mutation occurred.

## Standards

The first pass found one material database invariant gap. `guard_guest_identity()` accepted a claimed-to-issued transition when the three issuance fields were empty strings or JSON nulls. The bootstrap guard then treated `kind = "issued"` as sufficient and allowed deletion of the recoverable sealed token. The TypeScript schema also accepted empty certificate strings.

The current code fixes this. `packages/contracts/src/guest.ts` derives bounded claimed fields from the enrollment schema and requires nonempty bounded certificate strings. Migration 0006 now requires exact claim fields, typed nonblank issuance fields, and a finite UTC timestamp before an issued transition. The regression attempts empty, whitespace, null, numeric, and malformed timestamp values inside the issuance-and-consumption transaction and confirms the token remains recoverable after each rejection. The focused rerun passed.

I found no remaining high-confidence plaintext exposure or mutable-key path in this bounded storage slice. The token is random, encrypted with AES-256-GCM, bound through authenticated metadata, stored separately from the provider journal, checked against its hash after recovery, and erased only in the same transaction that follows valid identity issuance. The private-file helper checks the opened descriptor, refuses symlinks, enforces owner-only permissions and ownership, and bounds the read. Errors and catalog failure events contain no raw credential or provider response.

The code remains explicit and small. External catalog and guest values pass through Zod schemas, and guest identity states use a discriminated union. The database trigger backs the one-way claimed-to-issued transition instead of depending only on a future service call.

## Specification and integration flags

Catalog identity, currency, and expiry are handled correctly in the implemented path. Refresh validates the complete snapshot before publication, clears it on provider or currency disagreement, and retains the last good snapshot through a temporary outage. `selectOffer()` checks expiry and future observations on every admission or fresh effect, so the retained snapshot cannot authorize work after its TTL. The Hetzner reader constructs only `account_gross` offers from one currency-bearing pricing response. Live API activation remains blocked.

Bootstrap preparation pins account, machine, allocation, operation, image, endpoint, and expiry. Concurrent preparation adopts the stored winner; expiry and consumption do not mint a replacement. Recovery joins the live allocation, validates duplicated metadata, authenticates the ciphertext, and verifies its hash. The current tests substantiate these properties in PostgreSQL.

The next provider-command change needs deliberate compatibility. Existing and migrated create attempts have no bootstrap reference, including prepared and unknown attempts that must remain parseable for reconciliation. A new live managed-IPv4 create must require the stable reference, while historical or simulated commands need an explicit legacy/no-bootstrap shape or a safe migration. Recovery belongs only in the first submission call after the prepared attempt is stored. Reconciliation must never decrypt the token or resend an uncertain create.

The checkpoint is storage and tooling, not guest identity proof. It has no enrollment service, direct provider-IP SSH proof, certificate signer, cloud-init renderer, sanitized image, runtime verifier, or lifecycle phase split. Passing tests therefore do not establish that the submitted SSH/TLS keys belong to the recorded VM or that create waits for Docker, Compose, disk, image, and proxy readiness.

The Smallstep installer pins per-platform archive hashes, extracts one named member with `execFile`, writes under the private `.local` parent, sets the binary to mode 0700, executes it with bounded output, and removes scratch data. The existing binary runs and prints 0.30.6. This does not prove a fresh download or archive verification in this review, and no CA state exists yet.

## Decision trail audit

The four new `docs/DECISIONS.tsv` rows have six columns and their file evidence resolves. The guest-design row accurately says enrollment remains unfinished. The catalog row distinguishes a prior 77-test check from a read-only live observation and says no mutation occurred. That live USD result has no durable artifact, so it remains a main-run claim rather than independently reviewable evidence. The bootstrap row truthfully records that the invalid-issued-payload fix awaited verification when appended; add a later append-only checkpoint row after the final full check instead of rewriting it. The PKI row is supported by the installer source and the executable now on disk, but its original download execution has no transcript.

## Attention

reviewed by gpt-5.6-sol

- Preserve an explicit legacy provider-command form when adding the bootstrap reference, or old prepared and unknown create attempts will fail parsing before reconciliation.
- Keep live activation disabled until enrollment proves the proposed keys over SSH to the provider-recorded IP and readiness controls operation completion.
- Record the post-fix full check in a new decision row. Treat the uncaptured live catalog observation and original installer run as main-task evidence, not durable audit artifacts.

## Local PKI and SSH follow-up

The configured **gpt-5.6-sol** reviewer also inspected `packages/pki`, `packages/remote`, the Smallstep setup and Compose files, both certificate templates, both smoke runners, the OpenSSH fixture, focused certificate tests, and CI additions. This follow-up covers the current local files only. I independently ran `pnpm smoke:pki` and `pnpm smoke:ssh`; both passed, including a real TLS connection and a disposable OpenSSH connection. The SSH unit inspector test also passed independently. These runs created no cloud resources.

Two certificate-response gaps found during review are fixed. SSH issuance now rejects a response unless native Smallstep inspection reports the requested Ed25519 key, configured CA, host/user type, exact single allocation principal, exact key ID, expected empty extensions, probe-only forced identity command, and bounded lifetime. TLS issuance now parses the CSR key as native P-256 SPKI, verifies the returned chain, and rejects a leaf whose SPKI, exact DNS name, server-only extended use, CA bit, or one-hour validity differs. Adversarial inspector cases exercise wrong keys, CAs, principals, options, extensions, and lifetimes. The Smallstep templates independently remove SSH extensions and force the probe command for user certificates.

Secret handling is sound for this local boundary. The development CA is digest-pinned and loopback-only. Its root private key is moved outside the container mount; signer keys and provisioner material remain under the owner-only PKI tree. The CA container has resource limits, no-new-privileges, and only its documented execution capability. Signer subprocesses receive the provisioner password through a private temporary file, use an isolated `STEPPATH`, bounded output and timeouts, and erase their workspace. Probe private keys are short-lived in-memory credentials written to owner-only temporary files for OpenSSH, then removed.

The remote API is small and keeps mutation explicit: probe credentials are issued separately and reused by `readIdentity`, so retries do not silently call the CA. OpenSSH ignores user configuration and agents, disables forwarding, pins either the proposed raw host key or the configured host CA, and uses an allocation-derived alias and principal. The fixture proves rejection of a wrong raw key, wrong CA, foreign allocation credential, and wrong returned allocation. Cleanup now fails unless removal or confirmed absence is observed.

The remaining risks are integration work rather than defects in the reviewed local primitives. Enrollment must supply only the provider-observed public IP, use raw-key pinning, compare every returned proof field with the proposal and stored image, and claim immutable keys before signing. Later host-CA readiness must compare the returned host key and image evidence with persisted identity; `readIdentity` itself checks those fields only in raw-key mode. Probe issuance/renewal needs a bounded persisted attempt policy within bootstrap expiry. One-hour guest certificates also require the separately planned renewal path before live service can rely on them.

CI now installs pinned Smallstep, creates the local CA, starts it, and runs both smoke paths with unconditional Compose cleanup. This is meaningful local process evidence. It does not exercise provider reference rendering, enrollment concurrency/recovery, an image build, cloud-init, systemd, direct reachability to a provider-recorded Hetzner IP, runtime readiness, or certificate renewal. Live Hetzner activation should remain disabled until those paths pass the bounded VM boot described in the architecture.

## Follow-up attention

reviewed by gpt-5.6-sol

- No high-confidence blocker remains in the local signer or OpenSSH proof primitives after the response-binding fixes.
- Make readiness compare host-CA proof against persisted identity and bound probe issuance attempts before wiring lifecycle completion.
- Treat the two passing local smokes as local CA/OpenSSH evidence only; they do not establish guest VM readiness.

The four final decision rows are structurally valid six-column append-only entries, and every repository evidence path resolves. They accurately distinguish the independently repeated local identity smokes, the 78-test full check and migrated local-service smoke from pending remote CI and absent VM-boot evidence. `docs/CONTEXT.md` and `docs/PROGRESS.md` preserve the same live-activation gate and remaining integration scope.

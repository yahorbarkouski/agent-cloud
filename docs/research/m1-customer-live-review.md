# M1 customer live evidence review

Reviewed 2026-09-07 from repository artifacts only. No transcript directory was supplied. I did not rerun tests, inspect credentials, call the provider, restore the archive, or mutate services/resources.

## Pre-commit finding

**[P1 evidence claim] Add public evidence for preserved guest keys/CSR, or narrow the prose.** `docs/CONTEXT.md` and `docs/PROGRESS.md` say the original keys/CSR were preserved. The canonical lifecycle JSON contains the two served-certificate observations and renewal timing, but it does not contain explicit equality results for the original versus renewed SSH host public key or TLS CSR/public key. The SSH certificate blobs can support a key comparison after parsing; the recorded TLS fingerprints/serials intentionally change and do not prove CSR-key continuity.

Before the evidence commit, add non-secret booleans such as `sshHostPublicKeyUnchanged` and `tlsCsrPublicKeyUnchanged`, derived by the already-completed driver/database observation, with their observation scope; hashes of public keys are also safe if useful. If that retained evidence is unavailable, change the prose to the narrower fact actually recorded: renewed SSH/TLS certificates were issued and the served renewed certificates matched. Do not infer CSR preservation merely from successful renewal.

## Verified claims and limits

- Root HEAD is exactly `224a56a09e1868b8acfa2b315e9da951560c65f4`. Current root changes are documentation/evidence only; product source remains at that checkpoint.
- The canonical lifecycle artifact records successful create replay, power-off/on, reboot with changed boot IDs, renewal issuance at `15:15:25.006Z` after `2,101,271ms`, renewed certificate observation at `15:15:31.156Z`, and state `verified_and_customer_cleaned`.
- Cleanup evidence binds the exact drill/build, confirms exact customer VM/IP absence, records durable snapshot cleanup, exact unattached labelled firewall deletion, project-wide zero servers/IPs/snapshots/firewalls/SSH keys, and zero active customer/image SQL ownership at `15:17:06Z`.
- Process evidence names the six owned API/worker/tunnel processes and records an empty remaining set at `15:18:53Z`. It exposes only command shapes and local environment filenames, not environment contents.
- Database evidence records the exact private database archive path, mode `0600`, byte count `207426`, checksum, successful table-of-contents inspection, and exact database drop at `15:19:36Z`. The docs correctly state that `pg_restore --list` is archive-structure inspection, not a restore proof.
- The six new public JSON artifacts contain provider/resource IDs, public certificate material, hashes, local filenames, process IDs, and idempotency request UUIDs, but no token/password/private-key/authorization fields. The private dump and raw `.local` records are clearly marked non-committable.
- README, AGENTS, current CONTEXT, the leading PROGRESS summary, and the milestone list consistently define M1 as durable lifecycle, provider/image, reconciliation, real elapsed renewal, and complete cleanup. They explicitly leave customer SSH, device login, application deployment/routing, backup/restore, and M2–M7 open. The older chronological PROGRESS sections contain stale “M1 remains” statements, but the document explicitly says the current summary and milestone list supersede those historical checkpoint statements.
- Budget language is scoped as an estimate under the authorized cap and explicitly not an invoice. TLS language is scoped to a trusted served leaf and explicitly not authenticated application proof. Zero inventory is an observation at cleanup time, not a permanent absence guarantee.
- The latest decision rows accurately separate completed M1 live proof from isolated M2 authority work. Authority commit `2ece39a` is described as pushed and CI-verified; uncommitted migration0020/session work is described only in CONTEXT/PROGRESS as isolated, transition-unverified work and is not represented as complete.

After correcting or narrowing the key/CSR sentence, I find no evidence, secrecy, cleanup, or milestone blocker to the M1 documentation checkpoint.

## Resolution

The pre-commit finding is resolved by `m1-customer-live-key-continuity.json`. The helper checksum-verifies the exact recorded private archive, asks `pg_restore` to emit data only for `guest_identities` and `guest_certificate_renewals`, filters to the exact allocation and renewal IDs, and requires one row of each. Those records conform to `issuedGuestIdentitySchema`, whose relevant material is public keys, CSR, and issued certificates; no private key is stored or extracted by this path. It does not create or restore a database.

The public artifact records matching hashes and true equality for the original/renewed SSH host public key and TLS CSR, independently confirms equal X.509 subject public keys, and binds both stored SSH/TLS certificate generations to the saved live observations. It includes the archive checksum and an explicit extraction scope but no certificate bodies, CSR, database rows, token, or private material. `m1-customer-live-verification.json` now links the artifact and carries the three continuity booleans. This seventh public live JSON supersedes the earlier review's count of six.

The updated CONTEXT wording correctly says “public keys/CSR” and names the archive-derived evidence and no-private-key limit. The PROGRESS sentence is now supported by the linked verification artifact. No M1 evidence, secrecy, cleanup, or milestone blocker remains. Formatting was reported before this small JSON/review addition; that is a trail limit, not a content concern.

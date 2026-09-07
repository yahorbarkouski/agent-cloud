# M1 image provenance implementation review

## Scope and conclusion

Reviewed the new `packages/images` package, image input/release contracts, manifest format 2, content-addressed staging, trusted transfer check, `guestctl verify-inputs`, installer invocation, migrated smoke consumers, and focused provenance/release tests. This was a read-only review. No provider or VM mutation was performed, and no build was started while the parent validation was active.

The previously reported installer trust-order flaw is fixed. An independently captured digest now authenticates the exact transfer checksum file using base-system `sha256sum`; that authenticated file then verifies every staged byte before uploaded installer, Node or `guestctl` code runs. Shell arguments remain isolated from script text. The acyclic input identity and release-signature implementation are sound for this milestone.

One scope boundary remains: release verification authenticates internally consistent recorded assertions, but live snapshot ownership, stopped-source observation, image availability and proof that the verification server booted the exact snapshot are future journal/provider work. No current release should be promoted as consumable production state until that boundary exists.

## Finding

### [P2] Release verification does not yet bind signed snapshot and boot assertions to live provider evidence

`validatePayload` links the sanitation server ID to `snapshot.sourceServerId`, requires a distinct verification server, checks the manifest digest at sanitation and boot, and enforces source-stop, snapshot, boot and issue timestamp order. Ed25519 authenticates those fields. Nothing in the current milestone observes that the snapshot has the build's exact ownership labels, is available with the stated architecture/size/source, or that `verifiedBoot.serverId` was created from `snapshot.id`. `sourceStoppedAt` is likewise a signed assertion rather than a persisted provider observation.

The code comment above `verifySignedImageRelease` correctly says live snapshot ownership must be observed separately, but the future check must also cover stopped-source evidence and verifier boot-source binding. The provider journal should persist a create-verifier intent naming the exact snapshot ID and reconcile that effect to the observed verifier server before signing and promotion. Production consumption must confirm the retained snapshot is still owned, available and within retention.

This is unfinished publication wiring, not a flaw in the implemented cryptographic verification. Keep the API and progress text precise: it verifies a signed, internally consistent release record; it does not yet prove current provider state.

## Corrected installer trust boundary

`verifyImageInputs` now validates the complete local tree and exact generated `SHA256SUMS`, then returns `checksumDigest`, the SHA-256 digest of those exact checksum bytes. `readGuestBuild` captures that digest with the selected manifest digest. Both native installer callers pass both values through argv to `imageInstallCommand`.

`imageInstallCommand` sends a fixed `imageTransferCheck` program through the already authenticated management execution channel. The program uses a fixed base-system `PATH`, validates its two positional arguments, authenticates `SHA256SUMS` against the independently captured digest, rejects non-file/non-directory entries, requires the exact directory and file counts, and only then checks every listed byte. The uploaded installer executes after that subshell succeeds.

The shell composition is safe for the defined interface:

- User-controlled values are argv elements, not interpolated into shell source.
- `(set -- "$1" "$4"; ...)` gives the verifier only the directory and checksum digest while preserving the outer install arguments.
- Every path use is quoted. `exec /bin/sh "$1/install.sh" "$1" "$2" "$3"` does not evaluate path, UUID or digest text as shell syntax.
- The generated inventory permits only conservative ASCII relative paths, and the trusted checksum digest prevents replacement of checksum lines.
- Uploaded Node and `guestctl` verification remains useful defense in depth after the trusted transfer check; it is no longer the first verifier.

The new adversarial tests substitute the installer, verifier, runtime, manifest, inventory and transfer checksums together and prove refusal before attacker code runs. A separate test proves an unlisted extra file is rejected. These tests address the original P1 directly.

## Input identity and canonical metadata

The provenance cycle is closed correctly. `image-inputs.json`, `image.json` and `SHA256SUMS` are excluded from the public-input inventory. The sorted inventory binds installer, service units, SSH/sudo policy, bundled `guestctl`, artifacts, canonical artifact pins and canonical public trust. Manifest format 2 binds `publicInputsDigest`; the separately computed manifest digest names the build directory.

`createImageManifest` rejects missing or extra expected paths, duplicate artifact filenames, artifact bytes that disagree with pinned SHA-256 values, and non-canonical `artifacts.json` or `trust.json`. `verifyImageInputs` re-enumerates actual regular files, verifies the inventory, regenerates the manifest, and requires exact transfer checksum lines. Paths reject traversal, absolute paths, backslashes, symlinks and derived self-reference. File count, directory count, size and unsafe write-mode bounds are present.

Schema parsing before hashing/signing fixes field order for all defined objects. The current signed structures contain no unconstrained map whose insertion order can change the signature payload. Verification reparses before checking the signature, and the reordered-payload test demonstrates the intended canonical behavior.

## Staging and reuse

The builder stages into a fresh private directory, verifies the complete tree, changes published files to `0444` and directories to `0555`, and atomically renames to `.local/guest-builds/<manifestDigest>`. A concurrent or previous winner is accepted only after complete verification. Pointer replacement is atomic, and consumers capture one manifest digest and reverify that directory before use.

These permissions prevent ordinary accidental mutation and make reuse match the content-addressed contract. They are not hostile-owner immutable storage: the same filesystem owner can restore write permission. That limitation is acceptable for the local workspace boundary because digest verification remains authoritative. Documentation should call this content-addressed, verified staging rather than imply resistance to a malicious local owner. The later provider admission must capture the digest and checksum digest once and transfer the verified directory without silently following a newer pointer.

## Release cryptography correctly implemented

- Ed25519 is required for signing and verification; key IDs derive from public SPKI bytes. Public-only signers and other algorithms are rejected.
- Parsed canonical payload bytes are signed. Unknown, revoked and duplicate key policy fails closed.
- Signing windows, verification retirement, future issuance and release retention expiry are enforced. Equality at `signedUntil`, `verifyUntil` and `retainUntil` is expired, avoiding ambiguous boundary acceptance.
- Signed evidence internally binds build/builder identity, sanitation/source server, exact manifest and input graph, distinct verifier server, and event ordering.
- `GuestImage` is derived from the signed snapshot and manifest rather than accepted as a competing copy.

The release schema's `diskGb <= 1024` and arbitrary future `retainUntil` are structural bounds, not the selected 40 GiB and gross retention policy. The future admission/journal layer must reject signing or promotion when observed size, currency/gross caps, deadline or deletion time exceed the persisted build admission.

## Implemented versus pending

- **Implemented:** deterministic public-input inventory and manifest hashing; exact transfer checksum derivation; base-system pre-execution transfer authentication; content-addressed verified staging; signed release schema; signature, key-window, revocation, retention and internal evidence checks; derivation of `GuestImage` from signed fields.
- **Pending:** platform build/effect/resource tables; persisted provider intent and one-way outcomes; stable-label ownership reconciliation; unknown/duplicate create and delete handling; gross price/cap admission; authenticated first SSH host identity; sanitation of temporary provider access; stopped-source and snapshot observations; fresh boot tied to the exact snapshot; transactional retained-release promotion/current-channel selection; cleanup and expiry recovery.

## Final artifact and trail audit

The final `build-guest.ts` publication branch is coherent. A new staging directory is renamed first and marked published; an existing destination is accepted only after full verification. Both branches then apply `0444` to every published file and `0555` to the root and two expected subdirectories before pointer promotion. A successfully renamed destination is deliberately preserved if later hardening or pointer work fails, while an unpublished staging directory has its own permissions restored and is removed. This makes the operation recoverable without deleting a valid content-addressed result. Reuse still relies on cryptographic verification because a hostile filesystem owner can restore write permission, and the documentation states that limit.

The saved evidence at `docs/research/m1-image-provenance-verification.json` is internally consistent with the trail:

- It identifies native session `59921`, provider scope as local OrbStack with simulated control-plane observations, and `cloudResourcesCreated: 0`.
- Manifest, public-input and transfer digests are complete 64-hex values. The image version is the expected prefix of the recorded public-input digest.
- Both clone records have distinct machine, SSH, TLS and allocation identities. Their scan counts match the reported 125 files and zero matches, with exact byte counts of 592500 and 590270.
- The subsequent publication record names session `44164`, same-manifest reuse, `0444` files, `0555` directories and no temporary staging remainder.
- Its limitations explicitly say that no Hetzner snapshot/provider boot, operator journal or release promotion exists and that read-only publication does not resist a hostile filesystem owner.

`DECISIONS.tsv`, `PROGRESS.md` and `CONTEXT.md` agree on the selected digest/version, sessions, local cleanup and unfinished provider scope. They distinguish the native image drill from the composed enrollment check, describe provider observations/activation as fixtures, state that no paid resource was created, and keep commit/Linux CI pending. `CONTEXT.md` names the three ownership paths whose absence was checked. The evidence JSON records the cleanup conclusion rather than embedding those path names or the literal final OrbStack inventory; this is adequate when read with the linked trail, but it should not be described as a standalone transcript or command log.

No transcript directory was supplied, so this review makes no transcript-audit claim.

## Final attention flags

No remaining code blocker was found within the local image-provenance and release-crypto milestone. The original P1 is closed by the trusted preflight and native Ubuntu proof. The validation supplied by the parent reports session `44164` passing 167 tests in 20 files, typecheck, lint, formatting, shell and skill checks, plus native composed enrollment; session `59921` passed installation, sanitation recovery, two clone boot/runtime/reboot checks, token scans and complete local VM/record cleanup. This reviewer did not rerun those commands and relies on the saved artifact and append-only trail.

The sole open review finding remains intentional future scope: provider/current-state proof and promotion. Do not mark the overall image-publication implementation complete, configure a signed release as current, or claim a verified Hetzner image until the platform journal, authenticated first SSH connection, exact snapshot/source/verifier observations, gross admission, reconciliation, cleanup and bounded live drill are implemented.

## Post-audit evidence update

The final read-only cleanup check now records the literal empty local VM inventory and all three absent ownership paths in the verification JSON. Implementation b891c716bc2ff88811ae7bcff778897c15673613 was subsequently pushed. Linux CI 34078153918 passed the frozen install, 167-test full check, formatting, fresh PKI setup, all three native smokes and cleanup in 2m6s. This adds external CI evidence; it does not change the unfinished provider publication scope.

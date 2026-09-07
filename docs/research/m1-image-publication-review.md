# M1 retained image publication review

Reviewed by `gpt-5.6-sol` against implementation commit `b72f992b2f9163f25c2e919c31273d4cfa58cf6a`. This was a code, artifact, and decision-trail review. No active-workspace transcript directory was supplied, so this report does not claim transcript coverage.

## Result

No implementation blocker remains in the reviewed retained-publication checkpoint.

Publication first saves unsigned evidence reconstructed from the admitted build, sanitized builder, confirmed stop and snapshot, and verified guest boot. The build then enters `releasing`, where cleanup may delete only temporary resources. Signing occurs after those resources are recorded absent and after a fresh effect-labelled provider observation of the retained snapshot. The signed release and `retained` state commit atomically. Cancellation from `releasing` or `retained` enters the existing full-abort cleanup and deletes the snapshot as well.

All image-selection and retained publication replay paths use the same resolver. Direct selection, retained controller replay, and retained publish replay verify the signature against the current key policy, recheck the exact live snapshot and effect labels, detect cancellation after provider I/O, and verify the signature again after the read. This resolves the review finding that the controller previously returned a stored release without current trust and ownership checks.

Migration 0015 enforces the corresponding durable boundaries: evidence and publications are immutable, unsigned evidence precedes release cleanup, snapshot deletion is forbidden while releasing, temporary resources and pending effects must be gone before retention, and release publication must match the recorded evidence and live retained snapshot record. Retained builds release their open-build and VM reservations while preserving the conservative monthly snapshot reservation. Cleaned builds release that storage reservation.

## Verification and trail

The recorded evidence is internally consistent with the current documentation and append-only decision rows:

- Full session `70745` passed 321 tests across 29 files, typecheck, and lint. Final session `2970` passed typecheck, lint, and 15 focused publication tests, including key revocation on all release replay paths.
- Native session `27055`, completion `17636e`, exercised actual local Ubuntu builder recovery, two customer clones, verifier enrollment and health rejection, temporary VM deletion before signing, retained release selection, cancellation, and full abort. Cleanup check `1908e3` records no Orb machines, ownership records, or private fixture directories.
- Migration session `897340` applied migration 0015. Check `74a5d4` records all 16 migration hashes matching, with latest hash `adbc2e2f429eddee001864851447641feead32b3d749be6cf10a86c0fe312899`.
- Local CLI session `85974` passed. Base check `d09ef3` records zero active allocations, simulated servers, simulated primary IPs, and open image builds.
- Format session `64318` passed after formatting the generated migration snapshot. The verification artifact preserves the initial formatting correction in its `format.note` and records the later successful result.
- The three new `image-publication` decision rows accurately record the initial implementation, the replay-trust correction prompted by review, and the final native publication and cleanup evidence.
- Linux CI was pending at the independent review. Post-review verification `7c5206` confirmed run `34097317093` passed against the exact implementation commit at `2026-09-07T07:52:45Z`, including the full checks, formatting, fresh PKI, native PKI/SSH/enrollment and cleanup. The evidence artifact records that subsequent result.

## Remaining limitations

The native run proves real local Ubuntu, cloud-init, SSH, PKI, verifier runtime, temporary VM deletion, signing, selection, and full-abort behavior. Provider resources, snapshot creation, and snapshot ownership observations in that run are protocol fixtures. It does not prove Hetzner initial-boot injection, live snapshot creation or boot source, or production cleanup scheduling.

Customer allocation admission does not yet pin and consume a selected release. Production signing-key configuration, certificate renewal and operator recovery, live controller scheduling, and the full product milestones remain open. The immutable publication record is retained after cancellation as history, while its cleaned build state prevents further selection. No paid provider resources were created for this checkpoint.

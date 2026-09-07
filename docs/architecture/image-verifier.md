# Platform image verification

The implementation extends the selected image-publication design through build-owned enrollment and runtime evidence. Local verification passed. Retained publication is implemented in the next phase; production activation remains open.

## Caller and ownership

After a snapshot is confirmed, `advanceImageBuild` prepares one build-owned verifier bootstrap and creates its IP/server from that exact snapshot. A verifier runs the ordinary guest key generation, enrollment, service activation and restricted inspection path. It authenticates to a dedicated image-enrollment endpoint. The endpoint reads image-build journals and verifier records, never customer allocation tables.

The shared identity is explicit:

```ts
type GuestSubject =
  | { kind: 'allocation'; id: AllocationId }
  | { kind: 'image_verifier'; id: ImageBuildId };

signer.signHost({ subject, publicKey });
signer.issueProbeCredential(subject);
probe.readIdentity({ subject, address, trust, credential });
```

Naming and certificate validation derive from the validated subject. Allocation names remain unchanged; verifier names occupy a separate namespace. A credential, claimed proof, pinned address and configured trust must all identify the same subject. Certificate issuance does not itself grant customer or operator API authority.

Customer bootstrap/proof wire version 1 and customer SQL ownership remain intact. Verifier bootstrap/proof version 2 carries its explicit image-verifier subject, snapshot reference, pinned image and expiry. Shared guest code selects the matching enrollment reference and uses one key/certificate installation path. It must not invent customer account, machine, allocation or operation identifiers. The public runtime response exposes verifier machine ID in addition to boot ID so the controller can compare it with the sanitized builder's installation receipt.

## Module boundaries

- Contracts own subject, verifier bootstrap/proof/runtime schemas and conversions from each versioned wire shape.
- PKI owns namespace derivation and bounded subject-bound certificates. Remote owns fixed read-only SSH commands and exact subject/trust checks.
- Guestctl owns one atomic key and certificate lifecycle, with owner-aware metadata, proof, enrollment payload and runtime response. Image boot validation still requires a sanitized source and fresh machine identity.
- `image-verifier.ts` owns build-specific bootstrap preparation, admission-bound token encryption, claimed/issued identity and bounded signing history. A dedicated enrollment service verifies exact provider effect/resource/snapshot ownership before direct SSH proof and signing.
- The image controller owns next-step selection and runtime verification. Completion records exact source snapshot/server, distinct verifier server/machine/boot identity, input manifest and observed health. These receipts, not a successful HTTP enrollment alone, authorize later release promotion.

## Durable lifecycle

Preparation records an immutable bootstrap intent before server rendering. Token recovery binds build, exact snapshot, image, endpoint and expiry; provider commands contain references only. Enrollment waits for the matching confirmed verifier create effect. It checks active build/deadline, current server/IP ownership, actual boot image, signer trust, CSR identity and direct pinned SSH proof before claiming keys. Claimed keys cannot change. Each signing attempt is recorded before the external issuer call, with durable limits/cooldown. Issued certificates and token erasure commit together; same-key replay returns the first certificate bundle.

Runtime uses a short-lived credential forcing only guestctl inspect. It re-observes owned resources, requires the recorded issued identity, verifies image/component/proxy/disk health and compares verifier identity with the builder. Cancellation and expiry prevent fresh verification work, while uncertain provider effects and owned resources remain eligible for reconciliation and cleanup.

Full abort removes every resource, including a published snapshot. Retained publication uses a separate cleanup intent: temporary VM/IP/access resources disappear before signing, while the verified snapshot remains charged under explicit retention. This phase is implemented in `image-publication.ts`.

## Verification required

Use PostgreSQL tests for ownership, token binding, replay, signing budgets, cancellation, expiry and crash handoff. Native PKI/SSH/guest tests must exercise both subject namespaces, reject cross-subject use, preserve exact certificate constraints and prove the verifier's actual guest boot. A local protocol snapshot is not provider snapshot proof. Keep live activation gated until the complete bounded lifecycle and cleanup can run against one cheap admitted Hetzner offer.

## Current checks

Shared native PKI and SSH checks passed both namespaces. The full suite passed306tests/28files with typecheck and lint. Applied migration0014 adds verifier persistence, and all15migration hashes match. Native `smoke:builder` passed two customer clones, a build-owned verifier, unhealthy service rejection and full cleanup. The added unseeded isolation assertion then exposed an SSH socket before keys existed. Sanitation now installs `ConditionPathExists` for the guest host key on both SSH units, preventing startup even if cloud-init enables them again. A manual check kept both units inactive. The rebuilt native run passed the unseeded listener check, later guest enrollment and runtime checks, and full cleanup. Evidence is in `../research/m1-image-verifier-verification.json`.

The OrbStack fixture starts a clone before installing its NoCloud seed and then reboots it. It checks that this unseeded interval has no guest identity, principals, SSH listener or application listener. This establishes the observed pre-bootstrap state and the later seeded enrollment path, not bootstrap injection on the initial provider boot. Real Hetzner initial boot and snapshot association still require the bounded provider drill.

Retained publication is now implemented in `image-publication.ts`; see [image publication](image-release.md#retained-publication-and-selection). Production scheduling, allocation pinning and real Hetzner proof remain open.

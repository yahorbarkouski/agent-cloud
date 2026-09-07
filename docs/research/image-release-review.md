# Image release arena cross-judge

## Verdict

Use **Candidate A** as the base, with two mandatory corrections before implementation: adopt Candidate B's explicit acyclic input-manifest construction, and authenticate the first SSH connection with a pre-generated disposable host key whose private material is referenced through a secret handle and never serialized in an effect command or journal row. Candidate A has the most complete combination of truthful platform ownership, retained-snapshot economics, signed-release consumption, explicit no-fallback policy, and duplicate-safe recovery. It is not implementation-ready as written because its first host-key observation is still TOFU and its provenance shape leaves two alternatives open.

All three candidates agree on the important architectural boundary: a fixed Hetzner image-release state machine, sibling platform tables without customer/allocation foreign keys, per-resource persisted intent, stable ownership labels, signed release metadata, and consumption through the existing `GuestImage`/bootstrap path. This convergence is strong enough that another design round is unnecessary.

## Scores

| Criterion | Candidate A | Candidate B | Candidate C |
|---|---:|---:|---:|
| 1. Full provenance and authenticated release | 4 | 5 | 2 |
| 2. Platform ownership, intent, unknowns and duplicates | 5 | 4 | 5 |
| 3. Gross limits, storage, deadlines and retention | 5 | 4 | 4 |
| 4. Isolated, authenticated builder access and secret handling | 2 | 1 | 1 |
| 5. Typed, bounded design and existing-path integration | 4 | 4 | 5 |
| 6. Recovery and provider verification | 4 | 4 | 5 |
| **Total** | **24/30** | **22/30** | **22/30** |

### Candidate A — 24/30

Candidate A is the best base. Its input set names installer, units, sudoers, SSH configuration, bundled tooling, downloaded artifacts, OS base and public trust; its signed release connects those inputs to sanitation, provider snapshot and `GuestImage`. The remaining provenance defect is ambiguity: it proposes either embedding inputs in `GuestManifest` or keeping a sibling object, so it does not settle the hash graph.

Its journal is the clearest of the three about every owned resource, including verifier, SSH key, firewall, Primary IP and snapshot. It forbids a new create while a prepared or unknown create exists, records all duplicate IDs and refuses to guess during cleanup. The budget separates gross VM/IP admission from a snapshot size and gross monthly ceiling, acknowledges powered-off billing, permits cleanup after expiry, and gives retained images both a deletion time and storage ceiling. It is also the only candidate to reject fallback explicitly.

The major defect is builder authentication. Pinning the first scanned key after checking only that the target is the provider-observed IP does not authenticate that key; an attacker on the first connection can still supply it. `ssh -F none` should also be `ssh -F /dev/null`. Recovery coverage is present in the state-machine semantics, but the proposed tests omit several required interruption points and a real low-cost provider drill.

### Candidate B — 22/30

Candidate B has the strongest provenance construction. `publicInputsDigest` is computed over a canonical public-input list that excludes the derived `image.json`; the manifest contains that digest, and transfer checksums may then cover the manifest. This gives an explicit acyclic order and should be grafted into A.

Its proposed pre-generated disposable host key can authenticate the first SSH connection because the public key is known before boot. However, the design also says the exact provider command is persisted and that the create-server cloud-init writes the host private key. Taken together, that serializes a plaintext private host key in the journal. “Encrypted private-key references locally” does not repair the contradiction unless the journaled command contains only a secret reference and the executor materializes sensitive user-data outside the public command record. The host key must be removed during sanitation as machine-specific access material.

Candidate B also permits an “explicit same-priced configured replacement,” which violates the hard no-fallback requirement. Its single gross maximum and 40 GiB/48-hour retention are bounded, but the design is less explicit than A about separate builder/verifier accounting and retained storage cost. The resource/effect model is sound, though verifier creation is missing from the command union and unknown deletion recovery is mostly asserted rather than specified.

### Candidate C — 22/30

Candidate C has the cleanest state-machine split: a pure planner, narrow executor, typed phase union, transactional channel promotion, and cleanup that can run after deadline without admitting capacity. Its test matrix most directly covers interrupted installation, sanitation/access loss, power-off, uncertain snapshot creation, source deletion, snapshot deletion and a real provider boot. These are valuable grafts.

Its provenance graph is defective as sketched. `publicInputs` includes a manifest while the manifest/admission contains `inputsDigest`; hashing that list therefore risks the forbidden self-reference unless the manifest entry is explicitly excluded from the pre-manifest digest or split into pre-manifest and derived artifacts. Builder host trust is also unauthenticated TOFU: recording the first provider-IP SSH scan before upload does not establish that the observed host key is genuine. The release's `verifiedBoot.allocationId` risks implying a customer allocation for the verifier; verification needs a platform build-owned enrollment/boot record instead.

Candidate C has good gross price facts, hourly bounds, a 40 GiB cap and retention deadline, but it should persist an explicit maximum gross snapshot charge rather than leave that bound to inference. Its deletion and reconciliation story is otherwise the most concrete.

## Required grafts into Candidate A

1. **From B: make the provenance construction singular and acyclic.** Define `PublicInput[]` over installer, service units, sudoers, SSH configuration, `guestctl.mjs`, downloaded artifacts and other staged public files, excluding derived `image.json`, `image-inputs.json`, release metadata and checksum files. Canonically hash that list into `publicInputsDigest`; place that digest in `GuestManifest`; then hash the finalized manifest separately. The sanitation receipt binds both digests. The provider receipt binds the stopped source server and snapshot. The signed release binds both receipts, snapshot ID, verified boot evidence and the derived `GuestImage`. Remove A's “either” choice.

2. **From B, corrected: authenticate SSH before the first connection.** Generate a per-build management key and disposable host key locally. Persist only public keys, fingerprints and encrypted/private-key secret references. The journaled create-server command must contain a redacted secret reference, never cloud-init with the plaintext host private key. At execution, resolve the secret into ephemeral request material, inject the disposable host key, connect to the provider-observed Primary IP using a prebuilt `known_hosts`, `ssh -F /dev/null`, `IdentitiesOnly=yes`, and `IdentityAgent=none`, and reject any mismatch before sending inputs. Sanitation must delete the disposable host private key, management authorized key and other temporary access state before producing its receipt.

3. **From C: adopt the planner/executor split and recovery matrix.** Make planning pure over persisted rows and time; let the executor perform one journaled effect and append its outcome. Add tests for interruption after installation, sanitation with subsequent access loss, confirmed stop, unknown snapshot response, source deletion, unknown/duplicate deletion observations and snapshot deletion. The provider drill must boot the snapshot through the real bootstrap/readiness path, use an explicit temporary HTTPS tunnel where required, prove identity by direct SSH to the provider-observed IP, and clean every verification resource or leave durable unresolved ownership.

4. **From C: promote releases transactionally.** A verified, signed retained release becomes current for a channel in one database transaction. A verification-only snapshot may produce audit evidence but cannot become a consumable current release after its snapshot is deleted.

## Rejections and corrections

- Reject B's same-priced replacement. Admission is for exactly CPX12 in `nbg1`; unavailable or changed catalog evidence blocks before mutation. There is no server-type, region, warm-pool or expensive fallback.
- Reject A and C's first-seen SSH scan as authentication. Provider-observed IP proves the destination resource association, not the host key presented on the network.
- Reject B's plaintext host-key-bearing cloud-init in the persisted exact command. Persist a secret reference and non-secret digest; keep private key bytes out of journal rows, logs and release metadata.
- Reject C's manifest-as-input hash unless it is moved after the canonical public-input digest. Preserve one directional chain: public inputs → manifest → sanitation receipt → provider snapshot receipt → verified boot → signed release → `GuestImage`.
- Reject C's verifier `allocationId`. Verification is owned by the image build and must not fabricate customer/account/allocation state.
- Reject generic `command: unknown` as the final A contract. Use a discriminated `ImageProviderCommand` union, including create/delete for SSH key, firewall, every Primary IP, builder, verifier and snapshot, plus power-off and any deletion-protection transition.
- Do not silently choose or delete one item from duplicate reconciliation. Persist every observed ID, block fresh creation, and let cleanup delete only identities proven owned by exact labels and recorded intent. Ambiguous resources remain explicit operator work.

## Verification bar for the synthesized design

The implementation should not activate production startup wiring until contract, journal and provider tests pass and one bounded drill succeeds. Admission must refresh the catalog and all six relevant resource counts before mutation; use gross USD prices, a total VM+IPv4 ceiling covering builder and verifier, a 40 GiB conservative snapshot ceiling, a maximum gross snapshot charge, and an absolute deadline. Powered-off time counts. Cleanup remains runnable after failure or expiry and cannot create paid resources.

The native drill passes only when the same sanitized builder is observed stopped before snapshot creation, a lost create response cannot cause a second create, a fresh VM boots from the exact snapshot, release signature and trust-key validity are checked before deriving `GuestImage`, runtime evidence matches the admitted manifest/input digests, and all verification resources are confirmed absent. A retained result must leave only the snapshot and signed release, with explicit `deleteAfter`, maximum storage charge, key-retention rule and resumable deletion ownership.

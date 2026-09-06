# Guest design cross-judge

## Scores

| Criterion | A | B | C |
|---|---:|---:|---:|
| 1. Identity and allocation binding | 5 | 2 | 4 |
| 2. Crash, retry, cleanup, and secret safety | 3 | 1 | 2 |
| 3. Executable M1 readiness path | 4 | 5 | 4 |
| 4. Image and low-cost verification | 4 | 3 | 2 |
| 5. Explicit types and clear ownership | 4 | 4 | 4 |
| **Total** | **20/25** | **15/25** | **16/25** |

## Verdict

Use **Candidate A** as the base. It gives enrollment the strongest admission rule: secret, allocation, nonce, owned server, owned Primary IP, and socket source IP must agree. It also states the key retry invariant plainly and uses separate durable bootstrap and enrollment records. Its local live-test route can work without DNS when the operator exposes an IP-literal TLS endpoint and pins its enrollment key.

A still needs a precise repair at the provider boundary. Its prose says the journal stores only a bootstrap reference, but `ensureGuestBootstrap()` returns plaintext and the provider must somehow receive rendered `user_data`. The implementation must make this unambiguous: persist one encrypted bootstrap envelope, journal only its stable reference or ciphertext and a digest, decrypt only in memory immediately before the transport call, and redact the whole bootstrap field from logs and receipts. The prepared attempt must retain enough encrypted material to reconstruct byte-identical `user_data` after a crash without creating a new secret. Define expiry behavior too: expiry after provider submission must block for operator recovery or cleanup, never mint a replacement identity for the same allocation.

Graft these pieces into A:

- From **B**, take the concrete OpenSSH verification contract: a `UserKnownHostsFile` containing only the platform host CA, host-certificate principals for both machine and allocation, `guestctl inspect`, and the mTLS proxy probe. Also take its explicit smoke-test budget guard and full sanitation list.
- From **C**, take the `completeProviderAllocation()` and `completeVerified()` split. It makes the point where provider ownership ends and guest readiness begins easy to test. Keep cleanup authorized only by allocation-owned provider resources.

Do not graft B's journal ownership of submitted cloud-init or its tunnel identity model. Do not graft C's LAN-address live-test assumption.

## Hard constraint violations and material gaps

**Candidate B violates the plaintext-secret constraint.** It explicitly stores rendered `guestBootstrap.userData`, including the bootstrap secret, in `provider_attempts` and calls that command the durable owner. Log redaction does not remove the database exposure. Its tunnel also hides the guest's socket source, while the design explicitly declines to use source identity. Provider observation proves that a server exists; it does not prove that the enrollment request came from that server. A leaked secret could therefore enroll attacker-chosen keys.

**Candidate C does not provide the secret recovery it claims.** `guest_bootstraps` has a hash but no ciphertext column, while `loadOrCreateGuestBootstrap()` says it decrypts a sealed value. Its provider command also receives `bootstrap` without defining whether that journaled field contains plaintext. This leaves crash recovery unverifiable. Its local path assumes a Hetzner guest can call `http://<dev-lan-ip>:4319`; a private LAN address is normally unreachable from Hetzner. The live test needs an operator-controlled public IP endpoint, direct source-IP preservation, and IP-literal TLS key pinning, or another route that cryptographically proves the originating guest despite a tunnel.

**Candidate A has no stated hard violation, but the plaintext boundary is currently ambiguous.** Resolve it before coding. Also replace the loose claim that Hono supplies the TLS peer address with an explicit trusted server-adapter API and test that forwarded headers cannot affect enrollment identity.

All three correctly keep readiness after provider confirmation, preserve guest-generated SSH/TLS keys, avoid distributing provider or CA private keys, separate image-build boot from shipped first boot, and leave prepared or unknown provider attempts to reconciliation.

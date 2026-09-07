# PKI logging correction review

Reviewed 2026-09-07 as an artifact and source review. I did not read CA logs, token files, private keys, or other private PKI material, and I did not operate the CA.

## Findings

1. **P1 — the existing-CA migration can lose the restart requirement across a crash or lost result.** `setup-pki.ts` atomically replaces `ca.json` and only afterwards records the need to restart in its stdout result. If the process stops after `rename` but before the result is consumed, a rerun sees no `logger`, returns `restartRequired: false`, and can leave an already-running CA using its old in-memory logger. The current development CA was explicitly force-recreated and the subsequent native smoke covers that instance, so this does not invalidate the reported remediation. It does make the general migration contract incomplete. Make restart application durable, or make the supported setup sequence recreate/restart the CA unconditionally. A durable desired/runtime configuration generation that is cleared only after a verified restart would preserve the optimization without this ambiguity.

2. **P2 — phrase the smoke evidence as successful-request coverage.** The smoke starts its observation window before issuing real host, probe, runtime, and TLS certificates; it fails closed when Compose output cannot be read; and it never prints the captured output. Its JWT/`ott` detector is appropriate for the observed Step token form. It does not exercise malformed or rejected CA requests, logging-driver loss/rotation, external Docker log collectors, or other retained historical copies. The public claims currently say “subsequent service output” or “during native signing,” which match the evidence. Avoid broadening this to “tokens can never be logged,” and add a rejected-signing case if that failure path becomes part of the security claim.

3. **P2 — historical deletion is local-container scoped.** Recreating the container removes that container's retained Docker logs; it cannot prove deletion from backups, host collectors, terminals, or previously copied artifacts. The four disclosed fixture OTTs were consumed and the fixture was removed. The private count of 363 is evidence of prior retention, not evidence that every copy was erased. Keep the wording scoped to historical container logs, as the current decision and context do.

## Verified behavior

Pinned Smallstep `v0.30.2` conditionally constructs and attaches the access logging middleware only inside `if len(cfg.Logger) > 0` in [`ca/ca.go`](https://github.com/smallstep/certificates/blob/v0.30.2/ca/ca.go#L341-L353). Omitting `logger` therefore disables that middleware while leaving the always-installed request-ID middleware in place. This supports the code comment and the selected correction.

For a newly initialized CA, `setup-pki.ts` removes the generated logger before publishing the staged PKI directory. For an existing CA, it parses the complete top-level JSON object, removes only the logger property, and replaces `ca.json` through a same-directory owner-only temporary file. It does not regenerate or move issuer keys, provisioners, database state, public roots, or the recorded identity. JSON round-tripping preserves ordinary unknown keys, although it cannot preserve formatting.

`smoke-pki.ts` verifies the on-disk omission before any signing, observes only the interval it initiated, captures bounded Compose output in memory, checks both stdout and stderr, and emits only a fixed status object. The reported native smoke and typecheck are supplied trail evidence; I did not rerun them. No customer signer, malformed-request logging path, production log collector, or historical-copy erasure is proven by this bounded review.

## Status

The source-level premise and the completed force-recreate remediation are sound. Findings 2 and 3 are claim boundaries rather than blockers to continuing isolated signer work.

## Follow-up resolution

The 2026-09-07 follow-up resolves finding 1. Existing-PKI setup now always returns `restartRequired: true`, including when every managed file already matches, because the filesystem cannot prove which configuration a live process loaded. The supported `pki:up` command now always passes `--force-recreate`. A crash or lost setup result can therefore be followed by the same setup/up sequence without suppressing the required recreation; repeated recreation preserves the mounted PKI state and keys.

The replay artifact reports `created: false`, `restartRequired: true`, and the same recorded root fingerprint. The supplied replay smoke artifact contains the fixed `caTokenLogging: absent during native signing` result and no detected JWT/`ott` pattern; I inspected those properties without displaying service output. The earlier full-check artifact records typecheck, lint, and 445 passing tests across 38 files in 113.58 seconds. It predates the small unconditional-restart change, so the replay setup/up/native-smoke evidence is the direct check of that delta.

The latest canonical `m2-signer` and `pki-logging` decision rows accurately record the initial disclosure, redaction, logger omission, recreation, successful native issuance, and removal of the old container's logs. They do not yet cite the replay evidence or this resolution. A follow-up decision row should record the unconditional recreation contract and reference `.local/pki-log-policy-replay.json`, `.local/pki-log-policy-replay-smoke.log`, and this review; the historical-copy and successful-request limits above still apply.

**Final checkpoint status:** no remaining blocker in this bounded PKI logging correction. This establishes the local supported setup/up behavior and successful native SSH/TLS issuance. It does not complete the customer signer or prove external historical log erasure and rejected-request behavior.

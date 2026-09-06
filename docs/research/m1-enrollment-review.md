# M1 guest enrollment checkpoint review

Reviewed the dirty enrollment checkpoint with the configured **gpt-5.6-sol** reviewer. Scope was `guest-enrollment.ts`, migration 0007 and its Drizzle schema, the generic `withMachineLock` result, signer trust and CSR validation, the optional `/guest/enroll` route, the new lifecycle handoff, and focused enrollment tests. I made no implementation changes.

I independently ran a build and the final focused enrollment suite: **9 tests passed**. The suite uses PostgreSQL and the simulated provider, with mocked signer and SSH probe ports. It demonstrates transaction, lock, HTTP, provider-record, retry, and replay behavior. It does not apply migration 0007 to the development database or run a real guest enrollment through Smallstep and OpenSSH. Earlier PKI and SSH smokes prove those primitives separately, not their composition here. No cloud resource or credential was used.

## Findings and resolution

The first review found four concrete boundary gaps, all corrected in the reviewed code.

Enrollment initially accepted every create operation except `failed`. That could sign while lifecycle was blocked for an unknown, duplicate, or mismatched provider outcome. The service now requires the exact `waiting_guest/enrollment` state and matching server ID, plus exactly one confirmed VM-create resolution for that server. Tests reject blocked, queued, and terminal states before probe issuance.

Provider labels were initially checked against the labels stored in `provider_resources`. Because that JSON is not a complete ownership invariant, an empty or partial stored map could make the comparison vacuous. The service now derives all five required labels from immutable bootstrap account, machine, allocation, and operation identity, then checks both journal rows and live provider observations against them. Empty and incomplete journal-label regressions pass.

Signer trust was exposed as mutable public data even though enrollment treated it as evidence for the signing closures. The signer and nested trust object are now frozen. The actual closures retain parsed CA values. CSR validation runs before any probe issuance, and signing revalidates the same request and inspects the returned certificate.

Successful issuance initially left the operation in the enrollment stage. Identity issuance, encrypted-token erasure, the `waiting_guest/runtime` transition, one audit event, and worker wakeup now commit together. Same-key issued replay repairs only the matching enrollment stage and does not reopen blocked or completed operations. The controller derives enrollment versus runtime from persisted identity, preventing a later provider reconciliation from downgrading the stage.

## Current assessment

Bootstrap authentication is fail-closed: lookup requires a live allocation, constant-time token-hash comparison and unexpired immutable metadata. Same-key issued requests replay persisted certificates; conflicting key, CSR, or image claims are rejected. The direct proof address comes only from a live provider observation of the recorded Primary IP. The service checks the recorded VM/IP count, IDs, provider, admitted type and region, complete ownership labels, assignment, address agreement, and running power before using raw host-key pinning. It compares every returned proof field with the proposal and pinned image manifest before claiming keys.

The session advisory machine lock serializes enrollment with lifecycle work and now returns an explicit acquired/busy union without weakening existing cleanup on unlock failure. External provider, CSR, SSH, and CA work occurs outside a database transaction while the session lock remains held. The claimed identity is durable before certificate effects. A lost signing response consumes an attempt and cannot change claimed keys.

Migration 0007 serializes attempt allocation by locking the bootstrap row and retains immutable sequence history. SQL enforces active, unconsumed bootstrap state and hard limits of 12 probe and 4 identity attempts. Process-local probe credentials are reused until near expiry, so read retries do not silently issue new certificates. One lower-severity limitation remains: the 30-second cooldown compares a database-generated timestamp with `Date.now()`. Host clock skew can shorten or lengthen that interval, although the SQL budgets remain absolute. Use database time if this control must hold across hosts.

The unauthenticated route is appropriately token-authenticated, schema- and body-bounded, and omitted unless an enrollment service is configured. Errors do not include the token, private key, CSR contents, or provider payload.

## Attention

reviewed by gpt-5.6-sol

- No high-confidence blocker remains in the reviewed enrollment/storage boundary after the four fixes.
- Treat the passing focused suite as database and mocked-port evidence; run the composed enrollment against real Smallstep/OpenSSH before claiming end-to-end guest proof.
- Keep live gates closed until provider-reference rendering, guest image/bootstrap, runtime readiness, renewal, and a bounded VM boot are verified.

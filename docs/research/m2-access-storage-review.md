# M2 access storage checkpoint review

Reviewed 2026-09-07 from the isolated `.local/customer-ssh` worktree against the selected customer SSH design. Scope is contracts, schema/records, draft migration0020, and ten reported passing contract/PostgreSQL tests. The full check was still running. No endpoint, signer, authority transaction, gateway, guest capability, or CLI exists yet, so this review makes no claim about those paths.

## Blocking findings

1. **[P1] Reject malformed immutable admission data in PostgreSQL.** `guard_access_session()` verifies that `identity_pin` has the expected keys, alias, and digest, but it accepts invalid/null provider, server ID, Primary IP ID, host CA, and guest host key values. It does not validate `gateway` at all. For example, an exact-key object with JSON null identity values and `{}` as gateway can be inserted in `pending`; the trigger then makes those fields immutable. The TypeScript record parser will reject the row later, leaving a durable poison record that cannot be corrected or deleted and may retain globally unique ticket/idempotency identities.

   Add SQL constraints/trigger validation for the durable minimum: both values are objects with exact keys and correct JSON scalar/array types; provider is `hetzner|simulated`; IDs and host material are nonempty and bounded; gateway ID/origin are nonempty and bounded; `egressCidrs` is a bounded nonempty string array with no JSON nulls. Either validate canonical key/CIDR/origin forms in SQL or admit through a single guarded SQL function and deny raw inserts to the runtime role. Add raw-SQL tests for JSON null, missing/extra keys, wrong scalar/container types, invalid provider, empty IDs, invalid gateway origin/CIDRs, and malformed immutable public key. Zod-only tests do not prove storage integrity.

2. **[P1] Persist the CA-attempt receipt in an immutable relation.** On `attempted -> issued|unavailable`, `attemptedAt` disappears from `access_sessions`. The trigger inserts a generic `audit_events` row, but this table has no update/delete guard or one-attempt uniqueness constraint. Therefore the database prevents a second transition while the session exists, but it does not retain immutable signing-attempt history as claimed. A direct audit deletion or rewrite erases the only receipt.

   Prefer a one-to-one `access_signing_attempts` row keyed by session ID, inserted atomically with `pending -> attempted`, with immutable session/account/grant/machine, timestamp, and later result/receipt fields. A guarded immutable event table is also acceptable if it enforces exactly one attempt per session and cannot be updated/deleted. Tests should reject a second attempt row, mutation/deletion of the receipt, and transaction rollback that would change state without its receipt.

3. **[P1 proof gap] Exercise concurrent signing transitions and closed receipt uniqueness.** The simultaneous ticket-claim test is meaningful: two actual PostgreSQL updates race and exactly one wins. Signing coverage is sequential only. Race two `pending -> attempted` updates and prove one audit/attempt receipt, then race distinct terminal results from `attempted` and prove exactly one immutable result. The migration creates `access_gateway_connection` using live or `previous` claim IDs, but no test proves a closed row still prevents another session from reusing the same gateway/instance/connection tuple. Add that test, plus a different gateway-ID control.

## Confirmed foundation

- Branded IDs, canonical Ed25519 request keys, fixed lowercase ticket/fingerprint hashes, strict request shape, WSS/loopback gateway origins, non-public gateway CIDRs, allocation host aliases, exact target pins, bounded failure/close reasons, and record-level deadline checks match the selected design.
- Composite foreign keys bind session account/project/machine, account/machine/allocation, and account/grant. The added allocation uniqueness is ordered before its foreign key in migration0020.
- SQL makes ownership, request material, pins, gateway, and absolute deadlines immutable; forbids deletion; admits only pending/unclaimed; permits one-way pending/attempted/result and unclaimed/claimed/closed transitions; preserves the prior claim inside closed state; prevents reopening; and checks event times against database time.
- Issuance arithmetic now has the correct grouping. Ticket validity is capped by issued+60 seconds, issue deadline, and hard deadline; certificate validity is capped by issued+5 minutes and hard deadline. Attempt, publication, and claim require strict time remaining. SQL cannot itself prove the hard deadline equals the grant-ancestry horizon; the later locked admission/finalization authority path must establish that.
- Exact target equality includes provider/resource IDs, allocation alias, host CA, guest host public key, and image digest. Address is a host `inet` without a prefix and port is exactly22. Current storage correctly does not pretend this proves live provider ownership.
- Malformed issuance/connection objects generally fail closed through exact-key checks and timestamp/UUID casts. Closing pending/unclaimed authority without enabling later signing is covered. The contract tests catch arithmetic boundaries, changed pins, malformed SSH wire keys, caller-added request fields, unsafe origins/CIDRs, invalid claim timing, and missing retained receipts.

After the three items above, this is a sound persistence foundation. Authorization, idempotent admission/rate queries, database-time ancestry rechecks, signer certificate inspection, exact resource claim predicates, revocation/destroy closure, and gateway transport remain separate unimplemented checkpoints.

## Fix review

The revised draft migration and tests resolve all three original P1 findings.

- Admission now validates exact JSON object keys and scalar/container types, provider/ID bounds, canonical Ed25519 customer and guest-host wire keys, accepted Ed25519/P-256 CA wire forms, allocation host alias, gateway identity/origin, and a bounded unique CIDR array. Raw PostgreSQL tests cover JSON null, missing/extra keys, wrong containers, invalid wire values, unsafe origins and invalid CIDRs before a valid insert proves the guard did not reserve an identity.
- `access_signing_attempts` is a one-to-one receipt keyed by session. The `pending -> attempted` update creates it in an `AFTER UPDATE` trigger in the same transaction; the receipt guard rejects direct inconsistent insertion, update, and deletion. Rollback coverage proves state and receipt disappear together. The receipt survives terminal replacement of the discriminated issuance state.
- Real concurrent updates prove exactly one signing attempt/receipt and exactly one distinct terminal result. The earlier simultaneous-claim test still proves one claimant. New coverage proves a closed session retains the gateway/instance/connection tuple uniqueness and that the same instance/connection IDs remain usable under a different gateway ID, matching the index scope.

The regenerated0020 contains both tables and places the new allocation uniqueness before its dependent foreign key. The reported fifteen targeted tests passed after the recorded SQL alias correction. The migration remains a draft not applied to a retained/main database, so regeneration did not alter an applied migration. The full check had not completed at this review point.

### Remaining P2 compatibility finding

Canonicalize the gateway origin in the TypeScript contract or make its acceptance profile exactly match SQL before endpoint admission. `accessGatewaySchema` checks a JavaScript `URL`, whose protocol and hostname accessors normalize case, but returns the original string. It therefore accepts spellings such as `WSS://GATEWAY.EXAMPLE` and a trailing-dot hostname such as `wss://gateway.example.`; `valid_access_gateway()` applies its lowercase label regex to the original stored string and rejects them. This is fail-closed rather than an authority bypass, but it means contract-valid input can fail durable admission.

Prefer a contract transform to one canonical serialized origin, followed by validation of that exact output, or share an explicit lexical profile and add contract/SQL parity cases for uppercase scheme/host, trailing dot, default/nondefault ports, IPv4 and bracketed IPv6. The CIDR and key profiles otherwise appear aligned for the tested forms.

With that compatibility correction, no storage blocker remains. Endpoint authorization, signer validation, live claim predicates, revocation closure, and gateway behavior remain deliberately outside this checkpoint.

## P2 correction

The remaining P2 above was stale and is withdrawn. The current `packages/contracts/src/access.ts` no longer uses `z.url()` for the gateway origin. `gatewayOriginSchema` applies a lowercase raw-string regex, explicit DNS label and length checks, literal loopback handling, port bounds, and bracketed IPv6 validation. It rejects uppercase scheme/host spellings and trailing-dot/slash spellings before any URL normalization.

I independently exercised the two cited examples against the current TypeScript schema and a disposable PostgreSQL database freshly migrated through draft0020:

| Origin | TypeScript | PostgreSQL insert |
| --- | --- | --- |
| `WSS://GATEWAY.EXAMPLE` | rejected | rejected |
| `wss://gateway.example.` | rejected | rejected |

The disposable database was closed by the fixture. This check found no different mismatch in those profiles. Permanent parity cases remain useful to prevent the TypeScript and PL/pgSQL copies from drifting, but they are regression coverage rather than a present blocker.

All three original P1 findings remain resolved, and no storage blocker remains in the reviewed scope. The fifteen-test log covers the corrected source; the broader full check was still pending when this correction was requested.

## Final storage status

The last lexical deltas preserve the reviewed authority boundary. TypeScript now requires exact 64-character hashes, rejects surrounding whitespace in request/gateway identifiers, and requires the gateway-origin regex match to consume the entire raw string, including a trailing newline. PostgreSQL independently checks exact hash length and permitted request-key/gateway characters before reserving immutable identities. These additions close end-anchor newline behavior without widening accepted URLs or CIDRs.

The permanent parity test runs a matrix of lowercase/uppercase and trailing-dot/path/newline origins, port bounds, strict IPv4, compressed/mapped IPv6, DNS labels, CIDR prefix spellings, public `/0`, null/empty arrays, and gateway IDs through both `accessGatewaySchema` and `valid_access_gateway()`, requiring identical results for every candidate. This is meaningful drift detection for the duplicated lexical policy. The admission test separately proves these invalid immutable fields fail before a valid insert.

Final evidence supplied for this source state:

- `.local/m2-access-storage-parity-test.log`: 16 focused contract/real PostgreSQL tests passed.
- `.local/m2-access-storage-receipts-check.log`: 444 tests across 38 files plus typecheck and lint passed in 109.46 seconds before the final parity case.
- `.local/m2-access-storage-final-check.log`: final typecheck, lint, and 445 tests across 38 files passed in 103.50 seconds.
- Isolated `docs/research/m2-access-storage-verification.json` records the checkpoint; formatting was still running when this final review update was requested.

No storage blocker remains. This verifies only the contract and durable storage foundation: it does not establish access admission/idempotency/rate enforcement, current authority or provider ownership checks, CA behavior, revocation/destroy closure, control RPC authentication, gateway transport, guest capability, native SSH, or customer usage. Migration0020 remains an unapplied isolated draft until checkpoint integration, while applied migrations0000–0019 remain immutable. The full cloud goal remains active.

At the time of this read, root CONTEXT/PROGRESS and the latest `m2-storage` decision row still described the prior three blockers and pending review/check. Refresh those status lines and evidence references before presenting or committing the storage checkpoint; their chronology is accurate but their current-summary wording is stale.

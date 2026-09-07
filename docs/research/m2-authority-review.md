# M2 authority checkpoint review

Reviewed 2026-09-07 from the isolated `.local/customer-ssh` worktree. Scope was the `auth.ts`/`auth.test.ts` diff and the selected SSH authority requirements. This is an artifact/source review; no transcript directory was supplied, I did not rerun the parent's suite, and this review makes no claim about SSH session code that has not been implemented.

## Finding

**[P1 before session leases] Make the authority walk and its database timestamp one consistent database observation.** `loadAuthority()` currently calls `databaseTime(db)` and then reads the leaf and each ancestor in separate statements. When passed the ordinary database executor, PostgreSQL `READ COMMITTED` permits those statements to see different committed snapshots. A concurrent revoke or ancestry change can therefore occur between rows. The returned `checkedAt` also precedes the entire walk; future gateway code must not turn `expiresAt - checkedAt` into a monotonic allowance after query/traversal latency, because that would add the elapsed latency back to the credential lifetime.

Implement the walk as one recursive SQL statement that returns the validated chain, earliest expiry, and PostgreSQL statement time, or require a transaction with a suitable consistent snapshot and take the authoritative time at the validation boundary. Preserve the depth/cycle/account checks. For the live gateway, return a database-derived remaining duration measured at the completed authority decision, then subtract request latency conservatively when anchoring the monotonic deadline. Account locks still serialize admission/revocation, but the shared authentication wrapper is intentionally callable outside such a lock, so the helper itself should not imply snapshot consistency it does not provide.

Add a concurrency test that pauses ancestry loading, revokes or changes an ancestor from a second connection, and proves the helper cannot return a mixed chain as current. Add a timing test that delays the walk near expiry and proves the returned remaining lifetime cannot exceed the lifetime remaining when validation completes.

## Confirmed behavior

- Persistent grant validity now uses PostgreSQL time. The `loadPrincipal()` compatibility wrapper routes existing authentication, lifecycle, cleanup, delegation, and revocation callers through `loadAuthority()`; the reviewed production diff leaves no grant-expiry `Date.now()` check in `auth.ts`.
- `expiresAt` is the minimum across the full validated chain, not merely the direct parent's expiry. `issueGrant()` bounds a child by that minimum and rejects expiry at or before database time.
- Missing parents, cross-account ancestry, cycles, revocation, and the existing depth bound remain fail closed. Revocation timestamps also come from PostgreSQL.
- The new tests meaningfully cover large positive and negative host-clock skew, an expired ancestor with an unexpired descendant, delegation beyond the grandparent horizon, cycle rejection, and the existing cross-account foreign-key boundary. The reported eight targeted tests are credible for these cases; the initial missing-build setup failure is environment evidence rather than a product failure.

Subject to the consistent-observation correction above, this is a compatible foundation for the M2 access-session deadline work. It does not yet prove atomic access admission, gateway checks, revocation closure, or monotonic live-session expiry; those remain later checkpoints in the selected design.

## Resolution review

The revised implementation resolves the P1 above. `loadAuthority()` now uses one bounded recursive statement. PostgreSQL supplies one MVCC snapshot for the ancestry, the materialized JSON observation completes before `clock_timestamp()`, and application validation rejects malformed, missing-root, cross-account, cyclic, revoked, expired, and over-depth chains. A complete 32-row path succeeds; a 33-row path leaves an expected parent after the CTE limit and fails closed. Earliest expiry and compatibility behavior remain correct.

The new tests are meaningful PostgreSQL boundary tests rather than mocks of the implementation. The temporary connection-local view holds the statement open while another connection commits revocation, demonstrating a complete pre-revocation snapshot followed by rejection on the next decision. The delayed near-expiry test demonstrates that expiry is compared with the clock after traversal. The 32/33 test proves both sides of the depth boundary. The reported eleven targeted passing tests support this checkpoint; the full check was still running when evidence was supplied.

One semantic distinction remains for later gateway implementation, but it is not an authority-loader blocker. Revocation visibility linearizes at the statement's MVCC snapshot, while `checkedAt` is sampled after materialization. Thus an already-running unlocked authentication statement may validly finish from its pre-revocation snapshot; M2 claim/finalization paths must continue to take the documented account lock when they require serialization with revocation. `checkedAt` proves completion-time expiry, not that every other authority field was re-read at that wall-clock instant.

The gateway must also convert the returned database horizon conservatively. It must not set `receiveMonotonic + (expiresAt - checkedAt)`, because response latency would extend authority. A safe construction uses the monotonic RPC start as the anchor for that database-reported remaining interval, or subtracts the entire monotonic request duration before anchoring at receipt. The later access-authority tests should inject response delay and prove that neither ancestry expiry nor the 15-second stale-authority deadline gains time in transit.

No further source change is required in this bounded checkpoint. The authority loader is ready to support access-session admission and locked authority checks, subject to the later RPC timing proof above.

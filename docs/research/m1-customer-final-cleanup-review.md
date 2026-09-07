# Final customer drill cleanup review

Reviewed 2026-09-07 without executing the script, reading credentials, or calling provider APIs.

## Verdict

No blocker was found in `.local/customer-drill-finalize.mjs`. It is appropriately fail-closed and deletion-only for the authorized final cleanup. At review time `.local/customer-drill-lifecycle.json` still had state `verified`, so executing now would stop at the first guard before database connection or provider construction. Run only after the lifecycle driver durably writes `verified_and_customer_cleaned` or `failed_and_customer_cleaned`.

## Verified boundaries

- The script binds both input artifacts to drill owner `2224a90a-acad-42f4-9081-e8fc08822ff7`, build `653dd67f-c002-4796-b894-27865aed9ec2`, and the exact isolated database name.
- It requires exact third customer server `164976022` and Primary IP `148484586` to be absent, then requires zero active customer allocations and provider-resource ledger rows before touching image resources.
- `requestImageCleanup` plus `cleanupImageBuild` enters the existing durable image cleanup planner. That planner reconciles retained build effects and returns only owned delete commands in cleanup mode. The provider's `renderBoot` callback throws, providing an additional guard against server creation. Cleanup respects snapshot pinning and resource dependencies, removes build access material, and must reach both `cleaned` and `accessRemovedAt` before continuing.
- Snapshot `429179158` is checked absent after durable build cleanup. The separate firewall deletion is constrained to exact ID `11587191`, exact managed/role/drill labels, and zero attachments. The script saves its deletion intent before the request, accepts only the exact not-found response as reconciliation, and confirms absence afterward.
- The final provider inventory covers servers, Primary IPs, snapshots, firewalls, and SSH keys project-wide. It refuses to delete any unexpected item and requires every total to be zero. Final SQL separately requires zero active allocations, customer resources, image resources, and uncleaned/access-bearing builds.
- Evidence is written mode `0600` before mutation stages and after material observations. Any failure becomes `recovery_required`; the connection closes in `finally`. Rerunning retains the fixed drill/build identity and repeats exact absence checks rather than treating an empty list as proof of an uncertain create.

## Nonblocking operational notes

- A firewall DELETE may complete asynchronously. The immediate exact read can therefore still observe it and mark recovery required; rerunning is safe and preferable to inferring success.
- A successful rerun after an earlier failure can retain the old `failure` property because the script does not delete it before setting the final state. Treat `state`, `completedAt`, and the later exact observations as authoritative, or clear that field in a future script-only cleanup. This does not weaken deletion safety.
- The final zero-inventory assertion is project-wide evidence at one observation time. Preserve the resulting artifact and provider response; it does not establish permanent future absence.

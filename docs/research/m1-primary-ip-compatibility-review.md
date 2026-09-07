# Primary IP wire compatibility review

## Verdict

**Approved; no blocker found.** This is a narrow compatibility correction for a wire form observed from Hetzner on 7 September 2026. It does not relax allocation ownership, label matching, resource identity, or server-assignment checks. Review was based on the repository diff, captured artifacts, and decision trail; no active transcript directory was supplied and no cloud call was made by this reviewer.

## Parser behavior

The captured response in `.local/customer-drill-primary-ip-wire.json` contains `assignee_type: "server"` with `assignee_id: null`. The previous equivalence check rejected that shape even though the resource was newly created and unassigned. The revised refinement in `packages/hetzner/src/index.ts:39-54` accepts exactly these combinations:

- `server` plus `null`: accepted and normalized to `{kind: "unassigned"}`;
- `unassigned` plus `null`: accepted and normalized to `{kind: "unassigned"}`;
- `server` plus a positive ID: accepted and normalized to `{kind: "server", serverId}`;
- `unassigned` plus a positive ID: rejected.

The mapping in `primaryIpRecord()` depends on the assignee ID, which is the authoritative identity needed by cleanup: null means no attached server, and a positive ID is retained exactly. The schema still requires an IPv4-compatible record, positive numeric IDs, labels, location, `auto_delete`, and a recognized type. It does not turn malformed or missing assignment fields into unassigned state.

Creation responses, exact-ID reads, and paginated inventory all pass through the same schema and mapper. The transport test exercises both null-type spellings through create, `getPrimaryIp`, and `findPrimaryIps`; it separately preserves a positive server assignment and rejects `unassigned` with a positive ID. This closes the compatibility gap without creating divergent read paths.

## Ownership and cleanup safety

The correction changes only decoding of a null assignee. It does not bypass the existing exact-label filters in provider inventory or the resource ledger claim. For deletion, cleanup still requires the exact retained provider ID, account/allocation/provider scope, current labels, and an unassigned observation. For server deletion, the stricter network guard still requires a positive attached IP assignment to point to the exact observed server. Thus `server + null` cannot masquerade as an assignment to some server; it is treated as unassigned only because no server ID exists.

The captured cleanup in `.local/customer-drill-first-cleanup.json` is internally consistent:

- the original `create_primary_ip` attempt and labels are retained;
- its outcome remains `unknown`, while reconciliation records a confirmed observation of the same IP ID `148478037` as unassigned;
- exactly one `delete_primary_ip` attempt targets that ID and resolves to authoritative absence;
- there is no VM-create attempt and no second Primary IP create;
- the original create operation ends `cancelled`, the machine ends `destroyed`, and active allocations/live resources are zero.

This is evidence of recovery of the original paid IP after the parser correction. It is not evidence that empty inventory proved absence: the worker first reconciled the exact labeled IP and only later confirmed absence after an explicit delete.

## Documentation and evidence limits

`docs/architecture/provider-resources.md` accurately records the discrepancy between the documented transition and the live response. Its conclusion is appropriately conservative: a published transition date did not prove the older-compatible wire form had disappeared.

The artifacts demonstrate one live Hetzner Primary IP create/reconciliation/delete path. They do not prove customer VM boot, enrollment, runtime readiness, renewal, power lifecycle, or application deployment. The captured provider response is point-in-time evidence, not a promise that Hetzner will keep either null spelling indefinitely. Strict rejection remains appropriate for non-null `unassigned`, non-positive IDs, malformed records, ownership mismatch, and contradictory exact assignment.

At review time, the latest committed operator-recovery trail remained accurate and the handoff correctly described this customer drill as active. The parent was updating `CONTEXT`, `PROGRESS`, evidence, and `DECISIONS` for this parser incident; those final drill claims should cite both captured artifacts and keep the remaining customer drill work open. Formatting, push, and exact-commit CI for this correction were not part of the supplied evidence and must remain pending until completed.

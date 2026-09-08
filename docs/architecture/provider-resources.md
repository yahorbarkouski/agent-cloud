# Provider resource lifecycle

The resource controller is implemented and verified with persisted simulator state and Hetzner transport fixtures. Explicit customer runtime now connects the guest image, identity and lifecycle controller. A customer Hetzner boot remains unverified. See [operator runtime](operator-runtime.md) and [machine cleanup](machine-cleanup.md) for the current activation and recovery boundaries.

## Choice

Create an explicitly owned IPv4 Primary IP before creating its VM. Set `auto_delete: true` and attach its recorded ID in the VM request. Disable automatic IPv4/IPv6 allocation. Start with IPv4 only; adding IPv6 later must use the same ownership and cleanup rules.

An automatic IP created by a VM request has no separately submitted ownership label. If the VM request fails or loses its response, IP ownership is harder to establish. Discovering and labelling the IP afterward leaves a crash gap. A preallocated warm pool adds unnecessary standing resources. Explicit per-allocation creation fits the existing attempt journal and full VM-plus-IP reservation.

## Durable records

Keep machines as stable identities and allocations as reservations. Allocation-owned provider resource records track ownership for the VM and Primary IP. Each record binds account, allocation, resource kind, provider ID, ownership labels, and observed lifecycle state. Preserve original provider receipts.

Submission receipts are generalized to a discriminated resource reference, `server` or `primary_ip`, with its ID. Journal every external mutation before calling the provider. Migration 0005 converts existing server-only receipts and progress, adds an explicit legacy network profile, and backfills known server ownership. It changes JSON shape inside one transaction while preserving provider outcomes. Database guards keep attempt commands and recorded receipts immutable. Resolution moves once from pending to confirmed or failed. Existing simulated allocations retain their legacy profile because they never owned Primary IPs.

`advance-operation.ts` selects the next effect from durable attempts, allocation resources, and operation intent. `effect-journal.ts` checks fresh authorization and prices, journals submission, and reconciles receipts. `resource-journal.ts` binds ownership and records observed absence. They reuse the existing machine lock and admission locks. Provider transport handles external requests and observations.

## Create and cleanup

1. Admission reserves the selected gross VM, IPv4 and automated-backup price and stores the exact offer.
2. Check current authorization, offer, and limits; journal and submit Primary IP creation with allocation/operation/attempt labels.
3. Reconcile the IP result. One matching resource can be adopted. Zero inventory does not prove absence; multiple matches block for operator resolution. Never blindly repeat an uncertain create.
4. Recheck before the VM effect. Journal creation with the owned IP ID, image, firewall and SSH identity. Record the returned VM and its attached IP IDs.
5. Verify the returned resource IDs, labels, region, server type, attached IP, and power. Journal the separately priced backup-enablement action and observe it on the exact owned VM before readiness. The guest readiness controller then verifies pinned identity and runtime evidence. Live customer boot remains unverified.

If no VM effect was submitted, or the provider definitively rejected that request, a revoked credential or rejected offer can stop provisioning and compensate the confirmed unassigned IP. Cleanup is part of the admitted operation and must not be blocked by a lowered spending ceiling. An uncertain VM outcome must be reconciled before touching its IP. A confirmed VM with possible data retains its allocation for explicit authorized deletion. An error after submission cannot start compensation using stale history. The controller reloads attempts and keeps an unresolved effect blocked. A receipt is saved before the ownership claim so an ownership conflict cannot erase the provider result.

Deletion journals the VM request and observes VM absence, then observes the Primary IP. Auto-delete is useful but is not proof that cleanup completed. If an owned IP remains unassigned, journal its deletion and observe absence. An IP assigned elsewhere or with mismatched ownership must block cleanup. Release the reservation only after every billable resource owned by the allocation is confirmed absent.

## Hetzner transport

New Hetzner catalog offers include daily provider backups. The adapter reads `server_backup.percentage` from the same current pricing response as the gross VM rate, calculates the surcharge with exact decimal arithmetic and rounds a fractional millionth upward. A missing or malformed quote refuses the offer. The read-only account quote on 8 September 2026 returned 20%; that observation is not a fixed pricing rule. IPv4 is not included in the surcharge base. Historical offers without a backup field parse as disabled and keep their original reservation.

Hetzner requires a separate `enable_backup` server action. It uses the existing journal, fresh authority and price checks, machine lock and retained ownership. Lost replies are reconciled without submitting another enable action. Readiness requires the owned server to report a non-null backup window. Machine `backupStatus` is the last observed provider setting, not evidence that a snapshot completed or that PostgreSQL can be restored. An unknown or failed action can leave an owned, billable VM; explicit destruction settles the action after exact server absence and releases the reservation only after IP cleanup too.

A resize to a new offer includes its backup fee. If the historical VM has backups disabled, enablement follows confirmed resize. Enabling before resize could charge the fee on a more expensive old type than the reservation covers. Rejected resize leaves the old backup setting unchanged. The reservation holds the larger original or target total until verified completion.

Provider backups follow the VM's lifecycle and are deleted with it. Use the separate protected application backup flow for recovery points that must survive source destruction. Provider backup enablement has transport, lifecycle and actual CLI/API/worker simulator proof; live Hetzner activation is still pending.

The official spec saved during this run says Primary IP creation without an assignee may omit its `action`. A successful Primary IP delete returns HTTP 204 without a JSON body. The shared HTTP transport now accepts that bodyless success. Absence requires a resource-specific 404 with `not_found`; authorization errors and malformed responses do not prove absence.

The Primary IP `assignee_type` description says `unassigned` is returned from 1 August 2026, although the same spec's enum lists only `server`. The first customer drill on 7 September still returned `server` with a null `assignee_id`. Rejecting that response left the IP create uncertain and prevented inventory reconciliation. The parser now accepts both type values with a null ID as unassigned. A positive ID requires type `server` and remains an exact server assignment. An `unassigned` type with a non-null ID is invalid. Creation and all inventory reads use this same parser. A documented transition date is not evidence that a compatible wire form has stopped occurring.

Provider credentials stay in the control plane. Shared firewall/key/image configuration is not an allocation-owned resource and must not be deleted during customer cleanup.

## Verification

The persistent simulator has faults scoped by resource kind. `tests/resources.test.ts` covers exits after IP creation/deletion, delayed inventory, duplicate IPs, revocation between effects, rejected and uncertain VM creation, foreign/assigned IPs, lost delete responses, conflicting receipts, reservation retention, immutable resolutions, and tenant ownership constraints. The original VM crash test still uses a separate exiting process. `tests/hetzner-transport.test.ts` checks outgoing IP/VM requests, HTTP 204, assignment consistency, pagination, error classification, and uncertain responses. Upgrade tests exercise queued, prepared, accepted, and completed create/resize operations from M0. None of these fixtures proves live provider behavior.

The [internal reference deployment](../reference-deployment-verification.json) verified Hetzner provisioning, application operation and exact cleanup. Final customer activation, including automated backups, still needs a bounded live run with a cleanup deadline. Refresh the complete quote before provisioning. The separate [image factory drill](../research/m1-hetzner-durability-drill.json) establishes image readiness, not customer lifecycle behavior.

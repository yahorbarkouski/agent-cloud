# Provider resource lifecycle, next M1 slice

This is the implementation sketch following pricing checkpoint `df11926`. These resource steps are not implemented yet. The running API and worker still reject Hetzner activation.

## Choice

Create an explicitly owned IPv4 Primary IP before creating its VM. Set `auto_delete: true` and attach its recorded ID in the VM request. Disable automatic IPv4/IPv6 allocation. Start with IPv4 only; adding IPv6 later must use the same ownership and cleanup rules.

An automatic IP created by a VM request has no separately submitted ownership label. If the VM request fails or loses its response, IP ownership is harder to establish. Discovering and labelling the IP afterward leaves a crash gap. A preallocated warm pool adds unnecessary standing resources. Explicit per-allocation creation fits the existing attempt journal and full VM-plus-IP reservation.

## Durable records

Keep machines as stable identities and allocations as reservations. Add allocation-owned provider resource records for the VM and Primary IP. Each record binds account, allocation, resource kind, provider ID, ownership labels, and observed lifecycle state. Preserve original provider receipts.

Generalize submission receipts to a discriminated resource reference, `server` or `primary_ip`, with its ID. Journal every external mutation before calling the provider. Use a deliberate format migration for existing server-only receipts if the wire shape changes; do not weaken attempt-history guards or silently rewrite the meaning of historical outcomes. Existing simulated allocations need an explicit legacy profile because they never owned real IPs.

The operation controller should select the next required effect from durable records. Provider transport remains separate from that decision. Reuse the existing machine lock, admission/global/account locks, attempt journal, and unknown-outcome rules. Avoid a second independent ledger just for IPs.

## Create and cleanup

1. Admission reserves the selected gross VM-plus-IPv4 price and stores the exact offer.
2. Check current authorization, offer, and limits; journal and submit Primary IP creation with allocation/operation/attempt labels.
3. Reconcile the IP result. One matching resource can be adopted. Zero inventory does not prove absence; multiple matches block for operator resolution. Never blindly repeat an uncertain create.
4. Recheck before the VM effect. Journal creation with the owned IP ID, image, firewall and SSH identity. Record the returned VM and its attached IP IDs.
5. Verify the returned resource identities, then verify guest boot and SSH identity before reporting guest readiness.

If no VM effect was submitted, a revoked credential or rejected offer can stop provisioning and compensate the confirmed unassigned IP. Cleanup is part of the admitted operation and must not be blocked by a lowered spending ceiling. An uncertain VM outcome must be reconciled before touching its IP. A confirmed VM with possible data retains its allocation for explicit authorized deletion.

Deletion journals the VM request and observes VM absence, then observes the Primary IP. Auto-delete is useful but is not proof that cleanup completed. If an owned IP remains unassigned, journal its deletion and observe absence. An IP assigned elsewhere or with mismatched ownership must block cleanup. Release the reservation only after every billable resource owned by the allocation is confirmed absent.

## API details to encode

The official spec saved during this run says Primary IP creation without an assignee may omit its `action`. A successful Primary IP delete returns HTTP 204 without a JSON body. The current shared HTTP transport always reads JSON, so it must support bodyless success before IP deletion is implemented.

The Primary IP `assignee_type` description says `unassigned` is returned from 1 August 2026, although the same spec's enum lists only `server`. Accept the documented unassigned form with a null assignee ID; validate contradictory assignment states instead of treating an omitted action or an empty 204 response as a failed mutation.

Provider credentials stay in the control plane. Shared firewall/key/image configuration is not an allocation-owned resource and must not be deleted during customer cleanup.

## Verification

Use the persistent simulator for IP and VM effects, with faults scoped by resource kind. Cover process exits after each provider commit, delayed inventory, duplicate IPs, revoked grants between effects, rejected VM creation after IP allocation, unknown VM creation, assigned or foreign IPs during cleanup, lost delete responses, and an empty HTTP 204. Existing create/resize/reboot and migration coverage must keep passing.

Only then run a bounded inexpensive live test with a cleanup deadline and known resources. Current pricing evidence is USD 0.027798/hour for CPX12 plus IPv4, including VAT, but refresh it before provisioning. No paid resource has been created so far.

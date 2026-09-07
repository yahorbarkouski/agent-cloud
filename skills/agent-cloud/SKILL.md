---
name: agent-cloud
description: Operate agent-cloud machines through its JSON CLI, inspect durable operations, and recover interrupted requests within the customer's existing authorization.
---

# Agent-cloud

Use the installed `acld` CLI. In a source checkout, use `pnpm acld`. Run `acld --help` when unsure about available commands. The current release supports machine lifecycle operations; application deployment, SSH, routes, backups, and browser login are still being implemented.

## Establish context

Run `acld whoami`, `acld catalog`, and `acld project list`. The credential defines capabilities, project scope, permitted sizes/regions, and resource limits. This skill does not expand those permissions or the user's task.

Credentials live in the CLI configuration file, or the path named by `ACLD_CREDENTIALS`. For initial token authentication, use `acld login --server <url> --token-stdin` with the token supplied on stdin. Do not include tokens in arguments, messages, application files, or Git. Provider credentials belong to the operator and never belong in a customer VM.

Check the catalog's provider field. `simulated` means no real VM exists. Inspect availability, architecture, currency, and the hourly reservation including IPv4. Simulated prices are synthetic; `account_gross` prices come from the provider account. Never interpret a different currency as equivalent or select a more expensive substitute without an allowed budget. Powered-off VMs retain their reservations and remain billable on Hetzner.

## Create and observe

```sh
acld machine create example --project prj_... --size small --region nbg1 --key <stable-request-key>
acld operation wait op_...
acld machine inspect vm_...
```

Use valid IDs returned by the service. Generate and retain one idempotency key of at least 12 characters for each intended mutation. Reuse it with the identical request after a timeout or interrupted response. Reusing it with different input produces a conflict.

Mutation acceptance returns an operation, not a ready machine. Inspect or wait for that operation. JSON results go to stdout; errors go to stderr. `operation wait` exits 0 for `succeeded` or `cancelled`, 1 for `failed`, and 2 when blocked. Read the JSON progress: `cancelled` means creation was stopped and cleanup completed, not that a machine is ready. A client timeout does not cancel server work. `cleaning_up` means the service is reconciling and removing owned resources before releasing the reservation; keep inspecting the returned operation.

`waiting_guest` distinguishes enrollment from runtime checks. A provider's completed create/reboot action does not prove the guest is usable. `guest_identity_mismatch`, `guest_deadline_exceeded` and `guest_signing_exhausted` retain the owned VM/IP reservation for operator recovery. Do not create a replacement automatically or claim the reservation was released. Customer admission requires an operator-configured customer runtime with a retained signed image and explicit spending limits. This runtime has local protocol verification; customer Hetzner boot is still pending. The separate image factory rejects customer `/v1/*` calls. Do not infer customer availability from its health endpoint.

If progress is `blocked`, retain the operation ID and report its reason. Empty provider inventory does not prove creation failed. Do not use a fresh key or a new machine name to work around an unknown outcome; that could duplicate paid infrastructure. Duplicate-resource resolution currently needs the operator.

## Change an existing machine

Read the current machine version before a change, then pass `--expected-version`. A version conflict means another change happened; inspect the result and reassess the intended action.

```sh
acld machine power-off vm_... --expected-version 2 --key <stable-request-key>
acld operation wait op_...
acld machine resize vm_... --size medium --expected-version 4 --key <another-key>
```

Power-off requests graceful shutdown and waits for the provider to report off. If the guest does not shut down, keep the same operation and report the blocked state; do not force a power cut. Resize requires the machine to be powered off. Disk shrinking is unsupported. Use `power-on` when the resize succeeds. `reboot` is also available.

Deletion destroys the disk. When deletion and data loss are already authorized by the user, run:

```sh
acld machine destroy vm_... --expected-version 6 --allow-data-loss --key <stable-request-key>
acld operation wait op_...
acld machine inspect vm_...
acld usage
```

Check for `destroyed` and released usage reservations. Deletion completes only after the VM and its owned Primary IP are confirmed absent. The same destroy command cancels an active blocked create or cleans a failed create with a retained allocation. Active cancellation returns the original create operation and eventually `cancelled`; failed-create recovery returns a new destroy operation and preserves the failed source result. Accepted cleanup continues after its initiating grant expires or is revoked, within the recorded allocation scope.

Unknown source creates never resubmit and empty inventory never proves absence. Duplicate resources remain recorded; automatic IP deletion or mismatched assignment can block VM cleanup. `cleanup_retry_exhausted` means three exact-ID delete attempts were used. Report the operation/resource IDs for operator recovery; do not create replacements or assume reservations were released. New request keys do not reset this retry budget.

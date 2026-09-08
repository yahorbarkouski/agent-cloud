# Reservations and limits

Run `acld usage` before creating or resizing a machine and after cleanup. It reports account-wide active VM reservations, their aggregate hourly rate and retained backup bytes. All amounts use the account currency in integer millionths. These are admission reservations, not an invoice or a claim about actual elapsed provider charges. Provider billing boundaries, storage charges and taxes are not calculated here. Stripe is excluded.

Account and credential limits both constrain admission. `limits.effective` takes the smaller machine and hourly allowance; `remainingMachines` and `remainingHourlyMicros` subtract all account reservations and clamp at zero. Project-scoped credentials share those account limits. The deployment's overall capacity, a current catalog offer and other admission checks can still reject a request despite positive remaining capacity. This read is an observation, not a quota reservation.

A powered-off VM remains reserved. Resize admission holds the larger of the previous and requested rate until the product verifies the provider outcome. Unknown or failed operations retain their reservation whenever owned infrastructure may remain. Only authoritative cleanup retires it. An admitted create rejected before any provider effect records both admission and release, even though it created no billed VM.

`usage.backups` includes pending and blocked captures, retained objects and pending purges. Admission initially reserves the configured maximum capture size; verified stored objects reserve their actual encrypted size. Object Lock expiry alone does not release storage. A successful exact-version purge does. Destroying a VM preserves its off-machine backups. Backup limits are `null` when the API has no configured backup service; persisted usage remains visible. This does not mean unlimited storage or zero usage.

## Reservation history

```sh
acld usage history
acld usage history --before <nextCursor>
```

The API equivalents are `GET /v1/usage` and `GET /v1/usage/history?before=<cursor>`. Both require `usage:read`. Aggregate usage is account-scoped. History contains machine, project and allocation IDs only within the credential's project scope. No credentials, commands, object-store addresses or customer content are returned.

History is newest first, up to100 entries per page. `nextCursor: null` ends pagination. Start again without a cursor to observe newly committed changes; pagination is not a live event subscription. Each entry contains the rate in effect after that recorded change. `admitted` starts a reservation, `changed` replaces its rate, and `released` sets it to zero. The database records the event in the same transaction as the allocation change and rejects later edits/deletion. Replays and unchanged provider reconciliation do not duplicate events.

Existing allocations receive a `baseline` at the migration timestamp. Their earlier mutable rates cannot be reconstructed, so no historical charges or reservation intervals before that baseline are invented. A retired allocation's baseline is zero. Keep the control database backup to preserve this history.

## Verification

`pnpm smoke:usage` starts an isolated simulated API, Graphile worker and database and invokes the actual CLI. It creates, powers off, resizes and destroys a machine across disconnected CLI processes, verifies rates9600→14400→0, inspects history, then removes its exact database/private files. No provider credentials or paid resources are used.

The backup-retention smoke verifies retained bytes, pending purge and released capacity through the same CLI after actual encrypted MinIO storage. Database tests cover project/account isolation, parent revocation, missing capability, bounded cursors, concurrent changes, rollback, append-only history and migration-time baselines. Existing lifecycle tests cover provider uncertainty and cleanup; these usage changes do not alter lifecycle admission or provider effects.

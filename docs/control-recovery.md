# Recover control state without replaying old work

A control database checkpoint can contain a credential revoked later, or a queued create that was submitted after the checkpoint. Restoring database bytes cannot settle either fact. The operator recovery command keeps customer access and background work fenced until current inventory and explicit closure evidence permit resume.

## Execution boundary

Real Hetzner API/worker processes require `ACLD_CONTROL_GENERATION_FILE`, defaulting to `.local/control-generation.json`. This owner-only file contains `{ "version": 1, "generation": "<UUIDv4>" }` and must match the ready generation in `control_state`. Keep it outside database and identity archives. Create a new file for every restored instance. Do not copy the source generation to make a restored instance start.

Each API, worker and operator mutator holds a PostgreSQL session lease for its lifetime. API requests and worker tasks check the generation before admission. Loss of the lease connection terminates a mutator process. Recovery holds an exclusive lease, and its transaction uses that same database connection. Existing machines and public gateway routes run independently of the control API.

This lease coordinates processes using one database. It cannot stop a source process using an independent old database. Before recovery, stop the old API, worker, retention and operator processes. Revoke their provider and signing access and fence their storage mutation credentials. Resolve provider requests that may still finish after process termination. Use fresh scoped credentials on the chosen target. Preserve private bootstrap and backup decryption keys separately; a generation is not an encryption key or replacement CA.

The simulated quickstart can omit the file for its existing local data-format checks. That allowance does not apply to a Hetzner runtime. Supplying the file enables the same fence in a simulated installation.

## New installation

Run migrations first. With an empty new database, create a generation and apply an initialization request before admitting any account:

```sh
pnpm control:recover prepare /private/control-generation.json
export ACLD_CONTROL_GENERATION_FILE=/private/control-generation.json
pnpm control:recover apply /private/initialize.json
```

The private request is `{ "kind": "initialize", "id": "<fresh UUIDv4>", "generation": "<generation from prepare>", "operator": "operator-name" }`. Initialization refuses a populated database. Existing installations use the recovery procedure so old authority is reviewed rather than implicitly adopted.

## Restore and resume

1. Externally fence the old instance and its credentials. Restore the trusted checkpoint into an isolated database using its matching schema/image. Keep customer API, workers and retention stopped.
2. Create a fresh private generation file with `prepare`. Set `DATABASE_URL` to the isolated target and `ACLD_CONTROL_GENERATION_FILE` to that file. Never reuse the source database URL.
3. Apply a private `begin` request. It requires a fresh `id`, `generation`, `operator`, the actual `checkpointSha256`, and `evidence: { "sha256": "<digest of retained evidence>", "reference": "<operator evidence reference>" }`. Set `oldProcessesStopped`, `oldProviderCredentialsRevoked`, `oldSigningCredentialsRevoked` and `oldStorageMutatorsFenced` to true only after those actions are verified. These are operator attestations, not automated proof of remote credential revocation.
4. Run `pnpm control:recover inspect`. Beginning recovery revokes every restored grant, including customer admission anchors, closes restored access sessions and disables restored backup schedules. Existing applications and stored data are preserved. Inspection identifies unfinished lifecycle, image, routing, upload, restore and purge work and checks current exact resource ownership.
5. Resolve every reported item. `machine:recover apply-recovered` and `backup:recover apply-recovered` expose the existing offline repair procedures under an exclusive recovery lease. They only inspect their provider/object store and amend their exact recorded intent. They cannot start a VM or repeat an upload. Unsupported recovery states remain blocked and need their specific reconciliation; never edit the database to force the ready flag.
6. Apply a private `resume` request containing a fresh `id`, the `recoveryId` from begin, `generation`, `operator`, `expectedState` and `expectedInventory` from the latest inspection, `evidence`, and `postCheckpointEffectsClosed: true`. This last attestation must account for operations absent entirely from the checkpoint. An empty provider listing alone is insufficient. Resume repeats inspection under the exclusive transaction and refuses any blocker or changed digest.
7. Start the selected API/worker with the target generation and fresh scoped credentials. Old customer tokens stay revoked. Explicitly renew each authorized customer's admission with the existing customer operator command, then let that customer's agent authenticate again. Recreate desired schedules with fresh authority. Re-run inventory inspection after resume and investigate delayed discoveries using exact owned IDs.

All requests are owner-only JSON files. Each request UUID permanently names one decision. Reusing it returns its recorded result; changed contents are rejected. Recovery receipts and effect closures are immutable. Neither the customer CLI nor an installed customer skill receives operator recovery authority.

## Close an abandoned lifecycle operation

`pnpm control:recover operation <operation-id>` returns its state digest and retained resource IDs. A `close_operation` request requires `id`, `generation`, `recoveryId`, `operator`, `operationId`, `expectedState`, `resourceIds: [{ "kind": "server", "id": "<exact provider ID>" }]`, `providerRequestFinished: true`, `allowDataLoss: true` and retained `evidence`.

This command submits no provider deletion. Every acknowledged resource must already be authoritatively absent, every retained ID must be acknowledged, and the operation's allocation must have no discoverable owned VM or IP. The operator's evidence must establish that no delayed create can still appear. This also covers a checkpointed queued create with no attempt row. Closure preserves its intent and receipt, settles pending attempts, retires its reservation and marks the machine destroyed. A remaining resource, competing unresolved effect or changed inspection prevents closure.

## Verification

`pnpm smoke:control-recovery` uses two exact temporary PostgreSQL databases and the existing local PostgreSQL container, selected by `ACLD_TEST_POSTGRES_CONTAINER` if needed. It runs the actual CLI, captures a custom-format `pg_dump`, revokes the source credential after capture, restores the dump with `pg_restore`, and confirms that both built API and worker entrypoints reject the new generation before operator recovery. After explicit recovery, the old token is rejected, checkpoint data remains, and a fresh internal test identity uses the CLI. Both databases and private files are removed. It makes no provider-proof claim.

Focused recovery tests keep simulated provider state in a separate database, expose a delayed create absent from the checkpoint, and prove that an empty listing cannot authorize automatic resume or another create. Connection-loss, private-file, concurrent lease, immutable receipt and stale customer admission checks use actual PostgreSQL.

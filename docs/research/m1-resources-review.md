# M1 provider-resource checkpoint review

The prior reviewer examined the uncommitted provider-resource checkpoint against `a5572db63cdfa58e081fb655292b388610493a77`. That review was bounded to the resource and effect journals, lifecycle controller, persistent simulator, provider contracts and transport, migration 0005, and their focused tests. Live provider mutations, guest bootstrap, and later M1 operator workflows were out of scope.

No transcript path or `agent-transcripts/` directory was supplied. Historical smoke and provider claims therefore were not transcript-audited. This report uses the current code, migration SQL, PostgreSQL integration tests, and the checked-in architecture and decision records. Neither review used a provider credential or created, changed, or deleted any cloud resource.

## Prior reviewer findings resolved during review

Two material safety issues were found and fixed before this report was completed:

- `packages/hetzner/src/index.ts` originally accepted a contradictory Primary IP response with `assignee_type: "server"` and `assignee_id: null`, then represented it as unassigned. Since `apps/control/src/advance-operation.ts` permits cleanup only for an unassigned IP, that response could have authorized deletion despite the provider declaring a server assignment. The schema now requires assignment type and ID to agree in both directions. `tests/hetzner-transport.test.ts` covers both contradictory forms.
- A provider create receipt is saved before its ownership claim, deliberately preserving the external outcome if `claimResource` detects a conflict. The first catch path still used the controller's pre-submission attempt list. It could therefore miss the newly persisted pending attempt and enter create compensation after a post-submission claim error. `apps/control/src/advance-operation.ts` now reloads attempt history and resource rows before deciding whether compensation is safe; a pending effect blocks cleanup. `tests/resources.test.ts` exercises a conflicting post-submission receipt and verifies that both resources and both reservations remain for reconciliation.

The prior reviewer found no remaining high-confidence paid-resource leak, blind retry, cross-tenant mutation, or unsafe post-submission cleanup path in the bounded implementation after these fixes.

## Journal and controller assessment

The implementation follows the durable-effect design:

- `apps/control/src/effect-journal.ts` records a prepared attempt and submitting progress in one transaction before provider I/O. Create receipts are then retained before resource ownership is claimed. A process loss leaves a prepared attempt, which reconciliation treats as uncertain rather than permission to submit again.
- `apps/control/src/effect-journal.ts` resolves uncertain creates through label-scoped inventory. Zero matches remain blocked, multiple matches remain blocked, and one match must still satisfy resource identity, ownership, type, region, network, and state checks. Uncertain deletions require observed absence; an existing resource is not deleted a second time.
- `apps/control/src/resource-journal.ts` binds provider, resource kind, provider ID, account, and allocation under a provider-wide primary key. A composite foreign key in `packages/db/src/schema.ts` prevents an allocation from being attached to another account. A conflicting or previously absent claim fails closed.
- `apps/control/src/advance-operation.ts` compensates a confirmed unassigned IP only when no VM effect can have been submitted. Once a VM outcome may exist, the controller retains the full allocation and reconciles the original attempt. Destroy observes server absence, then IP absence, and retires the allocation only after no owned live resource remains.
- Cleanup uses the recorded provider ID, stored ownership labels, and current unassigned state. Credential revocation and lower spending ceilings cannot strand a known-safe cleanup, while all fresh billable effects recheck authorization, catalog choice, price, and current limits.

The conservative blocked states can retain spend until operator action, especially for duplicate creates, mismatched ownership, assigned IPs, and an uncertain deletion that still appears present. That is the intended safe failure mode. Operator resolution remains unfinished M1 work and should remain part of the live-activation gate.

## Migration 0005

`packages/db/migrations/0005_provider_resources.sql` deliberately migrates the receipt wire shape instead of weakening parsing. It converts historical accepted/completed `serverId` receipts and waiting/verifying progress into discriminated server resource references, adds the legacy network profile to historical create commands, extends simulator records, and backfills server resource ownership from allocation `server_id` values. Historical allocations are marked `legacy`, so they do not falsely claim separately owned Primary IPs.

The migration temporarily disables the immutable-attempt trigger only for the shape conversion, then recreates a guard that makes command and identity fields immutable and permits outcome and resolution to be recorded once. The allocation/account composite key is created before the new resource foreign key.

`tests/migration.test.ts` now applies the actual old migrations and upgrades a create/resize matrix across queued, prepared, accepted, and completed states. It exercises the old receipt and progress formats, legacy network conversion, resource backfill, preserved authentication and price reservations, and continuation without repeating an already submitted effect.

## Verification boundary

The prior reviewer independently ran:

```text
npm exec --yes --package=pnpm@12.3.4 -- pnpm exec vitest run \
  tests/resources.test.ts tests/hetzner-transport.test.ts tests/migration.test.ts
```

All 28 focused tests passed in that review. They cover lost and delayed IP responses, duplicate IP creation, revocation between IP and VM effects, rejected and uncertain VM submission, explicit and lost-response cleanup, ownership/assignment/identity mismatches, post-receipt claim conflicts, database immutability and tenant ownership, process exits after IP creation and deletion, bodyless HTTP 204, paginated inventory, transport uncertainty, and the migration matrix.

That review did not independently run the final repository-wide typecheck, lint, formatting, customer-skill validation, local migration/restart, or CLI smoke. The main task completed those checks later, as recorded below. The Hetzner worker remains disabled, and this checkpoint does not establish live VM boot, SSH guest identity, real action semantics, or paid-resource cleanup under provider faults.

## Configured-model trail audit

The gpt-5.6-sol audit checked this report, `docs/DECISIONS.tsv`, the current diff, the post-submission cleanup guard, and the Hetzner assignment parser. The report's two resolved findings match the current code and tests. The four resource checkpoint rows in `docs/DECISIONS.tsv` have six well-formed columns, resolve to current evidence, and distinguish simulated verification from live activation. A focused rerun of the conflicting ownership receipt and contradictory assignment tests passed: 2 tests passed and 18 unrelated tests were skipped.

The audit did not inspect a transcript because none was available. The main task records a repository-wide check with 67 passing tests plus typecheck and lint, a migrated CLI smoke, and zero remaining simulator resources. This audit did not rerun or independently attest those results.

## Attention

reviewed by gpt-5.6-sol

- Keep live activation disabled until guest verification, bounded live cleanup drills, and operator resolution for blocked resources are implemented.
- Treat the main task's final check, migrated CLI smoke, zero-resource cleanup, and historical provider setup statements as its evidence. This audit had no transcript and did not independently verify those claims.

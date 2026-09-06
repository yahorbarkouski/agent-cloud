# Architecture judgment

| Candidate | Ambiguous-effect recovery | Concurrent admission / idempotency | Module boundaries | Typed contracts / test seams | Initial lifecycle completeness | Total |
|---|---:|---:|---:|---:|---:|---:|
| A | 5 | 4 | 4 | 4 | 4 | 21 |
| B | 4 | 2 | 5 | 3 | 4 | 18 |
| C | 3 | 4 | 4 | 3 | 2 | 16 |

## Recommendation

Use **A as the base**. Its stable `Machine` / concrete `Allocation` split, attempt-before-effect rule, explicit unknown-outcome block, labeled inventory reconciliation, caller `expectedVersion`, and prohibition on cloud calls inside transactions form the most coherent safety model. This is the best candidate for avoiding a second paid VM after an accepted create loses its response, while covering all four initial operations.

Graft at most these two pieces:

1. **B's concrete module map and fault-test matrix.** The named route/domain/store/worker/provider/reconciler/fake modules are immediately implementable. Its crash gates, inventory-lag scenario, duplicate jobs, grant revocation, and destructive-delete acknowledgement give A's abstract fault-test plan the needed acceptance cases.
2. **B's explicit idempotency response rule:** same key plus canonical body returns the existing operation; same key plus a different body returns `409`. Carry that rule into A's transactional idempotency claim and document the uniqueness scope as `(account, endpoint, key)`.

## Concrete defects

**A:** `claimIdempotency` does not state its unique-key scope or distinguish a matching retry from key reuse with a different request hash. `reserveLimits` does not expose the locked counter/reservation semantics needed to prove concurrent creates cannot oversubscribe a limit. `markAttemptOutcome` accepts only an outcome plus `unknown` evidence, so success/failure payload requirements are weaker than the `ProviderAttempt` union. The command union also makes `size` and `allowDataLoss` optional across every mutation, allowing invalid resize/destroy values internally. Reconciliation is only sketched at inventory level; action polling and unknown reboot/resize/destroy resolution need explicit transitions.

**B:** Its prose promises intent and job insertion in one transaction, but `createMachineTx` and `enqueueOperationTx` are separate methods, leaving a crash window with an accepted operation and no job. More seriously, only `CreateServer` carries a `ProviderAttempt`; `PowerCycle`, `ResizeServer`, and `DeleteServer` can reach the provider without a pre-recorded attempt, contradicting the central journal invariant. Mutable requests lack `expectedVersion`, weakening stale-agent protection. Grant capabilities typed as `OperationKind[]` cannot represent the separate destructive data-loss permission described by the design.

**C:** `canSubmitCreateAttempt` blocks pending and unknown attempts but permits another create after a known successful attempt; correctness depends on unstated phase checks. A crash after inserting `pending` and before converting it to `outcome_unknown` can leave create permanently blocked because the reconciler is named and specified only for unknown creates. `ProviderEffects` cannot return typed rejected or ambiguous outcomes; ambiguity is relegated to exceptions. `DesiredMachineState` has no `destroyed` state, and only create has worker/reconciler entry points, so reboot, resize, destroy, provider action polling, and readiness verification are not fully designed. `insertMachine` cannot populate the declared `accountId` field.

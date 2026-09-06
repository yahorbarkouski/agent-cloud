# Guest design rubric

Score each criterion 0–5 based on concrete mechanisms, not length.

1. Proves unique guest identity and binds enrollment to the admitted allocation, secret and provider network; retry cannot rotate keys.
2. Integrates crash/retry/cleanup semantics with existing effect journal without plaintext secrets in receipts or unsafe replay.
3. Provides an executable M1 vertical path with verified SSH and runtime checks while preserving later Smallstep gateway access.
4. Makes image sanitation, per-guest bootstrap and cheap local/live verification reproducible without assumed external accounts or domains.
5. Keeps types explicit, modules few, and ownership clear enough to implement and extend without a generic workflow framework.

Guest workflow: grounding complete; frame complete; fan-out, cross-judge, pick and graft complete. Design invariants checked in architecture/guest-bootstrap.md; executable implementation verification remains pending. Candidates write separate files under guest-candidates. No cloud mutation is authorized by this design task.

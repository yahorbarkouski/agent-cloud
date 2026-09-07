# Current M2 implementation context

Updated 2026-09-07. Full cloud goal remains active, excluding Stripe. This isolated worktree is on `yahor/customer-ssh`, based on root checkpoint224a56a. Its own frozen dependencies and copied `.env.example` use local development services. No live provider credentials are present here.

Root checkout owns the active M1 Hetzner drill. Its `docs/CONTEXT.md` and ignored `.local/customer-drill-lifecycle.json` are authoritative for live resources, process handles, deadlines and cleanup. Do not build or restart root services, alter selected image inputs or change the running Smallstep CA while that drill runs. M2 source, builds and isolated PostgreSQL tests run here.

## Current change

`apps/control/src/auth.ts` adds `loadAuthority`. One bounded recursive SQL statement reads a complete ancestry snapshot, then checks expiry with PostgreSQL time after materializing traversal. It rejects missing roots, cycles, cross-account ancestry, malformed policies and chains deeper than32. It returns the earliest ancestor expiry. Existing `loadPrincipal` delegates to it; grant issuance uses the complete horizon. Revocation timestamps use database time.

Eleven targeted auth tests pass, including host clock skew, grandparent expiry, real concurrent parent revocation during a delayed read, expiry during delayed traversal and32/33depth boundaries. The first multi-statement version passed426full tests but review identified mixed snapshots. The corrected targeted run initially had the wrong CloudError assertion field; that fixture error is fixed. Full lint then caught deprecated Zod finite checks; those no-ops were removed. Final fullcheck7876 passed429tests/36files, typecheck/lint in102.76s. Log is root `.local/m2-authority-snapshot-check-final.log`. Review is root `docs/research/m2-authority-review.md`; copy its final addendum here after resolution.

## Selected access architecture and next step

`docs/architecture/customer-ssh.md` is the selected A design with C state/revocation improvements. Three candidates and gpt-5.6-sol judgment are preserved in root `.local/m2-access-design`. Grounding and protocol notes are committed-doc candidates here. Existing opaque grants authorize the first slice. Customers use `acld ssh`; native OpenSSH consumes an ephemeral private key/certificate and a single-use ticket through a private ProxyCommand profile. The gateway holds only a narrow control-RPC credential, no database/provider/CA keys. Stable allocation principals, a distinct customer user, gateway-source restrictions, explicit signed image capability and monotonic revocation deadlines remain to implement.

Finish review/full check/formatting and commit the authority checkpoint. Then implement access contracts and next immutable SQL migration0020, followed by admission, worker issuance, narrow gateway RPC, native SSH/WSS transport and privilege/revocation proofs. No0020 or session source exists yet. All0000–0019 remain immutable. Do not apply future migrations to root/live DBs while M1 runs. The isolated test helper creates and removes its own unique databases.

Keep root `docs/DECISIONS.tsv` as the sole canonical append-only trail during isolation. Integration happens after the live drill is cleaned. Never overwrite root's newer M1 context or evidence with this inherited checkout's historical docs.

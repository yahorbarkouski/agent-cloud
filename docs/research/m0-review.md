# M0 checkpoint review

Independent reviewer: `gpt-5.6-sol`, 2026-09-06. Scope: the local lifecycle/auth implementation and its decision trail. The reviewer found no serious confirmed tenant isolation, authorization, lifecycle, or cleanup bug in those bounded paths.

Findings and disposition:

1. The architecture claimed attempts could not be rewritten, but only application control flow enforced that. A custom migration now restricts attempts to a prepared insertion followed by one recorded outcome, preserves identity/commands, and prevents row deletion. Tests now include attempted rewrites and a subprocess exiting after provider commit while the journal remains prepared. Verification of these changes is recorded in PROGRESS.
2. An early decision row pointed at temporary dependency metadata. An append-only supersession row explicitly identifies the committed copy in `docs/research/package-versions.json`.
3. During repository creation, progress still said no remote existed. Canonical progress/context now distinguish private repository creation from first push and CI verification.

Follow-up review confirmed the journal guard and subprocess test materially address the invariant mismatch, with no material lifecycle/auth regression found. Full check passed 19 tests; the migration and CLI/HTTP/Graphile smoke passed again. An append-only verification row closes the earlier pending-verification entry.

The review did not certify live Hetzner provisioning, guest access, deployment, routing, backups, or production availability. Those remain open implementation milestones.

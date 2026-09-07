# Customer runtime review

Reviewed by gpt-5.6-sol on 2026-09-07. Read-only code and decision-trail review. No transcript directory was supplied and no provider operations were run by the reviewer.

The first review identified customer preflight as an API startup dependency. The API now runs startup preflight only for image_factory. Customer dependencies load at their operation boundaries. A subprocess test starts the actual customer API with missing bootstrap/PKI files and injected unavailable provider reads, then authenticates a project read over loopback HTTP.

The follow-up found no remaining blocker in image pinning, firewall checks, exact-resource cleanup or graceful shutdown. A confirmed missing firewall is terminal; unavailable or malformed observations remain retryable. The pinned resolver checks the firewall before the first paid effect and again at rendering, so a redundant renderer check was removed. Private release signing keys are unnecessary in customer mode.

Self-review then found that shared service initialization still required the bootstrap seal for renewal and runtime inspection. Enrollment now initializes separately. Fresh creates and explicit preflight still require the seal. The new dependency regression removes bootstrap.key and reaches renewal allocation authorization, rather than failing while loading the unrelated seal. It does not claim successful certificate reissuance after seal loss. The final review found no material blocker in this split. Rejected lazy loads evict their cache entries so restoring missing files can recover on retry.

Intermediate full32555 passed 381 tests in 35 files. Full96292 passed 382 after firewall error classification. Focused28123 passed all seven customer tests after the bootstrap dependency split. Final full37481 passed383tests/35files, typecheck/lint in85.97s. `.local/customer-runtime-complete-check.log`. Native58010 passed actual Smallstep/OpenSSH/TLS enrollment and renewal, including lost responses, certificate installation and activation retry. That smoke uses isolated fixture-aged issuance, not elapsed expiry. It predates the customer-only firewall/dependency follow-ups and does not exercise a customer Hetzner VM. The simulated CLI/API/worker smoke1715 passed after restart and cleaned its machine. All 18 applied migration hashes match; no schema change was required.

Early focused failures came from a test root certificate that had not used the signer's canonical PEM representation. The fixture was corrected without weakening trust comparison. A full-check attempt stopped at test lint, then a mechanical lint-fix attempt required one explicit if statement before the full suite passed. Their logs remain separate from final verification.

Customer blocked-provisioning cancellation/recovery, owned firewall setup and the live customer lifecycle drill remain unverified work. No paid resource was created for this checkpoint.

A fresh read-only provider inventory at 2026-09-07T11:52:55.769Z found zero servers, Primary IPs, snapshots, firewalls and SSH keys. SQL cleanup check at11:52:55Z found no active allocations, simulator resources or unfinished image builds; native VM ownership records were absent. `.local/customer-runtime-provider-inventory.json` and `.local/customer-runtime-cleanup-check.json`.

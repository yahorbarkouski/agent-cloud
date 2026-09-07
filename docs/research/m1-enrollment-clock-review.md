# Enrollment clock review

Reviewed by gpt-5.6-sol on 2026-09-07. Read-only review of code, tests and the decision trail. No transcript directory was supplied. No provider resources were created.

No material blocker found. The final allocation/bootstrap lock and reload serialize certificate publication with retirement. Expiry, issuance and token consumption share PostgreSQL time. Tests cover application clock drift and retirement during signing.

Full check27453 passed 372 tests in 34 files, typecheck and lint. Formatting66781 passed. Native95533 passed actual Smallstep/OpenSSH/TLS enrollment and renewal with cleanup. Logs are `.local/enrollment-clock-final-check.log`, `.local/enrollment-clock-format.log` and `.local/enrollment-clock-native.log`. The earlier full32711 stopped at lint on a new test response typing error and was corrected before the final check.

Verification limits remain explicit. Native renewal accelerates issuance metadata in its isolated fixture; it does not wait for real certificate expiry or prove customer Hetzner deployment. Probe cache reuse uses the database instant captured before external work plus a fifteen-second margin. Unusually slow external work can expire a credential and consume an attempt, but cannot authorize issuance without successful remote proof. Exact CI for this follow-up is pending; the prior renewal CI belongs to commit7843b03.

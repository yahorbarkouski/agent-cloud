# SSH keyscan compatibility review

## Verdict

**Approved for the third bounded customer attempt; no code blocker found.** The helper corrects the observed `ssh-keyscan -c` output shape without weakening certificate identity comparison. This was a source/artifact/trail review; no active transcript directory was supplied and this reviewer made no cloud or VM calls.

## Comparison semantics

`scripts/support/ssh-keyscan.ts` treats nonempty, non-comment keyscan output as an OpenSSH public certificate line, not a known-hosts line. It requires exactly one such line, takes fields 1 and 2 as certificate algorithm and base64 blob, and compares them exactly with fields 1 and 2 of the issued host certificate. It additionally requires the expected algorithm to be `ssh-ed25519-cert-v01@openssh.com`.

Ignoring a trailing certificate comment is appropriate; comments are not signed certificate identity. The helper does not accept an empty scan, a plain Ed25519 public key, a hostname-prefixed known-hosts line, or multiple certificate lines. It therefore fixes the field offset only; it does not fall back to key type alone, host name alone, or substring matching.

`scripts/smoke-ssh.ts` now exercises the real `/usr/bin/ssh-keyscan -c` output for both allocation and image-verifier subjects, loads the issued fixture certificate independently, and runs the positive and four negative static cases. Native session 26035 passed after the initial 9836 fixture mistake (`fixture.run()` returns `{stdout}`) was corrected. That first failure was test plumbing and should remain in the evidence trail rather than be described as a product regression.

The private customer driver imports the same helper, uses the provider-observed owned server address, and saves the raw public scan before comparison. This makes a future mismatch auditable without changing the equality rule.

## Second attempt evidence

`.local/customer-drill-lifecycle.second.json` supports these claims:

- Hetzner server `164971891` and Primary IP `148481208` reached allocated guest SSH state on the pinned manifest;
- create replay, enrollment/runtime, graceful power-off/on, and reboot completed, with the reboot observation at `2026-09-07T14:16:44.435Z`;
- the driver then reported `Guest SSH still presents a different certificate` under the old field slicing;
- destroy was admitted immediately and completed; the machine is destroyed, active allocations/live resources are zero, and exact provider reads at `14:21:17Z` report both IDs absent.

The old raw `ssh-keyscan` output was not saved. Therefore the correction explains the failure and is proven against native fixtures, but the record cannot establish that the destroyed second VM actually served the expected certificate. Do not retroactively upgrade that attempt to host-certificate verification. The third attempt must capture the raw scan and pass the corrected comparison.

## Budget and remaining scope

`.local/customer-drill-third-budget.json` is arithmetically consistent: first orphan IP `1,230` plus second VM/IP `27,798` plus the third maximum `27,798` equals `56,826` gross micro-USD, below the existing `60,000` customer VM/IP cap. It explicitly treats the retained snapshot/image-factory budget separately and states that the third run had not started when recorded. This is an upper bound from separately rounded one-hour rates, not an invoice.

The retained snapshot remains owned for the third attempt. No customer VM was active after second-attempt cleanup. A fresh paid create remains justified only within the recorded under-50-minute bound and with the existing cleanup owner retained through exact VM/IP absence.

## Trail correction resolved

The final reread confirms `docs/CONTEXT.md` now records driver 19160 exit 2, the successful lifecycle stages through reboot, the keyscan assertion failure before renewal, automatic VM/IP destruction, exact provider absence, and the missing raw old scan. It states that the third driver has not started and that only the retained snapshot and customer firewall remain. This matches `.local/customer-drill-lifecycle.second.json` and the budget artifact.

The earlier `customer-live-drill` row remains as chronological in-progress evidence. The new `customer-certificate-probe` row correctly records the parser cause, native/static session 26035, second VM/IP deletion, unavailable old raw scan, and unfinished real renewal. `docs/PROGRESS.md` carries the same proof boundary and third-attempt budget. No stale active-VM trail finding remains.

Full validation for the helper and the third live attempt remained pending at review time. The eventual evidence must distinguish native keyscan regression proof from live certificate observation, retain the initial 9836 fixture failure, record the final full-suite result, and prove final deletion of the third VM/IP plus retained snapshot/firewall ownership when the overall drill ends.

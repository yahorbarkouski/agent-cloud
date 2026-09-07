# Customer firewall compatibility review

## Verdict

**Approved for the next bounded drill; no code blocker found.** The correction aligns the provider firewall contract with the guest image that actually listens on TCP 22 and 8443. It removes unused public ports 80/443 and preserves strict ownership and exact-rule checks. This was an artifact/source review with no active transcript directory and no cloud calls by the reviewer.

## Policy consistency

`packages/guestctl/src/system.ts` configures the external Caddy listener on `:8443` with client certificate mode `require_and_verify`; SSH remains on 22. `packages/hetzner/src/customer-firewall.ts` now derives both the emitted rules and the validation set from one `ingressPorts = ['22', '8443']` list. Validation still requires:

- the exact configured firewall ID;
- labels `managed_by=agent-cloud` and `role=customer_access`;
- exactly two unique inbound TCP rules;
- sources exactly `0.0.0.0/0`;
- no destination restrictions and no outbound rules.

The destructive `Set` check rejects duplicates and missing ports as well as extras. Tests separately accept an independently constructed provider response for 22/8443 and reject an extra port, duplicate 22, outbound 8443, 22/443, and 22/80/443. This is stronger than merely comparing the provider response to the exported array and does not weaken the pre-effect ownership boundary.

No guest input changed. The retained snapshot already contains the 8443 listener, so the firewall correction changes provider ingress to match the immutable guest behavior rather than changing the image during the drill.

## Live firewall evidence

`.local/customer-drill-firewall-correction.json` identifies exact firewall `11587191`, its drill ownership label, its old 22/80/443 rules, the desired 22/8443 rules, a successful `set_firewall_rules` action targeting that same ID, and read-back state `verified` at `2026-09-07T14:04:33.314Z`. The firewall was unattached at correction time, so this did not mutate networking for a running customer VM. It remains a paid-scope owned resource that must be deleted during final drill cleanup.

The artifact proves the rule update and ownership continuity. It does not by itself prove packet reachability, guest listener health, TLS presentation, enrollment, or application service.

## TLS observation boundary

The private drill driver now connects to the provider-observed owned server address on port 8443, supplies the expected server name and trusted root, enables `rejectUnauthorized`, obtains the peer leaf certificate, and compares its SHA-256 fingerprint with the certificate retained in guest identity state. This is correctly scoped as a **public server-certificate observation**: it checks that the public socket presents the expected CA-validated leaf for the allocation subject.

The probe intentionally supplies no client certificate and sends no HTTP request. Because the listener requires and verifies client certificates, the observation does not authenticate a caller, exercise an application route, prove mutual-TLS application access, or establish a public product endpoint. Depending on TLS-stack behavior, a server may terminate a no-client-certificate handshake before Node emits `secureConnect`; the live drill must treat that as a failed observation rather than weakening Caddy's client-auth policy. A successful callback and fingerprint match remains certificate-presentation evidence only.

The architecture wording states this boundary accurately: the initial protected listener is on 8443, ports 80/443 are unused, and public application routing remains unfinished.

## Trail and remaining evidence

The saved parser correction remains independently reviewed and its exact Linux CI is still running; it should not be recorded as passed until completion. Full check 47080 for this firewall delta was also running at review time. The next checkpoint should record their final exits, formatting, the eventual live 8443 observation, and complete deletion of the customer VM/IP/firewall and retained image resources.

At review time no customer VM was active and the retained snapshot was still owned. Those are current execution facts, not cleanup completion. The existing progress/context correctly keep the paid image lifecycle and next customer drill active. No claim should upgrade the leaf observation into authenticated application proof.

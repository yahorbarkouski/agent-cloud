# M1 provider reference and native enrollment review

Reviewed the completed dirty boundary with the configured **gpt-5.6-sol** reviewer. Scope was the `create_guest` contract, guest renderer, Hetzner submit path, controller/effect/simulator handling, focused transport and provisioning tests, `smoke-enrollment.ts`, and the shared OpenSSH fixture. I made no implementation changes. After the main full check finished, I independently ran the three focused test files without rebuilding: **21 tests passed**. I also ran `smoke-enrollment.ts` directly against the current built code and it passed with zero cloud resources.

The composed native enrollment smoke exercises real PostgreSQL state, bootstrap recovery, the HTTP enrollment route, Smallstep certificate issuance, a raw-host-key-pinned OpenSSH proof, same-key replay, wrong-host-key rejection before identity claim, installation of the issued host certificate followed by a host-CA SSH connection, and a TLS handshake using the issued leaf. Provider lifecycle and the recorded address are simulated locally and deliberately translated to loopback. The smoke does not execute Hetzner HTTP, cloud-init, the rendered first-boot file, systemd on a VM, public-IP reachability, image sanitation, or runtime readiness. Its JSON result describes those limits accurately.

## Journal and submission boundary

The command split preserves historical data. Existing `create` records remain parseable and all journal classification, discovery, ownership, resolution, and simulator switches treat `create` and `create_guest` as server-create effects. A new Hetzner create requires the strict `create_guest` shape, an owned Primary IP, and a bootstrap reference. The legacy shape is rejected if presented as a fresh live submission; existing prepared or unknown legacy attempts still enter read-only discovery and reconciliation.

The controller prepares the bootstrap before journaling the VM effect. A crash between those transactions leaves an idempotently reusable bootstrap and no provider attempt. `journalEffect` then commits the exact reference-only command with outcome `prepared` before calling the provider. Before recovery, the renderer requires the exact attempt ID and command, a live matching allocation, `prepared` outcome, pending resolution, and matching admitted type, region, and machine name. Recovery then authenticates the bootstrap metadata and token; the renderer checks the recovered operation identity and complete allocation labels before returning any rendered data.

Only `HetznerProvider.submit` invokes the renderer, immediately before its first `/servers` request. Effect reconciliation never invokes `submit` or the renderer: prepared and unknown outcomes search by persisted labels, block on absence or duplicates, and adopt one exact observation. Focused loss, timeout-before-submit, and duplicate tests retain one VM attempt and call the renderer once. Once an outcome changes from prepared, a direct render call is rejected. This satisfies the no-resubmission rule, including the conservative case where a crash occurred before any provider request and reconciliation cannot prove non-submission.

## Secret and ownership boundary

The provider journal contains only `{version, allocationId}`. Recovery authenticates the encrypted token against persisted bootstrap metadata. The plaintext token exists only in renderer memory and the bounded cloud-init body sent to the provider. Renderer and transport errors are generic and do not include token, user data, or underlying exception text. The rendered bootstrap file is root-owned mode 0600, and the startup command contains no interpolated guest data.

The token is necessarily visible to the provider as user data and will also enter cloud-init's root-owned local cache on a real guest. The current smoke manually uses the recovered token rather than booting the rendered document. First-boot code must remove both `/var/lib/agent-cloud/bootstrap.json` and every cloud-init/user-data copy after enrollment, and that erasure still needs VM evidence. This is remaining image work, not a journal leak in the reviewed code.

The Hetzner request binds the renderer-selected pinned image, exact owned IPv4, configured firewall and bootstrap SSH key, disables automatic IPv6, and adds the attempt label. The renderer derives image and enrollment trust from the immutable bootstrap spec rather than mutable request input. The composed smoke checks that enrollment dials the provider-recorded address, but its provider adapter supplies loopback; it does not establish reachability from the control plane to a Hetzner guest.

## Assessment

No high-confidence correctness or secret-exposure blocker remains in this completed boundary. A local renderer failure is classified as a definitive pre-provider rejection, so cleanup is safe; this favors fail-fast operation over retrying transient local preparation faults. The earlier enrollment review's database/application clock observation for the 30-second signing cooldown remains unchanged, with absolute SQL attempt budgets still enforced.

The four appended enrollment/provisioning decision rows have six TSV columns and their repository evidence paths resolve. Their claims match the artifacts and independent runs: nine enrollment tests, durable signing budgets and handoff, reference-only rendering with no uncertain replay, and a native local enrollment smoke with simulated provider observations. No `agent-transcripts/` directory was supplied, so this is an artifact and live-rerun audit only. The reported 94-test full check and the other two native smoke results remain main-run evidence.

## Attention

reviewed by gpt-5.6-sol

- Preserve both command variants indefinitely enough to reconcile historical prepared and unknown attempts; never route them back through `submit`.
- Record the composed smoke as local native PKI/OpenSSH evidence with simulated loopback provider observations.
- Keep live activation closed until a real sanitized image consumes and erases rendered bootstrap data, public-IP proof works, and runtime readiness and renewal are verified.

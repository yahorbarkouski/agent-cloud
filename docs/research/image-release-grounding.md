# Image publication grounding

Grounded at c802b3a on 2026-09-07. This extends the selected guest architecture; it does not reopen enrollment or runtime readiness design. The how-skill explainer independently traced the files below without mutation.

`build-guest.ts` downloads eight pinned artifacts, bundles guestctl, stages installer/configuration and writes a manifest plus separate SHA256SUMS. The manifest pins component versions, public CA trust and the guest bundle hash. It does not bind the remaining public files. The installer verifies SHA256SUMS, installs the tools and writes a private builder record with external builder UUID, original machine ID, manifest digest and allowed homes.

`prepare-image` validates that record and bundle, refuses application state, persists preparing, cleans machine-specific state, then emits a sanitized receipt. The caller must stop that same builder before snapshotting. Local `smoke:image` verifies refusal, interrupted retry, clean logs, rejected partial clone and two distinct enrolled clones. A successful local receipt is not a provider snapshot receipt.

`GuestImage` bridges a provider image ID to manifest version/digest/architecture/public trust. `prepareGuestBootstrap` seals that image into allocation metadata. The renderer uses it only for the exact prepared create_guest attempt. On boot, the guest checks its manifest, sanitized record and fresh machine ID before generating keys. No release artifact currently establishes the provider image ID's provenance.

`effect-journal.ts` requires customer operation, allocation, principal and admitted offer. `resource-journal.ts` requires account/allocation foreign keys, handles only server/IP resources and updates allocations.serverId. Reusing it for platform builders would invent customer ownership and apply the wrong budgets. Reuse its persisted-intent and uncertainty rules, and the Hetzner HTTP transport, through an explicit sibling operator build/release boundary.

Relevant files: scripts/build-guest.ts; images/install.sh; packages/contracts/src/guest.ts/provider.ts; packages/guestctl/src/identity.ts/image.ts; apps/control/src/guest-bootstrap.ts/guest-renderer.ts/effect-journal.ts/resource-journal.ts; packages/db/src/schema.ts; packages/hetzner/src/index.ts/http.ts/catalog.ts.

## Provider evidence

Hetzner create-image is a server action accepting snapshot type, description and labels, and returning an image and action. Image metadata has creating/available state, source server, architecture, image/disk size, deletion protection and labels. Image listing and deletion are separate APIs. The official client demonstrates these contracts in [server.go](https://raw.githubusercontent.com/hetznercloud/hcloud-go/main/hcloud/server.go), [image.go](https://raw.githubusercontent.com/hetznercloud/hcloud-go/main/hcloud/image.go) and [image schema](https://raw.githubusercontent.com/hetznercloud/hcloud-go/main/hcloud/schema/image.go).

The pricing response supplies the account currency and image.price_per_gb_month.gross. See [pricing schema](https://raw.githubusercontent.com/hetznercloud/hcloud-go/main/hcloud/schema/pricing.go). Snapshot storage needs a separate explicit ceiling; a builder's VM/IP hourly limit does not cover it. Snapshots survive source deletion and exclude attached volumes; stop the source for disk consistency. See [snapshot FAQ](https://docs.hetzner.com/cloud/servers/backups-snapshots/faq/). Label values are limited to63characters; use build UUIDs as labels and retain full64-hex manifest digests in release metadata.

## Required end state for this boundary

The operator can build, inspect/resume and clean an image build without fabricating a customer allocation. Every cloud resource, including temporary management access, has recorded ownership before mutation. Unknown create responses reconcile without blind retries. Gross currency limits and a deadline cover builder VM/IP and snapshot retention. Installation and sanitation prove the full admitted public input set; publication links the stopped builder, sanitation receipt, snapshot and release manifest. Consumers verify that release before creating a guest. A bounded provider drill must clean all verification resources even after failed or uncertain steps, or retain explicit unresolved ownership for operator recovery.

No cloud mutation has been performed. Production worker activation, renewal and operator recovery are separate unfinished integration work in the full objective.

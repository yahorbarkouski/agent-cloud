# Hetzner transport contract notes

Checked 2026-09-06 against the [official OpenAPI document](https://docs.hetzner.cloud/cloud.spec.json) and [API reference](https://docs.hetzner.cloud/reference/cloud).

Observed spec SHA-256: `9ca6b542a057b002804b9f4f45ccfdb8b9a28c92b7e5bf5ae1b7f46b54fe0093`.

- Server create requires a hostname, server type, and image. Control-plane IDs contain underscores, so provider hostnames replace them with hyphens; IDs remain unchanged in labels.
- Create accepts firewalls, SSH keys, location, network options, and cloud-init data. Cloud-init is limited to 32 KiB.
- Create returns a server, action, additional actions, and possibly a root password. The adapter decodes only the IDs it needs and does not retain or log that password.
- Server objects expose `location` directly. The transport uses that current field rather than historical datacenter nesting.
- Mutations return asynchronous actions. HTTP success does not prove the action or guest boot finished.
- Resize uses `change_type` with `server_type` and `upgrade_disk`. Initial policy requires an off machine and forbids disk shrinking.
- Pricing includes account currency, net/gross amounts, Primary IP prices, backup percentage, and server-type prices. A static catalog cannot establish live total costs.
- Server types list per-location availability and deprecation details. A type existing does not imply regional capacity.

Before live activation: account-price admission, ancillary-resource ownership/cleanup, guest bootstrap and host verification, and live failure drills. A transport that can send requests is not a complete provisioning implementation.

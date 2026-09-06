# Local development and recovery

Use the root README commands. Compose project `agent-cloud-dev` exposes PostgreSQL on loopback port 55439. `pnpm db:down` preserves its volume. Add `--volumes` only when deliberately discarding this development database.

The API and worker are separate processes requiring `.env`. Runtime credentials belong under ignored `.local/`. Port choices avoid existing local projects.

Bootstrap writes a credential file before its database transaction. A rerun reuses saved IDs after a failed transaction. It does not extend expiry or un-revoke a credential. Its printed result includes only the file path, project ID, and server URL.

Blocked operations need evidence. Do not delete their rows or release reservations to make usage look smaller. Unknown outcomes may still own a server. Multiple matching servers need an explicit operator resolution flow, which is being implemented.

The simulator stores servers/actions independently. Losing a worker does not erase them. Simulated readiness proves control-plane convergence only, not SSH, systemd, Docker, or networking.

## Lessons captured in implementation

- Commander reserves `--version`; lifecycle requests use `--expected-version`. The smoke test executes the actual delete command.
- TypeScript 6 needs the intended ambient Node types selected explicitly.
- pnpm 12 uses `allowBuilds`; exact esbuild versions are approved. Keep strict build review enabled.
- A workspace-root optional-peer dependency once produced a dangling pnpm symlink. `pnpm install --fix-lockfile` repaired its missing peer snapshot. Normal setup uses the repaired lockfile with `--frozen-lockfile`; do not create manual symlinks.
- Active and idle PostgreSQL connections have error handlers. Worker session locks stay on one connection; uncertain lock connections are discarded.

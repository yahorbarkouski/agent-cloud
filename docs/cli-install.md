# Install the CLI

The CLI release includes its JavaScript dependencies, PostgreSQL and Umami recipes, and instructions for existing agents. Use Node.js 24 on Linux or macOS. SSH and SFTP commands also need the system OpenSSH client. No npm install, repository checkout or provider credentials are needed on the customer's machine.

The release workflow publishes developer previews on [GitHub Releases](https://github.com/yahorbarkouski/agent-cloud/releases). For a published preview, download the archive, `release.json`, `SHA256SUMS` and `provenance.jsonl` from the same release. GitHub signs its build provenance with the repository, workflow, tag and source revision. `BUILD.json` also records the lockfile digest and whether the checkout was dirty.

A locally built archive has checksums and build metadata but no GitHub signature. Obtain unsigned operator builds through an authenticated channel. A checksum beside an archive only detects corruption.

## Verify and unpack

Use an empty directory owned by your user. For the published `cli-v0.1.0` preview, use a current GitHub CLI to download and verify the exact signing workflow and source revision:

```sh
gh release download cli-v0.1.0 --repo yahorbarkouski/agent-cloud \
  --pattern 'agent-cloud-cli-0.1.0.tar.gz' --pattern 'release.json' \
  --pattern 'SHA256SUMS' --pattern 'provenance.jsonl'
revision=$(gh api repos/yahorbarkouski/agent-cloud/commits/cli-v0.1.0 --jq .sha)
for subject in agent-cloud-cli-0.1.0.tar.gz release.json SHA256SUMS; do
  gh attestation verify "$subject" --bundle provenance.jsonl --repo yahorbarkouski/agent-cloud \
    --signer-workflow yahorbarkouski/agent-cloud/.github/workflows/release-cli.yml \
    --source-ref refs/tags/cli-v0.1.0 --source-digest "$revision" --deny-self-hosted-runners
done
```

Stop on a failed verification. The signature authenticates the build's origin; it does not certify the application or your cloud configuration. This uses [GitHub's artifact attestation verification](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations).

On Linux, run `sha256sum --check SHA256SUMS`; on macOS, run `shasum -a 256 --check SHA256SUMS`. Check both the archive and manifest before extracting anything. Reject a mismatch and obtain fresh artifacts from your operator.

For version0.1.0:

```sh
shasum -a 256 --check SHA256SUMS
tar -xzf agent-cloud-cli-0.1.0.tar.gz
./agent-cloud-cli-0.1.0/bin/acld --version
```

Keep the extracted directory together. Add its absolute `bin` directory to your shell's `PATH`, or create a symlink to `bin/acld` in an existing directory on your `PATH`. Do not copy the launcher by itself. You can also run `node /absolute/path/agent-cloud-cli-0.1.0/dist/index.js` directly. Upgrades go into a new directory; switch your `PATH` or symlink after verifying the new release. Credentials remain in your private user configuration and are not part of the release.

`LICENSE` covers agent-cloud. `DEPENDENCIES.json` lists every bundled package/version, its declared license and the paths to its original notices. Dependency license files stay beside their packages. The archive does not include Docker images; recipe preparation is offline, while deployment pulls the recipe's pinned images.

## Connect your existing agent

```sh
acld agent instructions
acld recipe list
acld agent install --directory <existing-agent-skill-parent>/agent-cloud
acld login --server <operator-HTTPS-origin>
acld whoami
acld capabilities
acld project list
```

The skill's parent directory must exist. Installation creates a private directory and refuses existing files or symlinks, preserving your agent's local edits. Read the bundled instructions before deploying. GitHub sign-in requires admission by your cloud operator. Use the cloud's HTTPS origin, not the Hetzner API URL. The CLI stores only its cloud credential locally; it does not need your Hetzner token.

Existing delegated credentials can be imported with `acld login --server <origin> --token-stdin` using a private input stream. Never put the token in a shell argument or paste it into agent logs. `acld logout` revokes the credential and descendants on the server before removing its local file. Logging out does not destroy running applications.

## Build and verify a release

Maintainers use a checked checkout with Node.js 24 and pnpm12.3.4:

```sh
pnpm install --frozen-lockfile
pnpm release:cli --output .local/cli-release-0.1.0
pnpm smoke:cli-release
```

The output directory must be new and its parent must exist. The builder clears the four generated CLI package directories and forces a fresh TypeScript build. Do not run it alongside another build in the same checkout. Production dependency packaging then runs in an isolated temporary workspace, preserving the checkout's development dependencies. The builder copies only compiled CLI dependencies and bundled assets, rejects escaping links/private paths/native binaries/missing license texts, and writes `SHA256SUMS` last. Failed output remains for inspection; choose a new directory when retrying. Local builds do not publish or upload anything.

The smoke check verifies the archive and corruption detection, unpacks it outside the checkout, removes its build input, invokes the executable through an independent symlink, installs the skill, prepares recipes and uses authenticated HTTP CLI commands against isolated PostgreSQL. It checks revocation and exact fixture cleanup. It makes no provider call and does not prove public release signing or GitHub sign-in.

## Publish a preview

The `Release CLI` workflow runs only on a `cli-v<package-version>` tag. Before creating that tag, push the commit and wait for the existing `Check` job on that exact revision to pass. Release builds reuse that evidence and do not rerun an equivalent comprehensive suite. Branch and pull-request checks exclude tag pushes.

The build job scans tracked history, installs frozen dependencies, creates the archive from a clean checkout and exercises its offline CLI. It has no signing or publishing permission. A separate GitHub-hosted job verifies the downloaded artifact identity, signs all three release files, verifies the bundle against the exact workflow/ref/revision and uploads everything to a draft. Only then does it publish the preview. No package or archive code executes in that job. Actions and the history scanner are pinned to verified versions and checksums.

Do not move a release tag or replace published assets. A failure after draft creation leaves the draft for inspection; a retry refuses to overwrite it. Inspect its exact tag, revision and uploaded files before removing an incomplete unpublished draft. GitHub's ordinary plans require a public repository for artifact attestations. No provider, signing-key or npm-publishing secret is configured for this workflow.

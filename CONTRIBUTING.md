# Contribute

Start with [AGENTS.md](AGENTS.md), the [local setup](README.md#run-locally), and the documentation for the capability you are changing. State what a customer will be able to do, then exercise that CLI/API/application path. Keep changes focused and preserve authorization, operation ownership, retry and cleanup guarantees.

Use Node.js24 and pnpm12.3.4. Run `pnpm check`, `pnpm format:check` and the integration relevant to changed behavior. Documentation-only changes need formatting. Provider tests require explicit ownership, the recorded low cost caps and verified cleanup; use local fixtures first. Existing agents can contribute through the same commands.

Never commit credentials, generated private state or customer data. Release builds scan tracked history. `.gitleaksignore` contains exact reviewed historical false positives; do not add broad exclusions to make a finding disappear. Send suspected security issues through [the private reporting channel](SECURITY.md).

The core is Apache-2.0. Preserve upstream licenses and notices when adding dependencies, images or recipes. Pull requests should explain the customer behavior, relevant evidence and any remaining verification limit.

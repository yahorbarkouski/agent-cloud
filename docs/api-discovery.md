# Customer API discovery

Give an existing agent the API origin and ask it to read `/llms.txt`, then `/openapi.json`. Both are public read-only discovery endpoints on a customer API. The OpenAPI 3.1 document uses a relative server URL, so clients use the same origin they fetched it from. No operator credentials or deployment addresses are embedded.

```sh
curl --fail --silent --show-error "$ACLD_SERVER/llms.txt"
curl --fail --silent --show-error "$ACLD_SERVER/openapi.json" -o openapi.json
```

Import `openapi.json` into an OpenAPI 3.1 client or let the agent read its operations and JSON Schemas directly. Request schemas use the existing Zod input contracts; response schemas use their output contracts. Runtime authorization and cross-field checks remain authoritative. No documentation server or generation step is required.

Use `acld login` for configured GitHub sign-in, or an authorized delegated customer token. Customer `/v1` calls require `Authorization: Bearer <token>`; the GitHub exchange has its own OAuth bearer scheme. Store tokens privately and avoid putting them in source files or command logs.

Read authenticated `/v1/capabilities` to discover configured services and `/v1/whoami` for the current grant policy. Optional login, access, routing and backup routes appear only when their services are configured. This does not promise current health, capacity, guest-image compatibility or permission. Image factories expose neither discovery document and keep customer access disabled.

Persist an operation's idempotency key or request ID before its first submission. Reuse the same value and identical input after an uncertain reply; the OpenAPI operation describes whether it uses `Idempotency-Key`, body `id`, `commandId`, or has no such guarantee. HTTP 202 means admitted work, so poll its returned ID. A request timeout does not cancel it. Keep the response `X-Request-Id` or error `requestId` when investigating a failure.

The document covers public sign-in and customer HTTP methods only. SSH, file transfers, durable commands and Compose use the CLI's access-session workflow; discovery does not invent HTTP command-execution routes.

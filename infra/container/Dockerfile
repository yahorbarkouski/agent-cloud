FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY skills ./skills
COPY scripts/install-step.ts ./scripts/install-step.ts
RUN npm exec --yes --package=pnpm@12.3.4 -- pnpm install --frozen-lockfile --reporter=silent
RUN npm exec --yes --package=pnpm@12.3.4 -- pnpm exec tsc -b apps/control apps/cli apps/access-gateway apps/public-gateway
RUN npm exec --yes --package=pnpm@12.3.4 -- pnpm --filter @agent-cloud/control deploy --legacy --prod /output/control \
 && npm exec --yes --package=pnpm@12.3.4 -- pnpm --filter @agent-cloud/cli deploy --legacy --prod /output/cli \
 && npm exec --yes --package=pnpm@12.3.4 -- pnpm --filter @agent-cloud/access-gateway deploy --legacy --prod /output/access-gateway \
 && npm exec --yes --package=pnpm@12.3.4 -- pnpm --filter @agent-cloud/public-gateway deploy --legacy --prod /output/public-gateway
RUN node scripts/install-step.ts

FROM caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 AS caddy
# The upstream file capability prevents exec when the runtime drops all capabilities.
RUN setcap -r /usr/bin/caddy

FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends ca-certificates=20250419~deb12u1 openssh-client=1:9.2p1-2+deb12u10 \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=build /output /opt/agent-cloud
COPY --from=build --chmod=0755 /build/.local/tools/step-0.30.6 /usr/local/bin/step
COPY --from=caddy --chmod=0755 /usr/bin/caddy /usr/local/bin/caddy
COPY infra/container/entrypoint.mjs /opt/agent-cloud/entrypoint.mjs
RUN mkdir -p /work/.local /run/agent-cloud /run/agent-cloud-wal /var/lib/agent-cloud/scratch \
 && chown -R node:node /work /run/agent-cloud /run/agent-cloud-wal /var/lib/agent-cloud \
 && chmod 0700 /work/.local /run/agent-cloud /run/agent-cloud-wal /var/lib/agent-cloud/scratch
USER node
WORKDIR /work
ENTRYPOINT ["node", "/opt/agent-cloud/entrypoint.mjs"]
CMD ["api"]

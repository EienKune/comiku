ARG NODE_IMAGE=node:24.22.1-bookworm-slim
ARG POSTGRES_IMAGE=postgres:17-bookworm
FROM ${NODE_IMAGE} AS build
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@9.1.2
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .node-version .nvmrc ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/api-client/package.json ./packages/api-client/package.json
COPY scripts/check-runtime.mjs ./scripts/check-runtime.mjs
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @comiku/server build && pnpm --filter @comiku/server build:ops
ARG COMIKU_RELEASE=unconfigured
ENV COMIKU_RELEASE=${COMIKU_RELEASE}

FROM build AS tools
RUN chown -R node:node /app/apps/server/src/generated
USER node
CMD ["pnpm", "db:deploy"]

FROM build AS production-dependencies
# pnpm 9 deploy re-resolves ranges; retain the workspace lockfile and symlink tree.
RUN CI=true pnpm install --prod --frozen-lockfile --offline

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app/apps/server
COPY --from=production-dependencies /app/node_modules /app/node_modules
COPY --from=production-dependencies /app/apps/server/node_modules ./node_modules
COPY --from=build /app/apps/server/package.json ./package.json
COPY --from=build /app/apps/server/dist ./dist
ARG COMIKU_RELEASE=unconfigured
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 COMIKU_RELEASE=${COMIKU_RELEASE}
USER node
CMD ["node", "dist/main.js"]

FROM ${POSTGRES_IMAGE} AS backup
COPY --from=build /usr/local/bin/node /usr/local/bin/node
WORKDIR /app/apps/server
COPY --from=production-dependencies /app/node_modules /app/node_modules
COPY --from=production-dependencies /app/apps/server/node_modules ./node_modules
COPY --from=build /app/apps/server/package.json ./package.json
COPY --from=build /app/apps/server/dist-ops ./dist-ops
ARG COMIKU_RELEASE=unconfigured
ENV COMIKU_RELEASE=${COMIKU_RELEASE}
USER 1000:1000
ENTRYPOINT ["node", "dist-ops/scripts/backup.js"]
CMD ["backup"]

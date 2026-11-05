# Ordo: one container serves the API, the live stream, the engine timer and the web console (Render, or any Docker host).
# It also carries the machine body bundle (body/dist) that BODY_RUNTIME=sandbox uploads to each machine's Vercel Sandbox.
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app

# Every workspace manifest and the lockfile, nothing else, so the install layer stays cached until a dependency changes.
FROM base AS manifests
COPY . /src
RUN cd /src && mkdir /out \
 && cp pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json /out/ \
 && find . -name package.json -not -path "*/node_modules/*" -not -path "./package.json" -exec cp --parents {} /out/ \;

# Build the console, the server and (when the package exists) the machine body.
FROM base AS build
COPY --from=manifests /out ./
RUN pnpm install --frozen-lockfile --filter "@ordo/server..." --filter "@ordo/web..." --filter "{./body}..."
COPY . .
RUN pnpm --filter @ordo/web build \
 && pnpm --filter @ordo/server build \
 && pnpm --filter "{./body}" run --if-present build
# the body's bundle and its dependency list, or an empty folder before the body package exists
RUN mkdir -p /out/body && if [ -f body/dist/body.mjs ]; then cp -r body/dist body/package.json /out/body/; fi

FROM base AS prod-deps
COPY --from=manifests /out ./
RUN pnpm install --frozen-lockfile --prod --filter "@ordo/server..."

FROM node:22-slim
ENV NODE_ENV=production PORT=8080 WEB_DIST=/app/web/dist POLICY_FILE=/app/policies/default.yaml DATA_DIR=/data ORDO_BODY_DIR=/app/body
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/zk ./server/zk
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /out/body ./body
COPY policies ./policies
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /app/server
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]

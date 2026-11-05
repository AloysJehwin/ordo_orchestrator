# Ordo: one container serves the API, the live stream and the web console.
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY contracts/package.json contracts/

FROM base AS build
RUN pnpm install --frozen-lockfile --filter @ordo/server... --filter @ordo/web...
COPY policies policies
COPY server server
COPY web web
RUN pnpm --filter @ordo/web build && pnpm --filter @ordo/server build

FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod --filter @ordo/server...

FROM node:22-slim
ENV NODE_ENV=production PORT=8080 WEB_DIST=/app/web/dist POLICY_FILE=/app/policies/default.yaml DATA_DIR=/data
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/zk ./server/zk
COPY --from=build /app/web/dist ./web/dist
COPY policies ./policies
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /app/server
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]

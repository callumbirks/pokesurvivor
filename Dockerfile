# syntax=docker/dockerfile:1

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-slim AS build
RUN npm install -g pnpm@11.10.0
WORKDIR /repo
# Install dependencies first so this layer is cached until a manifest or the lockfile changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/client/package.json apps/client/
COPY apps/server/package.json apps/server/
COPY packages/data/package.json packages/data/
COPY packages/protocol/package.json packages/protocol/
COPY packages/sim/package.json packages/sim/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY apps apps
COPY packages packages
RUN pnpm build
# The server's production dependencies only (workspace packages are bundled into dist/main.js).
RUN pnpm deploy --legacy --filter @pokesurvivor/server --prod /out/server

FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
# Same relative layout as the repo, so the server finds ../../client/dist and ../../../legacy.
COPY legacy legacy
COPY --from=build /out/server apps/server
COPY --from=build /repo/apps/client/dist apps/client/dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/server/dist/main.js"]

# syntax=docker/dockerfile:1.7
# 建置：在 repo 根目錄執行 docker build -f apps/api/Dockerfile .
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

# ---- 編譯
FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter "@travelog/api..." --filter travelog
RUN pnpm turbo run build --filter=@travelog/api...

# ---- 只安裝執行期相依
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/mobile/package.json apps/mobile/
COPY packages/domain/package.json packages/domain/
COPY packages/schema/package.json packages/schema/
COPY packages/db/package.json packages/db/
COPY packages/tools/package.json packages/tools/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts --filter "@travelog/api..."

# ---- 執行
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /repo
COPY --chown=node:node --from=prod-deps /repo ./
COPY --chown=node:node --from=build /repo/packages/domain/dist packages/domain/dist
COPY --chown=node:node --from=build /repo/packages/schema/dist packages/schema/dist
COPY --chown=node:node --from=build /repo/packages/db/dist packages/db/dist
COPY --chown=node:node --from=build /repo/packages/db/drizzle packages/db/drizzle
COPY --chown=node:node --from=build /repo/packages/tools/dist packages/tools/dist
COPY --chown=node:node --from=build /repo/apps/api/dist apps/api/dist
WORKDIR /repo/apps/api
USER node
EXPOSE 8080
# migration：同一個映像檔，指令改成 node dist/migrate.js（Cloud Run Job）
CMD ["node", "dist/server.js"]

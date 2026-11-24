# syntax=docker/dockerfile:1.7
# 建置：在 repo 根目錄執行
#   docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_API_ORIGIN=https://api.example.com .
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
# NEXT_PUBLIC_* 在建置時寫進前端程式
ARG NEXT_PUBLIC_API_ORIGIN
ARG NEXT_PUBLIC_GOOGLE_MAPS_KEY=""
ARG NEXT_PUBLIC_GOOGLE_MAP_ID=""
ENV NEXT_PUBLIC_API_ORIGIN=$NEXT_PUBLIC_API_ORIGIN \
    NEXT_PUBLIC_GOOGLE_MAPS_KEY=$NEXT_PUBLIC_GOOGLE_MAPS_KEY \
    NEXT_PUBLIC_GOOGLE_MAP_ID=$NEXT_PUBLIC_GOOGLE_MAP_ID \
    NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter "@travelog/web..." --filter travelog
RUN test -n "$NEXT_PUBLIC_API_ORIGIN" || (echo "需要 --build-arg NEXT_PUBLIC_API_ORIGIN" && exit 1)
RUN pnpm turbo run build --filter=@travelog/web

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    HOSTNAME=0.0.0.0
WORKDIR /app
COPY --chown=node:node --from=build /repo/apps/web/.next/standalone ./
COPY --chown=node:node --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --chown=node:node --from=build /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 8080
CMD ["node", "apps/web/server.js"]

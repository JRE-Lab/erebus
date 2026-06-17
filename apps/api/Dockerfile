# EREBUS API — runs via tsx (no compile step; workspace TS imported directly).
FROM node:20-alpine
WORKDIR /app

RUN corepack enable

# Workspace manifests first (better layer caching)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/

RUN pnpm install --no-frozen-lockfile

# Source
COPY packages ./packages
COPY apps/api ./apps/api

ENV NODE_ENV=production
EXPOSE 8787
WORKDIR /app/apps/api
CMD ["pnpm", "start"]

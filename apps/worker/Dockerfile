# EREBUS autonomous worker — runs the scheduler via tsx.
FROM node:20-alpine
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json drizzle.config.ts ./
COPY packages ./packages
COPY apps/worker ./apps/worker

RUN pnpm install --no-frozen-lockfile

ENV NODE_ENV=production
WORKDIR /app/apps/worker
CMD ["pnpm", "start"]

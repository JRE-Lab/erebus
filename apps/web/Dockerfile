# EREBUS web — Next.js build, run with `next start`.
FROM node:20-alpine AS build
WORKDIR /app
RUN corepack enable

ARG NEXT_PUBLIC_API_URL=http://localhost:8787
ARG NEXT_PUBLIC_WS_URL=ws://localhost:8787/ws
ARG NEXT_PUBLIC_EREBUS_USER=erebus
ARG NEXT_PUBLIC_EREBUS_PASS=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL \
    NEXT_PUBLIC_EREBUS_USER=$NEXT_PUBLIC_EREBUS_USER \
    NEXT_PUBLIC_EREBUS_PASS=$NEXT_PUBLIC_EREBUS_PASS

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
RUN pnpm install --no-frozen-lockfile

COPY packages ./packages
COPY apps/web ./apps/web

WORKDIR /app/apps/web
RUN pnpm build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["pnpm", "start"]

FROM oven/bun:1.3.14-alpine

WORKDIR /repo

COPY package.json tsconfig.json bun.lock ./
COPY packages/gateway/package.json packages/gateway/package.json
# bun.lock cobre o workspace inteiro: sem os package.json dos outros membros
# do workspace o --frozen-lockfile falha com "lockfile had changes" (desde a
# F4, e de novo ao adicionar o tier-classifier).
COPY packages/cli/package.json packages/cli/package.json
COPY packages/tier-classifier/package.json packages/tier-classifier/package.json
RUN bun install --frozen-lockfile

COPY packages/gateway packages/gateway

WORKDIR /repo/packages/gateway
EXPOSE 11434
CMD ["bun", "run", "src/index.ts"]

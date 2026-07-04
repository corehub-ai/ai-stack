FROM oven/bun:1.3.14-alpine

WORKDIR /repo

COPY package.json tsconfig.json bun.lock ./
COPY packages/tier-classifier/package.json packages/tier-classifier/package.json
# bun.lock cobre o workspace inteiro: sem os package.json dos outros membros
# do workspace, --frozen-lockfile falha com "lockfile had changes" (mesmo
# achado do packages/gateway/Dockerfile, commit 36f9102).
COPY packages/gateway/package.json packages/gateway/package.json
COPY packages/cli/package.json packages/cli/package.json
RUN bun install --frozen-lockfile

COPY packages/tier-classifier packages/tier-classifier

WORKDIR /repo/packages/tier-classifier
EXPOSE 8788
CMD ["bun", "run", "src/index.ts"]

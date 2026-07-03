FROM oven/bun:1.3.14-alpine

WORKDIR /repo

COPY package.json tsconfig.json bun.lock ./
COPY packages/gateway/package.json packages/gateway/package.json
RUN bun install --frozen-lockfile

COPY packages/gateway packages/gateway

WORKDIR /repo/packages/gateway
EXPOSE 11434
CMD ["bun", "run", "src/index.ts"]

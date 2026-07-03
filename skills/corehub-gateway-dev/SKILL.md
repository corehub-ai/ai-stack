---
name: corehub-gateway-dev
description: Develop packages/gateway in ia-stack -- a Bun+Hono TypeScript reverse proxy exposing OpenAI, Anthropic, and Ollama-compatible surfaces. Use when adding gateway routes, editing the Ollama translators, writing gateway tests, or hitting TypeScript/Biome/tsconfig errors in this Bun workspace.
---

# corehub-gateway-dev

Working knowledge for `packages/gateway` in the **ia-stack** monorepo (Bun workspaces, TypeScript
strict). The gateway sits in front of headroom/manifest and terminates three API surfaces: OpenAI
(`/v1/*`), Anthropic (`/v1/messages`), and Ollama (`/api/*`, translated).

## Commands (exact — do not improvise variants)

- Typecheck: `bun run typecheck` (root `tsc --build`, NOT per-package)
- Lint: `bun run lint` / autofix `bun run lint:fix` (Biome 2.5.2)
- Tests: `bun test packages/gateway/test` — **never** `bun test packages/gateway` (bare package
  dir): after any `tsc --build`, compiled `.js` tests leak into `packages/gateway/dist/` and get
  picked up too, and they fail because fixtures aren't copied there.
- Dev server: `bun run --cwd packages/gateway dev` (watch mode)

## Monorepo TypeScript pattern

Root `tsconfig.json` is a pure orchestrator: `"files": []` + `"references"`, NOT `composite` and
NOT `bun-types` (adding either breaks `tsc --build` with TS6304/TS2688). Each package's own
`tsconfig.json` extends the root and sets `"composite": true`, `"types": ["bun-types"]`. Adding a
new package means adding it to root `references` too, or `tsc --build` silently skips it.

`exactOptionalPropertyTypes: true` is on — you cannot assign `x: undefined` into an object literal
typed `x?: T`. Pattern used throughout `src/ollama/translate-chat.ts`: build the base object first,
then conditionally assign optional fields only when they have a real value (see `applyStats`).

## Biome 2.5.2 gotchas

Schema differs from commonly-documented versions: `organizeImports` lives at
`assist.actions.source.organizeImports`, and `linter.rules.recommended` is now
`linter.rules.preset` (must be explicitly `"recommended"` — `biome migrate` defaults it to
`"none"`). Captured test fixtures (raw SSE/NDJSON bytes) must be excluded or Biome tries to
reformat them: `"files": {"includes": ["**", "!**/test/fixtures"]}`.

## Ollama surface (`src/ollama/`, `routes/ollama.ts`)

`/api/*` is **terminated at the gateway** — never forwarded to manifest (there, `/api/*` is the
dashboard's own internal API). Only `/api/chat` and `/api/generate` reach out, and they call the
OpenAI leg (`headroom/v1/chat/completions`), not `/api/*` anywhere downstream.

Translation facts verified against a real Ollama 0.31.1 and the live chain (not assumed from
docs):
- Stream format: OpenAI SSE (`data: {...}` + `data: [DONE]`) in, Ollama NDJSON (one JSON object
  per line, no prefix, terminator `"done":true`) out.
- `tool_calls[].function.arguments` is a **string** fragmented across OpenAI stream deltas but an
  **object** in Ollama's wire format — accumulate by tool index, `JSON.parse` once complete
  (`translate-chat.ts`'s `Map<number, ToolAccumulator>`).
- Durations in the final chunk are **nanoseconds**, not milliseconds.
- The real `ollama` CLI **panics** (`slice bounds out of range [:12]`) on `ollama list` if
  `/api/tags` returns an empty `digest` (it does `digest[:12]` for display) — synthetic entries
  need a non-empty digest (64 zero-chars is fine) and non-zero size.

## Security pattern: header forwarding

`src/proxy-headers.ts` is the single place that decides what headers reach headroom — it strips
`host`/`authorization`/`x-api-key` from the copied client headers first, then re-adds either the
injected default-key auth or the client's own credential. Route handlers must go through this
helper rather than spreading `c.req.header()` directly, so credential injection can't be
shadowed by a client-supplied header of the same name.

Do not default any IP-based trust (`GATEWAY_TRUSTED_CIDRS`) to the compose bridge subnet — Docker's
`docker-proxy` (userland-proxy, on by default) hairpins host-loopback traffic through the bridge
gateway IP, making that subnet indistinguishable from genuine container traffic. See
`packages/gateway/src/cidr.ts`'s `normalizeIp` and the comment in `docker-compose.yml` next to
`GATEWAY_TRUSTED_CIDRS`.

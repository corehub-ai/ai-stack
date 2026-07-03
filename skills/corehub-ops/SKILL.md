---
name: corehub-ops
description: Operate and troubleshoot the ia-stack self-hosted AI gateway (gateway -> headroom -> manifest -> providers) via the corehub CLI. Use when starting/stopping the stack, connecting a new tool, debugging auth/health/routing failures, or reading cost/compression dashboards.
---

# corehub-ops

Operational knowledge for **ia-stack**: a self-hosted chain that fronts OpenAI/Anthropic-compatible
providers with context compression ([headroom](https://github.com/headroomlabs-ai/headroom)) and LLM
routing/cost control ([manifest](https://github.com/mnfst/manifest)) behind a custom gateway.

## Topology

```
tools (opencode, Claude Code, Copilot, Open WebUI, Ollama clients)
  |  OpenAI /v1/* . Anthropic /v1/messages . Ollama /api/*
  v
gateway  :11434  (Bun+Hono, packages/gateway) -- LAN
  v
headroom :8787   (compression) -- compose-internal only
  v
manifest :2099   (routing, cost/limits; dashboard) -- LAN, own auth
  v
providers (external APIs, or the bundled `ollama` compose service, profile local-models)
```

## The `corehub` CLI (`packages/cli`)

| Command | Does |
|---|---|
| `corehub init` | writes `deploy/compose/.env` with 4 fresh infra secrets (never touches `MANIFEST_KEY_*`, never overwrites without `--force`) |
| `corehub up [--profile ui] [--no-build]` | `docker compose up -d --build` |
| `corehub down [--volumes]` | `docker compose down`, optionally wiping named volumes |
| `corehub status` | `docker compose ps` |
| `corehub doctor` | checks `.env` secrets + gateway `/health` (3-hop aggregate) + a real end-to-end chat completion |
| `corehub skills sync` | per-skill symlinks from `skills/` into `~/.claude/skills` and `~/.agents/skills` |

New machine, 3 commands: `corehub init` -> `corehub up` -> `corehub doctor`.

## Connecting a new tool

Every tool is its own **agent** in the manifest dashboard (`http://localhost:2099`) with its own
`mnfst_` key -> its own cost line. Steps: create the agent, connect a provider, set the default
tier, copy the key into `deploy/compose/.env` as `MANIFEST_KEY_<TOOL>`, `corehub up` again.
Full per-tool setup (opencode, Claude Code, Copilot BYOK, Open WebUI, generic Ollama clients):
`docs/connecting-tools.md` in the repo root.

## Common failure modes

- **`corehub doctor` fails on `/health`**: `headroom` or `manifest` unhealthy. `corehub status`
  to see which container isn't `healthy`, then `docker compose -f deploy/compose/docker-compose.yml
  --env-file deploy/compose/.env logs <service>`.
- **401 from the gateway with no `Authorization` header, from a LAN client**: expected — keyless
  access is loopback-only by default. Set `GATEWAY_TRUSTED_CIDRS` deliberately if you need it (see
  the comment above it in `deploy/compose/.env.example` — do NOT set it to the compose bridge
  subnet, `docker-proxy`'s userland hairpin makes that an auth bypass).
- **`manifest` container "up" but healthcheck never turns green**: it needs `PORT=2099` and
  `BIND_ADDRESS=0.0.0.0` explicitly — without them it silently listens on `3001` instead.
- **`OLLAMA_HOST` for the bundled `ollama` service**: must be the compose service name
  (`http://ollama:11434`), never `host.docker.internal:11434` — that would point manifest's Ollama
  provider back at the gateway itself (same port), a request loop.
- **A completion through `/v1/chat/completions` and one through `/v1/messages` return the wrong
  JSON shape for the prompt sent**: headroom's semantic cache is keyed on prompt text only, ignoring
  the endpoint format — reusing identical prompt text across the two surfaces in the same test run
  hits the other leg's cached response. Use distinct prompts per leg.
- **Checking a ghcr.io image's real latest tag**: the anonymous tag-list API paginates past ~1000
  tags; an unpaginated check can report a stale tag as "latest" (happened with both `headroom` and
  `open-webui` in this repo's history). Page with `?n=1000&last=<cursor>` to the end before trusting it.

## Secrets

Only in `deploy/compose/.env` (gitignored) and `deploy/compose/.admin.local` (gitignored via
`*.local`) — the manifest admin bootstrap password. `.env.example` is the versioned template;
`corehub init` renders it. Never print, log, or commit a `mnfst_` key or a generated secret.

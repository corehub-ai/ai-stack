# ia-stack

Self-hosted AI stack: a custom gateway (OpenAI + Anthropic + Ollama-compatible surfaces)
in front of [headroom](https://github.com/headroomlabs-ai/headroom) (context compression)
and [manifest](https://github.com/mnfst/manifest) (LLM routing & cost control).
Connect opencode, GitHub Copilot, Claude Code — or anything speaking those protocols.

**Status:** F3 — Ollama façade live (`/api/chat`, `/api/generate`, `tags`/`show`/`version`);
Open WebUI in the stack; OpenAI + Anthropic surfaces from F2 still up. Gateway on `:11434`.

## Quick start (F3)

1. `cd deploy/compose && cp .env.example .env` — fill the three secrets (`openssl rand -hex 32`)
   plus `WEBUI_SECRET_KEY` if you'll use the `ui` profile. If port `11434` is already taken
   on your machine (e.g. a native Ollama install), set `GATEWAY_HOST_PORT` in `.env`.
2. `docker compose --profile local-models up -d --build` (add `--profile ui` for Open WebUI).
3. Open `http://localhost:2099` — create the admin account, connect a provider (bundled
   Ollama tile works once you `docker exec <ollama-container> ollama pull <model>`), set the
   default routing tier, create the agents (`opencode`, `claude-code`, `copilot`, `openwebui`,
   `lan-anon`) and put their `mnfst_` keys in `.env`.
4. `./scripts/validate-ollama.sh` (and `./scripts/validate-gateway.sh`) — everything must PASS.
5. See `docs/connecting-tools.md` for opencode / Claude Code / Copilot / Open WebUI / Ollama clients.

Design spec: `docs/superpowers/specs/2026-07-02-ia-stack-design.md` (pt-BR). License: MIT.

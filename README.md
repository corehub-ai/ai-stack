# ia-stack

Self-hosted AI stack: a custom gateway (OpenAI + Anthropic + Ollama-compatible surfaces)
in front of [headroom](https://github.com/headroomlabs-ai/headroom) (context compression)
and [manifest](https://github.com/mnfst/manifest) (LLM routing & cost control).
Connect opencode, GitHub Copilot, Claude Code — or anything speaking those protocols.

**Status:** F1 — compose chain (headroom → manifest) up and validated.

## Quick start (F1)

1. `cd deploy/compose && cp .env.example .env` — fill the three secrets (`openssl rand -hex 32`).
2. `docker compose up -d` (the `local-models` profile is active by default via
   `COMPOSE_PROFILES` in `.env.example` — it runs a local Ollama container as
   the F1 provider so no paid API key is required to try the stack).
3. Open `http://localhost:2099` — create the admin account, connect at least one
   provider (the bundled Ollama tile works out of the box once you `docker exec
   <ollama-container> ollama pull <model>`), configure the default routing tier,
   create the agents (`opencode`, `claude-code`, `copilot`, `openwebui`, `lan-anon`)
   and put their `mnfst_` keys in `.env`.
4. `./scripts/validate-chain.sh` — everything must PASS.

Design spec: `docs/superpowers/specs/2026-07-02-ia-stack-design.md` (pt-BR). License: MIT.

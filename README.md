# ia-stack

Self-hosted AI stack: a custom gateway (OpenAI + Anthropic + Ollama-compatible surfaces)
in front of [headroom](https://github.com/headroomlabs-ai/headroom) (context compression)
and [manifest](https://github.com/mnfst/manifest) (LLM routing & cost control).
Connect opencode, GitHub Copilot, Claude Code — or anything speaking those protocols.

**Status:** F4 — `corehub` CLI (`init`/`up`/`down`/`status`/`doctor` + `skills sync`).
Gateway on `:11434` with OpenAI + Anthropic + Ollama surfaces; Open WebUI in the stack.

## Quick start (F4)

New machine, ≤3 commands (after cloning):

1. `bun install`
2. `bun run corehub init` — writes `deploy/compose/.env` with fresh infra secrets. If port
   `11434` is already taken on your machine (e.g. a native Ollama install), set
   `GATEWAY_HOST_PORT` in `.env`.
3. `bun run corehub up` — builds and starts the stack (add `--profile ui` for Open WebUI).
4. Open `http://localhost:2099` — create the manifest admin, connect a provider (bundled
   Ollama tile works once you `docker exec <ollama-container> ollama pull <model>`), set the
   default routing tier, create the agents (`opencode`, `claude-code`, `copilot`, `openwebui`,
   `lan-anon`), paste their `mnfst_` keys into `.env`, then `bun run corehub up` again.
5. `bun run corehub doctor` — the chain must be all green.

Later, `bun run corehub skills sync` links the shared skills library (populated in F5) into
`~/.claude/skills` and `~/.agents/skills`. See `docs/connecting-tools.md` for per-tool setup
(opencode / Claude Code / Copilot / Open WebUI / Ollama clients) and the full CLI reference.

Design spec: `docs/superpowers/specs/2026-07-02-ia-stack-design.md` (pt-BR). License: MIT.

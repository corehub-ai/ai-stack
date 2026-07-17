# ia-stack

Self-hosted AI gateway stack. A custom edge gateway exposing **OpenAI-, Anthropic- and
Ollama-compatible** surfaces sits in front of two proxies —
[headroom](https://github.com/headroomlabs-ai/headroom) (context compression) and
[manifest](https://github.com/mnfst/manifest) (LLM routing, cost control, dashboard) — plus a
small **prompt-complexity classifier** that tags each request with a routing tier.

Point opencode, GitHub Copilot, Claude Code, Open WebUI, or anything speaking those protocols at
one endpoint (`:11434`) and let the stack route each request to the right model — a local Ollama
model, an Anthropic subscription, an OpenCode subscription, etc. — per rules you set in the
dashboard.

- **License:** MIT (see [`LICENSE`](LICENSE)).
- **Per-tool connection guide & CLI reference:** [`docs/connecting-tools.md`](docs/connecting-tools.md).
- **Design specs (pt-BR):** [`docs/superpowers/specs/`](docs/superpowers/specs/).

---

## Table of contents

- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [Detailed setup](#detailed-setup)
- [Configuration reference (`.env`)](#configuration-reference-env)
- [Connecting your tools](#connecting-your-tools)
  - [Recommended: a Claude Code harness with canonicalizer bypass](#recommended-a-claude-code-harness-with-canonicalizer-bypass)
- [How routing works (the tier-classifier)](#how-routing-works-the-tier-classifier)
- [Local models (GPU)](#local-models-gpu)
- [Operating the stack](#operating-the-stack)
- [Development](#development)
- [Security notes](#security-notes)
- [License](#license)

---

## Architecture

Every inference request flows through the same chain. Model selection, cost accounting and
provider credentials all live in the **manifest** — the gateway and classifier never hold a
provider key.

```
        ┌────────────┐   OpenAI / Anthropic / Ollama surface
client →│  gateway   │  :11434  (LAN edge, auth, protocol translation)
        └─────┬──────┘
              ▼
        ┌────────────┐
        │  headroom  │  context compression (3rd-party image)
        └─────┬──────┘
              ▼
        ┌──────────────────┐
        │ tier-classifier  │  :8788  classifies prompt → x-manifest-tier
        │                  │         + canonicalizes sampling params
        └─────┬────────────┘
              ▼
        ┌────────────┐        ┌──────────────┐
        │  manifest  │  :2099 │  postgres    │  router + cost control + dashboard
        └─────┬──────┘        └──────────────┘
              ▼
   real providers: Ollama (local, GPU) · Anthropic subscription · OpenCode · …
```

| Service | Host port | Role | Source |
|---|---|---|---|
| **gateway** | `11434` | Edge. Exposes the three surfaces, applies LAN auth, translates Ollama⇄OpenAI. | this repo (`packages/gateway`) |
| **headroom** | internal | Context/prompt compression proxy. | 3rd-party image |
| **tier-classifier** | internal (`8788`) | Classifies prompt complexity → sets `x-manifest-tier`; canonicalizes request params. | this repo (`packages/tier-classifier`) |
| **manifest** | `2099` | LLM router, cost control, and admin dashboard. Owns provider credentials & routing. | 3rd-party image |
| **postgres** | internal | manifest's database. | official image |
| **ollama** | internal | Local model provider (profile `local-models`, uses the GPU). | official image |
| **openwebui** | `3000` | Optional chat UI (profile `ui`). | official image |

The three gateway surfaces: OpenAI (`/v1/chat/completions`, `/v1/responses`, `/v1/models`),
Anthropic (`/v1/messages`), and native Ollama (`/api/chat`, `/api/generate`, `/api/tags`, …).
The Ollama surface is translated to OpenAI inside the gateway, so all traffic converges on the
same downstream chain.

---

## Prerequisites

- **Docker** + **Docker Compose v2** (`docker compose`, not the legacy `docker-compose`).
- **[Bun](https://bun.sh)** ≥ 1.3 — runs the `corehub` CLI and the test suites.
- **openssl** — generates the infra secrets (`corehub init` uses it).
- **(Optional) NVIDIA Container Toolkit** — only if you want the bundled local models
  (`local-models` profile) to run on the GPU. Without it, disable that profile or expect
  CPU-only (slow) inference. Verify with `docker info | grep -i runtimes` (should list `nvidia`).

---

## Quick start

New machine, after cloning:

```bash
bun install
bun run corehub init          # writes deploy/compose/.env with fresh infra secrets
bun run corehub up            # builds & starts the stack (add --profile ui for Open WebUI)
# → open http://localhost:2099, set up the dashboard (see "Detailed setup" step 4),
#   paste the mnfst_ agent keys into deploy/compose/.env, then:
bun run corehub up            # restart with the keys wired in
bun run corehub doctor        # end-to-end health check — must be all green
```

If port `11434` is already taken (e.g. a native Ollama install), set `GATEWAY_HOST_PORT` in
`.env` before `corehub up`.

---

## Detailed setup

### 1. Clone & install

```bash
git clone <repo-url> ia-stack && cd ia-stack
bun install
```

### 2. Generate infra secrets

```bash
bun run corehub init
```

This writes `deploy/compose/.env` from `.env.example` and fills the **infra** secrets
(`BETTER_AUTH_SECRET`, `MANIFEST_ENCRYPTION_KEY`, `POSTGRES_PASSWORD`, `WEBUI_SECRET_KEY`) with
fresh `openssl rand -hex 32` values. It does **not** overwrite an existing `.env` (use
`corehub init --force` to regenerate). The `MANIFEST_KEY_*` agent keys stay empty for now —
you mint those in the dashboard in step 4.

`deploy/compose/.env` is git-ignored and never leaves your machine.

### 3. First boot

```bash
bun run corehub up            # or: --profile ui to include Open WebUI
```

The stack comes up, but inference will 401 until the agent keys exist. That's expected — do
step 4 next.

### 4. Configure the manifest (dashboard at `:2099`)

Open `http://localhost:2099` (or `http://<lan-ip>:2099`; set `MANIFEST_PUBLIC_URL` in `.env` to
match the origin your browser uses, or login fails with "Invalid origin").

1. **Create the admin account** (manifest's own Better Auth).
2. **Connect a provider.** The bundled Ollama tile works out of the box once you pull a model:
   `docker exec ia-stack-ollama-1 ollama pull <model>`. Add subscription/API providers
   (Anthropic, OpenCode, …) as needed.
3. **Create the agents / harnesses** — one per client — and set each one's **routing** (which
   model/tier it uses, with optional fallbacks). Suggested set (matching the `.env` slots):
   `opencode`, `claude-code`, `copilot`, `openwebui`, `lan-anon`. Copy each agent's generated
   `mnfst_` key into the matching `MANIFEST_KEY_*` in `deploy/compose/.env`.
4. **Create the classifier's own agent.** The tier-classifier makes a tiny LLM call to classify
   each prompt; it needs a dedicated agent whose default tier points at a **small, fast local
   model** (e.g. `qwen2.5:3b`). Put its key in `MANIFEST_KEY_TIER_CLASSIFIER`. See
   [How routing works](#how-routing-works-the-tier-classifier).
5. **(Optional) Ollama-facade agent.** For anonymous/LAN callers hitting the native Ollama
   surface, mint `MANIFEST_KEY_OLLAMA_FACADE` (falls back to `MANIFEST_KEY_LAN_ANON` if empty).
6. **(Recommended) Claude Code harness with canonicalizer bypass** —
   [see below](#recommended-a-claude-code-harness-with-canonicalizer-bypass).

### 5. Restart with the keys, then verify

```bash
bun run corehub up            # picks up the new keys
bun run corehub doctor        # health of all hops + an end-to-end request
```

`doctor` must report every hop green.

---

## Configuration reference (`.env`)

All configuration lives in `deploy/compose/.env` (created by `corehub init` from
[`.env.example`](deploy/compose/.env.example)).

**Infra secrets** (generated by `corehub init`):

| Var | Purpose |
|---|---|
| `BETTER_AUTH_SECRET` | manifest dashboard session secret |
| `MANIFEST_ENCRYPTION_KEY` | manifest at-rest encryption of provider credentials |
| `POSTGRES_PASSWORD` | manifest database password |
| `WEBUI_SECRET_KEY` | Open WebUI session secret (profile `ui`) |

**Gateway & profiles:**

| Var | Default | Purpose |
|---|---|---|
| `GATEWAY_HOST_PORT` | `11434` | Host port for the gateway (emulates Ollama's default port). |
| `GATEWAY_TRUSTED_CIDRS` | *(empty)* | Host-side beyond loopback: HTTP ok + anonymous inject. Use `172.28.1.1/32` for Docker hairpin (`http://127.0.0.1:11434`). Add `172.28.1.0/24` for compose-internal HTTP. Do **not** put LAN CIDRs here. |
| `GATEWAY_TRUSTED_PROXIES` | *(empty)* | TLS proxies allowed to set `X-Forwarded-Proto: https`. Empty = trust the header from any external peer (only safe if `:11434` is not on the LAN). |
| `GATEWAY_CORS_ORIGINS` | *(empty)* | Allowed browser origins. |
| `MANIFEST_PUBLIC_URL` | `http://localhost:2099` | Origin the browser uses for the dashboard. |
| `COMPOSE_PROFILES` | `local-models` | Active profiles. Add `,ui` for Open WebUI. |

**Manifest agent keys** (minted in the dashboard, pasted here):

`MANIFEST_KEY_OPENCODE`, `MANIFEST_KEY_CLAUDE_CODE`, `MANIFEST_KEY_COPILOT`,
`MANIFEST_KEY_OPENWEBUI`, `MANIFEST_KEY_LAN_ANON`, `MANIFEST_KEY_TIER_CLASSIFIER`,
`MANIFEST_KEY_OLLAMA_FACADE`.

**tier-classifier tuning** (all optional; sane defaults baked into `docker-compose.yml`):

| Var | Default | Purpose |
|---|---|---|
| `CLASSIFIER_TIER` | `default` | Tier header the classifier's own sub-call requests. |
| `CLASSIFIER_TIMEOUT_MS` | `1500` | Timeout for the classification call before failing open (→ default tier). |
| `CLASSIFIER_COLD_LOAD_EXTRA_MS` | `15000` | If the first attempt times out (local model cold-load), retry once with this extra budget. |
| `CLASSIFIER_MAX_INPUT_CHARS` | `6000` | Truncate the message before classifying so it never overflows the classifier model's context window (a big prompt would otherwise make the model answer the content instead of classifying it). |
| `CLASSIFIER_CANONICALIZE` | `true` | Strip `temperature`/`top_p`/`top_k`/`thinking` from every request before forwarding (the manifest owns these per tier; a stray `temperature` breaks thinking-mode models). |
| `CLASSIFIER_CANONICALIZE_BYPASS` | `${MANIFEST_KEY_CLAUDE_CODE}` | Harness keys whose requests **skip** canonicalization. Comma-separate for more. See [below](#recommended-a-claude-code-harness-with-canonicalizer-bypass). |

---

## Connecting your tools

The gateway is at `http://<lan-ip>:11434` (or via your TLS proxy). Auth rules:

- **Host-side** (loopback + `GATEWAY_TRUSTED_CIDRS`): HTTP allowed; missing key → inject
  `GATEWAY_DEFAULT_KEY`. Docker hairpin makes `http://127.0.0.1:11434` from the host appear
  as `172.28.1.1` — put `172.28.1.1/32` in `GATEWAY_TRUSTED_CIDRS` to keep that working.
- **Outside the host**: must come as HTTPS via a TLS-terminating proxy that sets
  `X-Forwarded-Proto: https` (optional allow-list: `GATEWAY_TRUSTED_PROXIES`) **and** present a
  valid `mnfst_*` key (validated against Manifest). The stack does not terminate TLS itself.

Full, copy-pasteable per-tool setup — **opencode, Claude Code, GitHub Copilot Chat, Open WebUI,
generic Ollama clients** — is in **[`docs/connecting-tools.md`](docs/connecting-tools.md)**.

### Recommended: a Claude Code harness with canonicalizer bypass

Claude Code drives its model with its own sampling and extended-thinking parameters
(`thinking`, `temperature`, …) that it needs preserved to work correctly. The tier-classifier
**canonicalizes** requests by default — it strips `temperature`/`top_p`/`top_k`/`thinking`
before forwarding, because the manifest owns those params per tier and a stray `temperature`
breaks thinking-mode models (Anthropic returns `400 "temperature may only be set to 1 when
thinking is enabled"`). That protection is correct for tools like Copilot, but you do **not**
want it applied to Claude Code — stripping its params degrades it.

So give Claude Code its own harness and let its traffic bypass canonicalization:

1. In the dashboard (`:2099`), create a **harness/agent dedicated to Claude Code** (e.g.
   `claude-gateway`) and set its routing (e.g. default tier → your Opus/Sonnet subscription).
2. Copy its `mnfst_` key into **`MANIFEST_KEY_CLAUDE_CODE`** in `deploy/compose/.env`.
3. The bypass is **already wired**: `docker-compose.yml` defaults
   `CLASSIFIER_CANONICALIZE_BYPASS=${MANIFEST_KEY_CLAUDE_CODE}`, so any request carrying that key
   automatically skips canonicalization. (Matching is by **credential** — the tier-classifier
   never sees the harness name, only the key each request carries. Each harness = one key.)
4. Point Claude Code at the gateway with that key — see
   [`docs/connecting-tools.md` → Claude Code](docs/connecting-tools.md).
5. Restart: `bun run corehub up`.

To bypass **additional** harnesses, edit that compose line into a comma-separated list:
`CLASSIFIER_CANONICALIZE_BYPASS=${MANIFEST_KEY_CLAUDE_CODE},${MANIFEST_KEY_OTHER}`.

---

## How routing works (the tier-classifier)

For a request that arrives **without** an explicit `x-manifest-tier` header, the tier-classifier:

1. Extracts the last user message and **truncates** it to `CLASSIFIER_MAX_INPUT_CHARS`.
2. Makes one small LLM call (its own dedicated manifest agent, a fast local model) to classify
   the prompt as **`simple`**, **`complex`**, or **`reasoning`**, and sets `x-manifest-tier`
   accordingly. The manifest then maps that tier to whatever model you configured.
3. **Fails open** on any error/timeout/unrecognized label — it forwards without a tier header
   (the request falls into the agent's `default` tier) rather than blocking. Structured
   `tier-classifier.decision` / `tier-classifier.forward` log lines record the outcome
   (tier chosen, latency, and — on failure — the exact reason), and never log message content.
4. Separately, **canonicalizes** the request (strips sampling params — see
   [above](#recommended-a-claude-code-harness-with-canonicalizer-bypass)), unless the request's
   key is in `CLASSIFIER_CANONICALIZE_BYPASS`.

A request that already carries `x-manifest-tier` skips classification entirely. `fable` is never
chosen automatically — it's a manual, explicit model choice via the header.

---

## Local models (GPU)

The `local-models` profile runs a bundled **Ollama** container as a credential-free provider,
with the NVIDIA GPU reserved for it (needs the NVIDIA Container Toolkit on the host). Pull models
into it:

```bash
docker exec ia-stack-ollama-1 ollama pull qwen2.5:3b
docker exec ia-stack-ollama-1 ollama ps          # shows PROCESSOR (GPU/CPU split) + idle-unload timer
```

The stack sets `OLLAMA_KEEP_ALIVE=30m` so a model stays warm between messages instead of
cold-loading on every call. `qwen2.5:3b` is a good fit for the classifier on ~6 GB VRAM.

---

## Operating the stack

Run from the repo root (or set `COREHUB_ROOT`):

| Command | What it does |
|---|---|
| `bun run corehub init [--force]` | Generate `deploy/compose/.env` with fresh infra secrets. |
| `bun run corehub up [--profile ui] [--no-build]` | Build & start the stack. |
| `bun run corehub down [--volumes]` | Stop the stack (`--volumes` also deletes named volumes). |
| `bun run corehub status` | `docker compose ps` of the services. |
| `bun run corehub doctor` | Health of all hops + an end-to-end request. |
| `bun run corehub skills sync` | Symlink the shared `skills/` library into `~/.claude/skills` and `~/.agents/skills`. |

Under the hood the CLI wraps `docker compose -f deploy/compose/docker-compose.yml --env-file
deploy/compose/.env …`. For targeted operations (rebuild a single service, tail logs) you can
call `docker compose` directly with those flags, e.g.:

```bash
docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env \
  up -d --build tier-classifier
docker logs ia-stack-tier-classifier-1 -f
```

---

## Development

Monorepo managed with Bun workspaces. Our own services live in `packages/`:

- `packages/gateway` — the edge gateway (TypeScript / Bun / Hono).
- `packages/tier-classifier` — the prompt classifier + canonicalizer.
- `packages/cli` — the `corehub` CLI.

```bash
bun test packages/gateway/test              # or packages/tier-classifier/test
bun run typecheck
bun run lint
```

`skills/` is the canonical shared-skills library (agentskills.io format); `corehub skills sync`
links it into the agent skill paths without touching skills it didn't create.

---

## Security notes

- **`deploy/compose/.env` is git-ignored** and holds every secret (infra + `mnfst_` agent keys).
  It never enters the repo. Never `git add -f` it. When sharing the repo, recipients create their
  own `.env` from `.env.example`.
- **LAN auth:** **Host-side** (loopback + `GATEWAY_TRUSTED_CIDRS`) may use plain HTTP and omit
  a key (injected `GATEWAY_DEFAULT_KEY`). **Everyone else** must use HTTPS via a TLS proxy
  (`X-Forwarded-Proto: https`, optionally restricted by `GATEWAY_TRUSTED_PROXIES`) and a
  valid `mnfst_*` key. The gateway does not terminate TLS. Prefer
  `GATEWAY_TRUSTED_CIDRS=172.28.1.1/32` for host hairpin without opening the LAN; do not put
  LAN CIDRs in that list.
- Provider credentials live only inside the manifest (encrypted at rest with
  `MANIFEST_ENCRYPTION_KEY`); the gateway and classifier never hold them.

---

## License

[MIT](LICENSE) © 2026 Fábio Kenji Matsuda.

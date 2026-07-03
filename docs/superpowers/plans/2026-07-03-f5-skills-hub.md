# F5 — Skills Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate the canonical `skills/` library with real, load-bearing ia-stack knowledge and prove the F4 `corehub skills sync` mechanism makes it visible to all three target tools via symlink — the final F5 acceptance criterion.

**Architecture:** Two skills (agentskills.io format — `SKILL.md` with `name`/`description` frontmatter only, no Claude-specific fields) capture the operational and gateway-development knowledge accumulated across F1–F4. `corehub skills sync` (built in F4, already tested) is run for real against this machine's actual `~/.claude/skills` and `~/.agents/skills`, proving the symlink mechanism end-to-end without touching any of the ~55 pre-existing skills there.

**Tech Stack:** Markdown + YAML frontmatter (no code). Verification uses the already-built `corehub` CLI.

## Global Constraints

- Frontmatter is **spec-core only**: `name` and `description`. No Claude-specific fields (`context`, `hooks`, `version`, etc.) — spec §6: "Skills compartilhadas usam só campos core do spec... opencode ignora campos desconhecidos, Copilot também."
- Each skill is a single `SKILL.md` (no bundled scripts/resources needed for this content).
- `description` is single-line, written so a tool's skill-selection logic can match on it (states what it's for and when to use it) — matches the style of the pre-existing `bun` skill at `~/.claude/skills/bun/SKILL.md`.
- Content must be **factual, sourced from this project's own verified history** (F1–F4 commits/memory) — no invented or generic advice.
- `corehub skills sync` must never touch a pre-existing entry in `~/.claude/skills` or `~/.agents/skills` (F4 already enforces and tests this — this plan only *exercises* it for real, it does not re-implement it).
- Commit footer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

```
skills/
├── corehub-ops/
│   └── SKILL.md              # operate/troubleshoot the running stack via the corehub CLI
└── corehub-gateway-dev/
    └── SKILL.md               # develop packages/gateway (Bun+Hono, translators, TS/Biome gotchas)
```

---

### Task 1: `skills/corehub-ops/SKILL.md`

**Files:**
- Create: `skills/corehub-ops/SKILL.md`

**Interfaces:**
- Consumes: nothing (static content).
- Produces: a skill directory `corehub-ops` that `discoverSkills()` (`packages/cli/src/skills.ts`, already built in F4) will find because it contains a `SKILL.md`.

- [ ] **Step 1: Write the file**

```markdown
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
```

- [ ] **Step 2: Verify it's discoverable**

Run: `bun -e 'import { discoverSkills } from "./packages/cli/src/skills.ts"; console.log(discoverSkills("./skills"))'`
Expected: prints `[ "corehub-ops" ]` (only this skill exists so far — Task 2 adds the second).

- [ ] **Step 3: Commit**

```bash
git add skills/corehub-ops/SKILL.md
git commit -m "feat(f5): skill corehub-ops (operar/depurar o stack via corehub CLI)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `skills/corehub-gateway-dev/SKILL.md`

**Files:**
- Create: `skills/corehub-gateway-dev/SKILL.md`

**Interfaces:**
- Consumes: nothing (static content).
- Produces: a second skill directory `discoverSkills()` will find alongside `corehub-ops`.

- [ ] **Step 1: Write the file**

```markdown
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
```

- [ ] **Step 2: Verify both skills are discoverable**

Run: `bun -e 'import { discoverSkills } from "./packages/cli/src/skills.ts"; console.log(discoverSkills("./skills"))'`
Expected: prints `[ "corehub-gateway-dev", "corehub-ops" ]` (sorted).

- [ ] **Step 3: Confirm the whole workspace is still clean (Biome doesn't choke on the new Markdown)**

Run: `bun run lint`
Expected: no diagnostics for `skills/**`. If Biome flags formatting inside the new `SKILL.md` files, run `bun run lint:fix` and re-check — Biome's Markdown formatter is conservative and should not need any manual rewrite of the content above.

- [ ] **Step 4: Commit**

```bash
git add skills/corehub-gateway-dev/SKILL.md
git commit -m "feat(f5): skill corehub-gateway-dev (desenvolver packages/gateway)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Run `corehub skills sync` for real and verify cross-tool visibility

**Files:** none created/modified — this task exercises the F4 CLI (`packages/cli/src/commands/skills.ts`, `packages/cli/src/skills.ts`) against this machine's real `$HOME`.

**Interfaces:**
- Consumes: `TARGET_BASES` (`packages/cli/src/skills.ts`, F4) = `[~/.claude/skills, ~/.agents/skills]`; `discoverSkills(skillsDir)` from Tasks 1–2's output.

- [ ] **Step 1: Record the pre-sync baseline (so we can prove nothing pre-existing was touched)**

Run: `ls -1 ~/.claude/skills | wc -l && ls -1 ~/.agents/skills | wc -l`
Expected: `55` and `49` (this machine's known counts as of F4 — record whatever the actual numbers are here as your baseline if different).

- [ ] **Step 2: Run the real sync**

Run: `bun run corehub skills sync`
Expected: two report blocks (`~/.claude/skills`, `~/.agents/skills`), each showing:
```
  + corehub-gateway-dev                            PASS link criado
  + corehub-ops                                    PASS link criado
```
followed by `2 skill(s) sincronizada(s).`

- [ ] **Step 3: Verify the symlinks resolve into the repo**

Run: `readlink -f ~/.claude/skills/corehub-ops && readlink -f ~/.agents/skills/corehub-gateway-dev`
Expected: both resolve to the absolute paths of `skills/corehub-ops/SKILL.md`'s parent and `skills/corehub-gateway-dev/SKILL.md`'s parent inside this repo checkout.

- [ ] **Step 4: Verify the content is readable through the symlink (this is what makes it "visible" to a tool)**

Run: `head -3 ~/.claude/skills/corehub-ops/SKILL.md && head -3 ~/.agents/skills/corehub-gateway-dev/SKILL.md`
Expected: shows the `---\nname: corehub-ops\n...` / `---\nname: corehub-gateway-dev\n...` frontmatter — proving a tool reading `~/.claude/skills/<name>/SKILL.md` (Claude Code's native path) or `~/.agents/skills/<name>/SKILL.md` (the Copilot CLI/cloud-compatible mirror) sees the exact same file the repo tracks.

- [ ] **Step 5: Verify nothing pre-existing was touched (the F4 safety guarantee, exercised for real)**

Run: `ls -1 ~/.claude/skills | wc -l && ls -1 ~/.agents/skills | wc -l`
Expected: baseline-from-Step-1 **+ 2** in each (the two new skills only). Re-run `bun run corehub skills sync` once more — expected both entries report `= <name>  PASS já ok` (idempotent, no changes).

- [ ] **Step 6: Confirm the managed manifests are scoped to exactly what we synced**

Run: `cat ~/.claude/skills/.corehub-managed.json && cat ~/.agents/skills/.corehub-managed.json`
Expected: both show `{"version":1,"managed":["corehub-gateway-dev","corehub-ops"]}`.

No commit for this task — it mutates `$HOME`, not the repo. (If Step 1's baseline ever needs restating for a future machine, that's expected; the repo-tracked artifact is `skills/`, not the symlink targets.)

---

### Task 4: Docs — Skills section (README) + VS Code reinforcement (connecting-tools.md)

**Files:**
- Modify: `README.md`
- Modify: `docs/connecting-tools.md`

**Interfaces:**
- Consumes: Tasks 1–3 (references the two real skill names and the sync command).

- [ ] **Step 1: Update the README status line and quick start's closing pointer**

In `README.md`, replace:

```markdown
**Status:** F4 — `corehub` CLI (`init`/`up`/`down`/`status`/`doctor` + `skills sync`).
Gateway on `:11434` with OpenAI + Anthropic + Ollama surfaces; Open WebUI in the stack.
```

with:

```markdown
**Status:** F5 — skills hub populated (`skills/corehub-ops`, `skills/corehub-gateway-dev`),
synced via `corehub skills sync`. All phases (F1–F5) complete: gateway on `:11434` with
OpenAI + Anthropic + Ollama surfaces, Open WebUI in the stack, `corehub` CLI, shared skills.
```

And replace the closing paragraph:

```markdown
Later, `bun run corehub skills sync` links the shared skills library (populated in F5) into
`~/.claude/skills` and `~/.agents/skills`. See `docs/connecting-tools.md` for per-tool setup
(opencode / Claude Code / Copilot / Open WebUI / Ollama clients) and the full CLI reference.
```

with:

```markdown
`bun run corehub skills sync` links the shared skills library in `skills/` into
`~/.claude/skills` and `~/.agents/skills` (per-skill symlinks; never touches skills it
didn't create — see `skills/corehub-ops/SKILL.md`). See `docs/connecting-tools.md` for
per-tool setup (opencode / Claude Code / Copilot / Open WebUI / Ollama clients) and the
full CLI reference.
```

- [ ] **Step 2: Add a "Skills" section to `docs/connecting-tools.md`**

Append at the end of the file (after the existing "CLI `corehub`" section added in F4):

```markdown
## Skills compartilhadas

`skills/` no repo é a biblioteca canônica (formato [agentskills.io](https://agentskills.io/specification):
`SKILL.md` com frontmatter `name`/`description`). `corehub skills sync` cria um symlink por skill em:

- `~/.claude/skills/<nome>` — lido nativamente por Claude Code; opencode e o Copilot Chat (VS Code)
  também leem esse path como fallback de compatibilidade.
- `~/.agents/skills/<nome>` — espelho para o Copilot CLI / cloud agent, que não lê `~/.claude/skills`.

Cada base mantém seu próprio `.corehub-managed.json` com os nomes geridos pelo `corehub` — uma
skill que já existia ali antes (não criada pelo sync) nunca é tocada nem removida.

**VS Code (reforço opcional):** aponte `chat.agentSkillsLocations` nas configurações do usuário
para o diretório canônico do repo (`<repo>/skills`), reforçando a descoberta além dos symlinks:

```json
{
  "chat.agentSkillsLocations": ["/caminho/absoluto/para/ia-stack/skills"]
}
```

Skills disponíveis hoje: `corehub-ops` (operar/depurar o stack via CLI) e `corehub-gateway-dev`
(desenvolver `packages/gateway`).
```

- [ ] **Step 3: Verify the docs render sensibly and lint is clean**

Run: `bun run lint`
Expected: no diagnostics.
Run: `grep -c 'corehub skills sync' README.md docs/connecting-tools.md`
Expected: at least one match in each file.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/connecting-tools.md
git commit -m "docs(f5): status F5 completo; secao de skills compartilhadas + reforco VS Code

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Final validation and push

- [ ] **Step 1: Full workspace verification (unaffected by F5's content-only changes, confirm still green)**

Run: `bun run typecheck && bun run lint`
Expected: clean.
Run: `bun test packages/cli/test && bun test packages/gateway/test`
Expected: all pass (same counts as end of F4 — F5 adds no code).

- [ ] **Step 2: `corehub doctor` still green (F5 doesn't touch the running stack)**

Run: `bun run corehub doctor`
Expected: `corehub doctor: tudo verde ✓`.

- [ ] **Step 3: Re-confirm skills sync is idempotent after the docs commit**

Run: `bun run corehub skills sync`
Expected: both target bases report `= corehub-gateway-dev PASS já ok` and `= corehub-ops PASS já ok` — no drift.

- [ ] **Step 4: Confirm no secrets are tracked and the tree is clean**

Run: `git status --short && git ls-files | grep -E '\.env$|\.local$' || echo "nenhum segredo rastreado"`
Expected: clean tree; `nenhum segredo rastreado`.

- [ ] **Step 5: Push**

```bash
git push origin main
```
Expected: the F5 commits land on `origin/main`.

---

## Self-Review

**Spec coverage (§6 skills hub + §9 F5 = "skills populated + per-tool connection docs", acceptance "same skill visible in the 3 tools via symlink"):**
- Canonical `skills/` populated with real content → Tasks 1–2. ✓
- `corehub skills sync` per-skill symlinks into `~/.claude/skills` + `~/.agents/skills`, verified live → Task 3. ✓ (the F4-built mechanism already guarantees per-skill-not-whole-dir and foreign-safety; this plan proves it end-to-end rather than re-implementing it)
- Spec-core-only frontmatter (no Claude-specific fields) → Tasks 1–2 content. ✓
- VS Code `chat.agentSkillsLocations` reinforcement documented → Task 4. ✓
- Per-tool connection docs → already covered by F2/F3/F4's `docs/connecting-tools.md`; Task 4 adds the skills-specific piece that was still missing (how each of the 3 tools discovers a synced skill).
- "Mesma skill visível nas 3 ferramentas via symlink" acceptance → Task 3 Steps 3–4 read the same file through both symlink targets, and the skill's own content (Task 1) documents that opencode/Copilot use the same `~/.claude/skills` path as a compatibility fallback per the spec's D9 (already fact-checked at spec-approval time, cited bug numbers #25367/#14836/#18848 for why whole-dir symlinks are avoided — which this plan's per-skill approach, built in F4, already sidesteps).

**Placeholder scan:** every step has complete, real content (full `SKILL.md` text, exact commands, exact expected output). No TBD/TODO. ✓

**Type consistency:** N/A — no code in this plan; the two skill names (`corehub-ops`, `corehub-gateway-dev`) are used consistently across Tasks 1, 2, 3, and 4.

**Note on scope:** F5 deliberately does not add more skills beyond these two — YAGNI. The `skills/` directory and `corehub skills sync` mechanism (F4) both support adding more later without any further plan; a new skill is just a new `skills/<name>/SKILL.md` plus a re-run of `corehub skills sync`.

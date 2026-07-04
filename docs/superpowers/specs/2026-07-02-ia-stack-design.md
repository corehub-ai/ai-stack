# ia-stack — Design Spec

**Data:** 2026-07-02 · **Status:** aprovado em 2026-07-02 · **Autor:** fkmatsuda + Claude (brainstorming)

## 1. Objetivo

Compor três ferramentas open source — [headroom](https://github.com/headroomlabs-ai/headroom) (compressão de contexto), [manifest](https://github.com/mnfst/manifest) (LLM router) e [opencode](https://github.com/anomalyco/opencode) (agente de código) — num stack local exposto na LAN, com um **gateway próprio** que apresenta três superfícies de API (OpenAI, Anthropic e Ollama) para conectar qualquer ferramenta compatível. Complementos: Open WebUI como interface de chat, um **hub central de skills** compartilhado entre as ferramentas, e repositório GitHub com CI desde o início (possível open source futuro).

Ferramentas-alvo do usuário: **opencode, GitHub Copilot (VS Code), Claude Code**. Beneficiárias de graça: aider, n8n, JetBrains, Codex CLI etc. (não são alvo de teste).

## 2. Decisões e fatos verificados (2026-07-02, nível código-fonte)

| # | Decisão | Fato que a sustenta |
|---|---|---|
| D1 | Composição, não fork | Os 3 projetos lançam múltiplas releases/semana; protocolos OpenAI/Anthropic são o contrato estável |
| D2 | Ordem da cadeia: gateway → headroom → manifest → provedores | Compressão precisa ver o contexto bruto; roteamento decide melhor sobre payload enxuto |
| D3 | As duas pernas passam pelo headroom | `OPENAI_TARGET_API_URL` **e** `ANTHROPIC_TARGET_API_URL` existem (cli/proxy.py:743, providers/registry.py:106) |
| D4 | Chave `mnfst_` por ferramenta atravessa a cadeia | headroom repassa `Authorization`/`x-api-key` byte a byte ao upstream (handlers/anthropic.py:694, openai.py:1758) |
| D5 | Auth do hop gateway→headroom via `X-Headroom-Proxy-Token` | Header validado e removido antes do upstream; `Authorization` NÃO é removido (não usar para hop) |
| D6 | Façade Ollama é código próprio | manifest e headroom não têm ingress Ollama; nenhum projeto OSS maduro existe (melhores referências: oai2ollama, ollama_openai); LiteLLM não expõe Ollama inbound |
| D7 | Gateway na porta 11434 com 3 superfícies | O Ollama real (v0.31) serve `/api/*` + `/v1/*` (OpenAI) + `/v1/messages` (Anthropic) na mesma porta — é o shape que o ecossistema espera |
| D8 | Embeddings fora da cadeia (adiado) | manifest não tem `/v1/embeddings` (proxy.controller.ts tem só 4 rotas; nenhuma issue pede) |
| D9 | Skills hub via `~/.claude/skills` com symlinks por skill | Os 3 alvos leem esse path nativamente; symlink por skill é documentado no Claude Code; symlink do diretório inteiro é bugado (#25367, #14836) |
| D10 | Tiers do manifest = pseudo-modelos no gateway | Tier só é selecionável por header custom (`resolveRouting`, proxy.service.ts:460); tiers não aparecem em `/v1/models` |

## 3. Topologia

```
ferramentas na LAN (opencode, Copilot, Claude Code, Open WebUI, …)
   │   Ollama /api/* · OpenAI /v1/* · Anthropic /v1/messages
   ▼
gateway  0.0.0.0:11434       ← código próprio (Bun + Hono, TypeScript)
   │   X-Headroom-Proxy-Token + Authorization intacto
   ▼
headroom  :8787 interno       ← compressão de contexto
   │   {OPENAI,ANTHROPIC}_TARGET_API_URL = http://manifest:2099
   ▼
manifest  0.0.0.0:2099        ← roteamento, custo/limites (dashboard c/ Better Auth)
   │                             + postgres 16 interno
   ▼
provedores externos (APIs, assinaturas) · ollama real interno (profile opcional)
```

### Serviços do compose (`deploy/compose/docker-compose.yml`)

| Serviço | Imagem | Porta host | Exposição | Perfil |
|---|---|---|---|---|
| `gateway` | build local (`packages/gateway`) | `0.0.0.0:11434` | LAN | core |
| `headroom` | `ghcr.io/chopratejas/headroom:<pin>` | — (interna) | rede compose | core |
| `manifest` | `manifestdotbuild/manifest:<pin>` | `0.0.0.0:2099` | LAN (auth própria) | core |
| `postgres` | `postgres:16-alpine` | — (interna) | rede compose | core |
| `openwebui` | `ghcr.io/open-webui/open-webui:<pin>` | `0.0.0.0:3000` | LAN (auth própria) | ui |
| `ollama` | `ollama/ollama:<pin>` | — (interna) | rede compose | local-models |

- Imagens **pinadas por versão** (upstream muda semanalmente; upgrade = bump deliberado). Pins iniciais conhecidos: `headroom:0.28.0`, `manifest:6.12.0`, `postgres:16-alpine`; tags exatas de `openwebui`/`ollama` resolvidas na F1/F3.
- Memória do headroom (Qdrant/Neo4j) **fora do escopo** — não incluir esses serviços.
- Telemetria desligada por padrão: `MANIFEST_TELEMETRY_DISABLED=1`, `HEADROOM_TELEMETRY=off`.
- `BETTER_AUTH_URL=http://<host-lan>:2099` (precisa casar com a URL do navegador, senão o login falha com "Invalid origin").
- Perfil `local-models`: serviço `ollama` interno e `OLLAMA_HOST=http://ollama:11434` no manifest. **Nunca** apontar `OLLAMA_HOST` para `host.docker.internal:11434` com o gateway ativo (loop: manifest chamaria o próprio gateway). Sem o perfil, provider Ollama do manifest fica desconectado.
- Open WebUI conecta no gateway por **conexão tipo OpenAI** (`http://gateway:11434/v1` + chave `mnfst_openwebui`) — mais simples que a conexão Ollama para portar credencial. RAG interno do Open WebUI usa embeddings locais próprios (sentence-transformers embarcado), sem tocar na cadeia.

## 4. Gateway (`packages/gateway`) — a peça de código próprio

**Stack:** Bun + Hono (TypeScript). Streaming nativo, binário único possível (`bun build --compile`), testes com `bun test`, lint/format com Biome.

### 4.1 Superfícies

| Rota | Tratamento |
|---|---|
| `POST /v1/chat/completions`, `POST /v1/responses`, `GET /v1/models` | passthrough streaming → headroom (OpenAI leg) |
| `POST /v1/messages` | passthrough streaming → headroom (Anthropic leg) |
| `POST /v1/messages/count_tokens` | **respondida localmente** com estimativa conservadora (manifest não tem a rota — 404 na cadeia inteira; sem um 200 aqui o Claude Code degrada pra estimativa própria e trava sessões grandes). Ver `packages/gateway/src/token-estimate.ts` |
| `GET /` e `HEAD /` | `200 "Ollama is running"` |
| `GET /api/version` | versão fixa configurável (ex. `0.31.0`) |
| `GET /api/tags` | sintetizada: pseudo-modelos do config + (opcional, flag) modelos reais de `/v1/models` do manifest |
| `POST /api/show` | metadata estática por pseudo-modelo: `capabilities` (`completion`, `tools`, …), `model_info["<arch>.context_length"]` |
| `POST /api/chat` | **tradução** Ollama ⇄ OpenAI (ver 4.2) |
| `POST /api/generate` | wrapper sobre a mesma tradução (prompt único) |
| `POST /api/embed`, `/api/embeddings`, `/v1/embeddings` | `501` + mensagem clara (futuro: desvio configurável para upstream de embeddings) |
| `/api/pull|push|create|copy|delete|blobs|ps` | stubs (sucesso NDJSON `{"status":"success"}` / lista vazia / 404) |
| `GET /health` | agregado: gateway + `readyz` do headroom + `/api/v1/health` do manifest |

Atenção: o `/api/*` do gateway é **terminado no gateway** (superfície Ollama). Nunca encaminhar `/api/*` ao manifest — lá esse prefixo é a API interna do dashboard.

### 4.2 Tradução `/api/chat` (o núcleo do trabalho)

- **Formato de stream:** entrada SSE OpenAI (`data:` + deltas + `[DONE]`) → saída NDJSON (`application/x-ndjson`, um objeto JSON por linha, sem sentinela; terminador é `"done":true`).
- **Estatísticas finais:** durações em **nanossegundos** medidas pelo gateway; `prompt_eval_count`/`eval_count` extraídos do **chunk de usage que o manifest injeta** ao fim de todo stream (para a própria contabilidade — chega com `choices: []` e não pode quebrar o parser).
- **Tool calling:** OpenAI manda `arguments` como string fragmentada em deltas → acumular, parsear e emitir **um** objeto `tool_calls` com `arguments` como **objeto JSON**; resultado de tool no request usa `tool_name` (não `tool_call_id`) → mapear de volta.
- **`think`** (boolean ou `low|medium|high|max`) → `reasoning_effort`; mapeamento best-effort documentado.
- **`options`** (num_ctx, temperature, top_p, num_predict, stop…) → parâmetros OpenAI equivalentes; ignorar silenciosamente o que não tem equivalente (`keep_alive` etc.).
- **Erros:** antes do 1º chunk → HTTP 4xx/5xx `{"error": "..."}`; no meio do stream → linha `{"error": "..."}` (semântica Ollama). HTTP 424 do manifest (fallbacks esgotados) → erro claro com `X-Manifest-Fallback-Exhausted` logado.
- **Tolerâncias obrigatórias (quirks do manifest):** resposta pode vir SSE mesmo sem `stream:true` (tier com `response_mode: 'stream'` — detectar por `Content-Type`/`X-Manifest-Response-Mode`); falha mid-stream fecha a conexão sem retry.

### 4.3 Pseudo-modelos ⇄ tiers

Config estática do gateway mapeia nomes de modelo → destino:

```jsonc
// packages/gateway/gateway.config.jsonc (exemplo)
{
  "models": {
    "auto":         { "model": "auto" },                                      // tier default do manifest
    "corehub-fast": { "model": "auto", "headers": { "x-manifest-tier": "fast" } },
    "corehub-deep": { "model": "auto", "headers": { "x-manifest-tier": "deep" } }
  },
  "exposeProviderModels": false   // /api/tags limpo por padrão
}
```

Vale para as 3 superfícies: um cliente Ollama pede `corehub-fast`, um cliente OpenAI pede `model: "corehub-fast"` — o gateway reescreve para `auto` + header do tier. Nomes de tier são config manual (não são descobríveis via API do manifest).

### 4.4 Auth (LAN)

O manifest é a única fonte de verdade de credencial; o gateway não mantém contas.

1. Request **com** `Authorization`/`x-api-key` → passa intacto (manifest valida a chave `mnfst_`; inválida → 401 downstream).
2. Request **sem credencial** (clientes Ollama típicos) → permitido apenas de loopback ou de `GATEWAY_TRUSTED_CIDRS` (default: só a sub-rede do compose); o gateway injeta `GATEWAY_DEFAULT_KEY` (agente `lan-anon` no manifest). Fora disso → 401.
3. Hop interno: `HEADROOM_PROXY_TOKEN` compartilhado, enviado como `X-Headroom-Proxy-Token`; sub-rede do compose em `HEADROOM_PROXY_TRUSTED_GATEWAY_CIDRS` para honrar `X-Forwarded-*`.
4. CORS configurável (`GATEWAY_CORS_ORIGINS`; incluir `app://obsidian.md*`-style se necessário no futuro).
5. Sem TLS nesta fase (LAN doméstica); nota de futuro: reverse-proxy TLS (caddy) na frente do gateway.

### 4.5 Observabilidade

- Propagar headers `X-Manifest-*` (Tier/Model/Provider/Reason/Fallback-*) até o cliente nas superfícies OpenAI/Anthropic; logá-los na superfície Ollama (que não pode expressá-los).
- Log estruturado por request: modelo pedido → tier/modelo real, tokens, duração, origem.
- Custos: dashboard do manifest (por agente = por ferramenta); compressão: `GET /stats` do headroom.

## 5. Conexão das ferramentas

Cada ferramenta = um **agente no manifest** com chave própria → custo por ferramenta no dashboard.

| Ferramenta | Como conecta | Chave |
|---|---|---|
| opencode | provider `@ai-sdk/openai-compatible`, `baseURL: http://<host>:11434/v1`, models `auto`/`corehub-*` | `mnfst_opencode` via `{env:...}` |
| Claude Code | `ANTHROPIC_BASE_URL=http://<host>:11434` + `ANTHROPIC_AUTH_TOKEN=<chave>` (vira `Authorization: Bearer`) | `mnfst_claude-code` |
| Copilot (VS Code) | **F2:** BYOK "Custom Endpoint" (`http://<host>:11434/v1`, tipo Chat Completions ou Messages). **F3:** provider Ollama (funciona no Copilot Free sem conta GitHub; requer só `tags/show/version` + `/v1/chat/completions`) | `mnfst_copilot` |
| Open WebUI | conexão OpenAI `http://gateway:11434/v1` (rede interna) | `mnfst_openwebui` |

## 6. Skills hub

**Viabilidade confirmada.** Fato-pivô: os 3 alvos leem `~/.claude/skills` (pessoal) e `.claude/skills/` (projeto) — Claude Code nativamente; opencode e VS Code Copilot como paths de compatibilidade documentados. Padrão de formato: [agentskills.io](https://agentskills.io/specification) (SKILL.md + frontmatter `name`/`description`).

**Desenho:**
- Biblioteca canônica versionada: diretório `skills/` neste repositório (git = o "volume central"). Se algum serviço containerizado precisar no futuro, o mesmo diretório vira bind-mount.
- `corehub skills sync` (CLI, F4) cria **symlinks por skill**: `~/.claude/skills/<name>` → `<repo>/skills/<name>`, e espelho em `~/.agents/skills/<name>` (cobre Copilot CLI/cloud agent, que não leem `~/.claude/skills`).
- Nunca symlinkar o diretório inteiro (bugs conhecidos no Claude Code #25367/#14836; opencode #18848; Claude Code grava `.system/` dentro do dir).
- O sync mantém um manifest (`.corehub-managed.json`) dos links geridos — não toca skills pré-existentes do usuário (ex.: as ~dezenas já em `~/.claude/skills`).
- Skills compartilhadas usam **só campos core do spec** (frontmatter Claude-specific como `context: fork`/`hooks` não é portável; opencode ignora campos desconhecidos, Copilot também).
- VS Code: documentar `chat.agentSkillsLocations` apontando para o dir canônico como reforço.
- Referência/fallback avaliado: `npx skills` (vercel-labs/skills, 24k★) automatiza o mesmo padrão; nosso sync é ~50 linhas e evita a dependência, mas se crescer, migrar é trivial.

## 7. Repositório & CI/CD

```
ia-stack/
├── packages/gateway/          # Bun + Hono (F2/F3)
├── packages/cli/              # CLI `corehub` (F4)
├── deploy/compose/            # docker-compose.yml, .env.example, README de setup
├── skills/                    # biblioteca canônica de skills (F5)
├── docs/superpowers/specs/    # este spec
└── .github/workflows/
```

- **Monorepo Bun workspaces.** Node/Bun moderno, TypeScript estrito.
- **`ci.yml`** (push/PR): `bun install` → typecheck (`tsc --noEmit`) → Biome → `bun test` (unit + contract) → `docker compose config -q` → gitleaks (higiene para open source futuro).
- **`release.yml`** (tag): build multi-arch da imagem do gateway → `ghcr.io/<owner>/ia-stack-gateway`.
- **Licença: MIT** (proposta — alinha com opencode/manifest; headroom Apache-2.0 é só dependência de runtime, sem código copiado). Decisão final em questão aberta.
- Segredos só em `.env` (ignorado); `.env.example` versionado. Specs internos em pt-BR; README/docs públicos em inglês quando (se) abrir o código.

## 8. Testes

- **Unit:** tradutores (SSE→NDJSON, tool_calls string→objeto, options mapping) — puros, sem rede.
- **Contract (fixtures):** golden files de streams reais — OpenAI SSE (incl. chunk de usage com `choices:[]` do manifest, resposta 424, SSE forçado sem `stream:true`) e NDJSON Ollama esperado; schema da superfície Ollama validado contra o [OpenAPI publicado](https://docs.ollama.com/openapi.yaml).
- **E2E (checklist manual por fase):** cada ferramenta conectada, streaming visível, custo aparecendo no dashboard por agente, compressão no `/stats`, fallback disparando (derrubar provider primário).
- **`corehub doctor` (F4):** smoke-test permanente da cadeia (health dos 3 hops + request de ponta a ponta).

## 9. Fases

| Fase | Entrega | Critério de aceite |
|---|---|---|
| **F1** | Compose (headroom+manifest+postgres), opencode apontado direto no headroom | Chat streaming ok; custo/tier no dashboard; compressão no `/stats`; chave por ferramenta atravessando (D4); fallback ok |
| **F2** | Gateway v1: passthrough OpenAI+Anthropic+responses+models, auth LAN (4.4), `/health` | opencode, Claude Code e Copilot (BYOK Custom Endpoint) funcionando via `:11434` de outra máquina da LAN |
| **F3** | Façade Ollama em 3 fatias: (a) `tags/show/version` + `GET /` → Copilot modo Ollama; (b) `/api/chat` NDJSON+tools; (c) `generate`+stubs. Open WebUI entra no compose | Copilot Free conecta como "Ollama"; cliente Ollama genérico conversa com tools; Open WebUI operacional |
| **F4** | CLI `corehub`: `up/down/status/doctor/init` + `skills sync` | Setup de máquina nova em ≤3 comandos; doctor verde |
| **F5** | Skills hub populado + docs de conexão por ferramenta | Mesma skill visível nas 3 ferramentas via symlink |

## 10. Riscos & mitigações

| Risco | Mitigação |
|---|---|
| Loop porta 11434 (manifest → gateway como "Ollama") | Perfil `local-models` com serviço interno; `OLLAMA_HOST` nunca aponta para o host com gateway ativo (§3) |
| LAN sem TLS/auth fraca | Credencial obrigatória fora de CIDRs confiáveis (§4.4); dashboards com auth própria; TLS futuro via caddy |
| Upstream churn (releases semanais) | Imagens pinadas; contract tests pegam quebras ao subir versão; upgrade deliberado |
| Quirks SSE do manifest | Tolerâncias explícitas no tradutor (§4.2) + fixtures dedicadas (§8) |
| Copilot CLI/cloud não lê `~/.claude/skills` | Espelho em `~/.agents/skills` no `skills sync` (§6) |
| Cache de prompt vs compressão (headroom #327) | Medir com `/stats` + holdout do headroom; sticky session `x-session-key` se necessário; aceitar trade-off documentado |

## 11. Fora de escopo (por ora)

Embeddings/RAG na cadeia (D8 — gateway responde 501); memória do headroom (Qdrant/Neo4j); multi-usuário com quotas individuais; TLS; JetBrains/aider/n8n como alvos de teste; contribuir ingress Ollama upstream no manifest (fica como possibilidade futura).

## 12. Decisões finais (2026-07-02)

1. **Repo GitHub**: `ia-stack`, **privado** até decisão de open source. Pendência operacional: criar o remote exige ação interativa do usuário (`gh auth login` após instalar o gh, ou criação manual do repo + URL do remote) — tarefa da F1.
2. **Licença**: **MIT** (LICENSE no repo).
3. **Nome do binário CLI**: **`corehub`**.

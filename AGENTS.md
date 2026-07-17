# AGENTS.md — ia-stack

Guia para agentes de código trabalhando neste repositório. Assume zero conhecimento prévio do projeto.

## Visão geral

**ia-stack** é uma stack self-hosted de gateway de IA. Um gateway de borda customizado expõe superfícies
compatíveis com **OpenAI, Anthropic e Ollama** na porta `:11434`, na frente de dois proxies de terceiros —
**headroom** (compressão de contexto) e **manifest** (roteamento de LLM, controle de custo, dashboard) —
mais um **classificador de complexidade de prompt** próprio que marca cada request com uma tier de
roteamento (`x-manifest-tier`).

Ferramentas como opencode, Claude Code, GitHub Copilot, Open WebUI e clientes Ollama apontam para um
único endpoint; a stack roteia cada request para o modelo certo (Ollama local, assinatura Anthropic,
etc.) conforme regras configuradas no dashboard do manifest. Credenciais de provedores vivem **somente**
no manifest — gateway e tier-classifier nunca seguram chave de provedor.

Monorepo gerenciado com **Bun workspaces**. Licença MIT.

## Arquitetura da cadeia de request

```
cliente → gateway :11434  (edge LAN: auth + tradução de protocolo)   [este repo: packages/gateway]
        → headroom :8787  (compressão de contexto, só rede interna)  [imagem 3rd-party]
        → tier-classifier :8788 (classifica prompt → x-manifest-tier,
                                 canoniza params de sampling)        [este repo: packages/tier-classifier]
        → manifest :2099  (router + custo + dashboard; dono das
                           credenciais de provedor) + postgres       [imagens 3rd-party]
        → provedores reais: Ollama local (GPU), Anthropic, OpenCode, …
```

As três superfícies do gateway:

- **OpenAI**: `/v1/chat/completions`, `/v1/responses`, `/v1/models`
- **Anthropic**: `/v1/messages`
- **Ollama nativa**: `/api/chat`, `/api/generate`, `/api/tags`, … — **terminada no gateway** (nunca
  repassada ao manifest, onde `/api/*` é a API interna do dashboard) e traduzida para OpenAI; só
  `/api/chat` e `/api/generate` chamam downstream (a perna OpenAI do headroom). Discovery
  (`GET /`, `/api/version`, `/api/tags`, `/api/show`) não tem auth, igual ao Ollama real.

O tier-classifier **falha aberto** (fail-open): qualquer erro/timeout na classificação faz a request
seguir sem header de tier (cai na tier `default` do agente no manifest). Ele também **canoniza** as
requests removendo `temperature`/`top_p`/`top_k`/`thinking` antes do forward (o manifest é dono desses
params por tier; um `temperature` perdido quebra modelos com thinking mode — erro 400 da Anthropic).
O bypass da canonização é **por credencial** (`CLASSIFIER_CANONICALIZE_BYPASS`), não por nome de
harness — o classifier só enxerga a chave `mnfst_` da request.

## Stack técnica

- **Runtime:** Bun ≥ 1.3 (pin de 1.3.14 no CI e nos Dockerfiles `oven/bun:1.3.14-alpine`). Não é Node.
- **Linguagem:** TypeScript strict — `noUncheckedIndexedAccess` e `exactOptionalPropertyTypes` ligados.
- **HTTP:** Hono 4.12.27 (única dependência de runtime dos serviços próprios).
- **Lint/format:** Biome 2.5.2 (`biome.json` na raiz).
- **Testes:** `bun:test` (runner nativo do Bun).
- **Deploy:** Docker Compose v2 (`docker compose`, não o legado `docker-compose`), rede fixa
  `172.28.1.0/24` em `deploy/compose/docker-compose.yml`.
- **TypeScript:** 6.0.3, build mode (`tsc --build`) com project references.

## Estrutura do repositório

```
packages/
  gateway/           edge gateway (Bun+Hono): auth LAN, tradução Ollama⇄OpenAI
    src/
      index.ts       buildApp(config, logger, opts) + Bun.serve (idleTimeout 255 — ver comentário)
      auth.ts        middleware host-side vs externo (HTTPS + chave)
      cidr.ts        matching de CIDR (normalizeIp lida com IPv4-mapped IPv6)
      proxy-headers.ts  ÚNICO lugar que decide quais headers vão pro headroom
      manifest-key.ts   validação de chave mnfst_ contra o manifest
      request-log.ts    log de request (antes do auth, pra logar também 401)
      routes/        openai.ts, anthropic.ts, ollama.ts, health.ts
      ollama/        tradutores: translate-request.ts, translate-chat.ts, sse.ts, models.ts, types.ts
    test/            testes bun:test + fixtures/ (bytes SSE/NDJSON capturados) + support/
  tier-classifier/   classificador de tier + canonizador (Bun+Hono)
    src/             index.ts (proxy + decisão), classify.ts, canonicalize.ts,
                     message-extract.ts, request-info.ts, config.ts
    test/
  cli/               CLI `corehub` (init/up/down/status/doctor/skills)
    src/             index.ts, cli.ts, compose.ts, env.ts, paths.ts, skills.ts, ui.ts,
                     doctor.ts, commands/{init,stack,doctor,skills}.ts
    test/
deploy/compose/
  docker-compose.yml definição dos serviços + volumes nomeados ia-stack_*
  .env.example       template versionado de configuração (comentado)
  .env               segredos reais — GIT-IGNORADO, nunca commitar
  .admin.local       senha bootstrap do manifest — git-ignorado via *.local
  scripts/           validate-{chain,gateway,ollama}.sh — validadores bash manuais (curl+jq)
docs/
  connecting-tools.md  guia pt-BR de conexão por ferramenta (opencode, Claude Code, Copilot, …)
  superpowers/specs/   specs de design pt-BR datadas (2026-07-02 … 2026-07-05)
  superpowers/plans/
skills/              biblioteca canônica de skills (formato agentskills.io), sincronizada
                     para ~/.claude/skills e ~/.agents/skills via `corehub skills sync`:
                     corehub-gateway-dev (convenções de dev do gateway) e corehub-ops (operação)
dev-reports/         relatórios pt-BR datados de trabalhos anteriores
.superpowers/sdd/    artefatos de spec-driven-development (briefs, reports, diffs de revisão)
.github/workflows/ci.yml
opencode.json        config do opencode já apontada pro gateway (dogfooding)
```

## Comandos de build, lint e teste

Rodar da raiz do repo:

```bash
bun install                          # instala deps do workspace
bun run typecheck                    # tsc --build (RAIZ, nunca por pacote)
bun run lint                         # biome check .
bun run lint:fix                     # biome check --write . (autofix)
bun test packages/gateway/test       # testes do gateway
bun test packages/tier-classifier/test
bun test packages/cli/test
bun run --cwd packages/gateway dev   # dev server em watch mode (idem tier-classifier)
```

Armadilhas conhecidas (verificadas, não supor o contrário):

- **Nunca** `bun test packages/gateway` (diretório nu, sem `/test`): depois de qualquer
  `tsc --build`, testes `.js` compilados vazam para `packages/gateway/dist/` e são executados também —
  e falham porque as fixtures não são copiadas pra lá. Sempre aponte para o subdiretório `test/`.
- O `tsconfig.json` da raiz é orquestrador puro: `"files": []` + `"references"` — **não** adicionar
  `composite` nem `bun-types` nele (quebra `tsc --build` com TS6304/TS2688). Cada pacote tem seu
  próprio tsconfig que estende o da raiz com `"composite": true` e `"types": ["bun-types"]`.
  Pacote novo = adicionar em `references` da raiz, senão `tsc --build` o pula silenciosamente.
- Biome 2.5.2: `organizeImports` fica em `assist.actions.source.organizeImports`; o preset de lint é
  `linter.rules.preset = "recommended"` (não `linter.rules.recommended`). Fixtures de teste brutas
  estão excluídas via `"files": {"includes": ["**", "!**/test/fixtures"]}` — manter essa exclusão.
- Dockerfile de cada serviço copia o `package.json` de **todos** os membros do workspace antes do
  `bun install --frozen-lockfile` — sem isso o lockfile falha com "lockfile had changes". Ao criar
  pacote novo, atualizar os Dockerfiles.

## CLI `corehub` (operação da stack)

`bun run corehub <cmd>` (equivale a `bun run packages/cli/src/index.ts`; existe também
`bun run --cwd packages/cli build` que compila um binário standalone):

| Comando | O que faz |
|---|---|
| `init [--force]` | Gera `deploy/compose/.env` a partir do `.env.example` com segredos de infra frescos (`openssl rand -hex 32`). Não sobrescreve sem `--force`; nunca toca nas `MANIFEST_KEY_*`. |
| `up [--profile ui] [--no-build]` | `docker compose up -d --build` |
| `down [--volumes]` | `docker compose down` (`--volumes` apaga os volumes nomeados) |
| `status` | `docker compose ps` |
| `doctor` | Health de todos os hops + uma request end-to-end — deve sair tudo verde |
| `skills sync` | Symlinks por skill de `skills/` para `~/.claude/skills` e `~/.agents/skills`, sem tocar em skills que não criou |

Por baixo o CLI embrulha `docker compose -f deploy/compose/docker-compose.yml --env-file
deploy/compose/.env …`. Máquina nova: `bun install` → `corehub init` → `corehub up` → configurar o
dashboard em `:2099` (criar agentes, colar as chaves `mnfst_` no `.env`) → `corehub up` → `corehub doctor`.

## Convenções de código

- **Módulos:** ESM (`"type": "module"`); imports relativos usam extensão `.js`
  (ex.: `import { loadConfig } from "./config.js"`).
- **Estilo:** Biome — indentação 2 espaços, largura 100, organize-imports automático. Sem
  dependências novas sem necessidade: os serviços usam quase só APIs nativas do Bun/Web (`Bun.serve`,
  `fetch`, `ReadableStream`) + Hono.
- **`exactOptionalPropertyTypes: true`:** não dá pra atribuir `x: undefined` em objeto tipado
  `x?: T`. Padrão usado no código (ver `applyStats` em `translate-chat.ts`): montar o objeto base
  primeiro e atribuir campos opcionais condicionalmente, só quando há valor real.
- **Config por env:** cada serviço tem um `config.ts` com `loadConfig(env = process.env)` puro e
  testável, retornando um tipo `*Config` explícito.
- **Injeção pra teste:** `buildApp` dos dois serviços aceita stubs (ex.: `validateKey` no gateway,
  `logger` no classifier) — rotas são registradas por funções `register*Routes(app, config)`.
- **Headers de proxy:** `packages/gateway/src/proxy-headers.ts` é o único lugar que decide quais
  headers chegam ao headroom — ele remove `host`/`authorization`/`x-api-key` dos headers copiados do
  cliente antes de re-adicionar a credencial (default injetada ou a do próprio cliente). Handlers de
  rota **devem** passar por esse helper, nunca espalhar `c.req.header()` direto — senão um header
  do cliente pode sombrear a credencial injetada.
- **Observabilidade content-free:** logs estruturados (JSON) registram tier, latência, status,
  tamanhos e motivos de falha — **nunca** conteúdo de mensagem nem valores de chave.
- **`idleTimeout: 255`** no `Bun.serve` dos dois serviços: o default (10s) corta streams de LLM no
  meio (time-to-first-token longo + compressão). Não usar 0 (slowloris). Há comentário no código.
- **Comentários "achado <data>":** o código documenta decisões com a data do achado e referência à
  spec (ex.: `spec 2026-07-05-ollama-facade-harness`). Manter esse padrão ao mexer em comportamento
  verificado em produção.

## Testes

- Runner nativo do Bun (`import { describe, expect, it } from "bun:test"`). Sem framework extra.
- Testes rodam **em processo**: `app.request(path, init, { ip: "127.0.0.1" })` contra a Hono app
  construída com config/stubs de teste — não sobem porta real (exceto mocks upstream).
- Upstreams falsos: `packages/gateway/test/support/mock-upstream.ts` sobe um `Bun.serve` em porta 0
  servindo **fixtures capturadas de tráfego real** (`test/fixtures/*.headers.txt` + `*.body.json|txt`,
  e `.sse` para streams). Ao mudar tradutores, capture/atualize a fixture correspondente.
- Stubs compartilhados em `test/support/` (ex.: `key-validator.ts` com `testAuthOpts`).
- A tradução Ollama tem fatos verificados contra um Ollama 0.31.1 real cobertos por teste: SSE
  OpenAI → NDJSON Ollama terminado em `"done":true`; `tool_calls[].function.arguments` é **string**
  fragmentada no stream OpenAI mas **objeto** no wire Ollama (acumular por índice, `JSON.parse` no
  fim); durações no chunk final são **nanossegundos**; `/api/tags` precisa de `digest` não-vazio e
  `size` não-zero senão o CLI `ollama` real entra em pânico.
- **CI** (`.github/workflows/ci.yml`, em push na `main` e PRs): valida o compose com env dummy,
  roda `bun install --frozen-lockfile`, `typecheck`, `lint` e os três diretórios de teste, mais
  **gitleaks**. Reproduza localmente com os comandos da seção anterior antes de abrir PR.

## Configuração e segredos

- Toda configuração vive em `deploy/compose/.env` (git-ignorado), criado por `corehub init` a partir
  de `deploy/compose/.env.example` (versionado e comentado — atualize o `.example` ao adicionar var).
- **Segredos de infra** (gerados pelo init): `BETTER_AUTH_SECRET`, `MANIFEST_ENCRYPTION_KEY`,
  `POSTGRES_PASSWORD`, `WEBUI_SECRET_KEY`.
- **Chaves de agente** `MANIFEST_KEY_*` (`mnfst_…`): cunhadas no dashboard do manifest (`:2099`), uma
  por ferramenta/harness, coladas no `.env`. Nunca imprimir, logar ou commitar uma chave `mnfst_`.
- `deploy/compose/.admin.local` (senha bootstrap do admin do manifest) também é git-ignorado (`*.local`).
- O compose define defaults sãos para o tuning do classifier (`CLASSIFIER_*`); o `.env` só sobrescreve.
- Profiles do compose: `local-models` (Ollama interno com GPU NVIDIA, default) e `ui` (Open WebUI em
  `:3000`). Portas publicadas no host: gateway `11434` (`GATEWAY_HOST_PORT`), manifest `2099`,
  Open WebUI `3000`. Headroom/tier-classifier/postgres/ollama são só rede interna.

## Segurança

- **Modelo de auth do gateway** (`src/auth.ts`): host-side (loopback + `GATEWAY_TRUSTED_CIDRS`) pode
  HTTP puro e request sem chave (injeta `GATEWAY_DEFAULT_KEY`; a façade Ollama usa
  `GATEWAY_OLLAMA_DEFAULT_KEY` com fallback). **Fora do host**: exige HTTPS via proxy terminador de
  TLS que seta `X-Forwarded-Proto: https` (allow-list opcional `GATEWAY_TRUSTED_PROXIES`) **e** uma
  chave `mnfst_*` válida (validada contra o manifest). O gateway **não** termina TLS.
- **Não** colocar CIDRs de LAN (192.168.x) em `GATEWAY_TRUSTED_CIDRS`, e nunca defaultar para a
  subnet da bridge do compose: o `docker-proxy` (userland) faz hairpin do tráfego host→loopback pelo
  IP da bridge, tornando a subnet indistinguível de tráfego genuíno de container — defaultar para
  ela é bypass de auth. Valor recomendado documentado: `172.28.1.1/32`.
- Credenciais de provedor vivem só no manifest (cifradas em repouso com `MANIFEST_ENCRYPTION_KEY`).
- `.env` e `*.local` nunca entram no repo; gitleaks roda no CI. Não usar `git add -f` nesses arquivos.
- O serviço `manifest` no compose roda com `read_only`, `no-new-privileges` e `cap_drop: [ALL]` —
  manter essa postura ao adicionar serviços.

## Documentação de referência

- `README.md` (inglês) — visão geral, setup detalhado, referência completa do `.env`, routing.
- `docs/connecting-tools.md` (pt-BR) — setup copy-pasteável por ferramenta cliente.
- `docs/superpowers/specs/` (pt-BR) — specs de design datadas; referência canônica das decisões
  (ex.: `2026-07-04-tier-classifier-design.md`, `2026-07-05-ollama-facade-harness-design.md`).
- `skills/corehub-gateway-dev/SKILL.md` e `skills/corehub-ops/SKILL.md` (inglês) — conhecimento de
  trabalho condensado: armadilhas do monorepo/Biome, fatos da tradução Ollama, modos de falha
  operacionais comuns. Consulte antes de mexer no gateway ou operar a stack.

## Idioma do projeto

Comentários de código, mensagens do CLI, docs em `docs/` (exceto o README), specs e dev-reports são
em **português (pt-BR)** — mantenha esse idioma em comentários e docs novos. README.md e as skills
de `skills/` são em inglês por convenção externa. Mensagens de commit e identadores seguem o código
existente.

# `tier-classifier` — Design Spec

**Data:** 2026-07-04 · **Status:** aprovado em 2026-07-04 · **Autor:** fkmatsuda + Claude (brainstorming)

## 1. Objetivo

Adicionar um roteamento automático por complexidade de prompt à stack, escolhendo entre as tiers já
configuradas no manifest para o agente `claude-gateway` (hoje: `Simple`→sonnet-4-6, `Complex`/`Reasoning`→
opus-4-8, `Fable`→fable-5), sem depender do mecanismo nativo de "rule-based routing" do próprio manifest.

Novo serviço `tier-classifier` (pacote `packages/tier-classifier`, TypeScript/Bun/Hono), inserido entre
`headroom` e `manifest`: se a request não trouxer um `x-manifest-tier` explícito, classifica-a com um LLM
e seta o header antes de repassar; se já trouxer, repassa sem tocar.

## 2. Decisões e fatos verificados (2026-07-04)

| # | Decisão | Fato que a sustenta |
|---|---|---|
| D1 | O roteamento por complexidade nativo do manifest **não foi usado** para este objetivo | Investigado (diff binário manifest 6.12.0 vs 6.13.3, schema do Postgres, endpoints REST ao vivo): a feature existe e funciona (`agents.complexity_routing_enabled`, motor de scoring intacto), mas o próprio fabricante está **deprecando** esse modo — UI mostra "We're deprecating rule-based routing... until September 1, 2026, we recommend migrating to default or custom routing." Construir em cima dele compraria ~2 meses. |
| D2 | Descartadas as alternativas: usar Hermes Agent / OpenClaw prontos, abandonar o Headroom, ou reescrever gateway+headroom+manifest do zero | Hermes/OpenClaw são plataformas de assistente pessoal de propósito geral (mensageria, cron, sandboxing) — desproporcional para classificar uma request no caminho quente. Substituir Headroom ou reescrever a stack inteira foi avaliado e adiado nesta sessão de brainstorming: a stack (F1-F5) tinha acabado de ser entregue e está funcionando; escopo escolhido foi o incremental. |
| D3 | `tier-classifier` fica entre `headroom` e `manifest`, não entre `gateway` e `headroom` | `headroom` já lê `OPENAI_TARGET_API_URL`/`ANTHROPIC_TARGET_API_URL` do ambiente (`docker-compose.yml:130-135`), apontando hoje pro manifest — repontar essas duas env vars pro `tier-classifier` não exige nenhuma mudança de código em headroom nem manifest. Ficar logo antes do manifest também elimina o risco de o header `x-manifest-tier` ser descartado por um hop intermediário de terceiros cujo comportamento de repasse de headers customizados não é garantido. |
| D4 | `tier-classifier` só precisa lidar com 2 formatos de request (OpenAI-shape, Anthropic-shape) | As 3 superfícies do gateway (`/v1/chat/completions`, `/v1/messages`, e Ollama traduzido pra OpenAI em `ollama.ts`) convergem todas no mesmo `headroomUrl` antes do manifest (`packages/gateway/src/routes/*.ts`) — Ollama já chega normalizado. |
| D5 | Se a request já tem `x-manifest-tier`, `tier-classifier` repassa sem chamar LLM nenhum | Respeita o roteamento explícito/"Custom routing" que já existe e funciona hoje; adiciona zero latência para quem já sabe que tier quer. |
| D6 | A chamada de classificação em si usa um agente **novo e dedicado** no manifest (`tier-classifier`), configurado via dashboard — não um client multi-provider dentro do serviço | O manifest já resolve "provider + modelo por tier" pra qualquer agente. Reaproveitar isso elimina a necessidade de uma UI de config própria e de `CLASSIFIER_PROVIDER`/`CLASSIFIER_BASE_URL`/`CLASSIFIER_MODEL`: sobra só a chave do agente e o nome da tier a pedir. Trocar o modelo do classificador vira uma mudança só no dashboard, sem redeploy. Bônus: o dashboard de custo do manifest separa naturalmente o gasto de classificação do gasto real. |
| D7 | A chamada de classificação vai **direto** ao manifest, nunca pelo headroom | Como o `HEADROOM_URL`-alvo do headroom passa a ser o próprio `tier-classifier` (D3), uma chamada de classificação que passasse pelo headroom faria o serviço chamar a si mesmo em loop. |
| D8 | Modelo default do agente `tier-classifier`: Ollama local (`codellama:latest`, já auto-pulled desde o commit `e8dc36b`) | Classificação roda em toda request sem tier explícito — precisa ser rápida e sem custo marginal. Trocável depois via dashboard se a qualidade não for suficiente. |

## 3. Arquitetura e fluxo

```
Client → gateway (:11434) → headroom (:8787, compressão) → tier-classifier (novo) → manifest (:2099) → provider real
                                                                    │
                                                                    │ (só se a request NÃO tiver x-manifest-tier)
                                                                    ▼
                                                    manifest (:2099, agente "tier-classifier" dedicado)
                                                                    │
                                                                    ▼
                                                              Ollama local (default)
```

1. `tier-classifier` recebe a request do headroom (shape OpenAI ou Anthropic, mesmo path que hoje vai pro manifest).
2. Se o header `x-manifest-tier` já vier preenchido → repassa pro manifest real sem tocar em mais nada (D5).
3. Se não vier:
   a. Extrai a última mensagem do usuário do corpo (shape-aware: OpenAI `messages[]`/Anthropic `messages[]`+`system`).
   b. Monta um prompt de classificação curto (label fechado: `simple`/`complex`/`reasoning`/`fable` ou subconjunto — ver §5).
   c. Chama `POST {MANIFEST_URL}/v1/messages` (ou `/v1/chat/completions`) com a chave do agente `tier-classifier`
      e header `x-manifest-tier: {CLASSIFIER_TIER}`, timeout curto (`CLASSIFIER_TIMEOUT_MS`).
   d. Sucesso → mapeia o label devolvido pro valor de tier que o agente-alvo (`claude-gateway`) realmente espera
      (§5) e seta `x-manifest-tier` nessa request antes de repassar.
   e. Erro ou timeout → repassa **sem** header nenhum (fail-open pro "Default routing: regular" que o manifest
      já faz hoje) — nunca bloqueia a request real.
4. Todo o resto (streaming, demais headers, corpo) passa transparente, igual ao proxy que o headroom já faz hoje.

## 4. Config (env vars do serviço `tier-classifier`)

| Var | Uso |
|---|---|
| `MANIFEST_URL` | Alvo de repasse real (ex.: `http://manifest:2099`) — mesmo padrão de `headroomUrl`/`manifestUrl` já usado em `packages/gateway/src/config.ts`. |
| `CLASSIFIER_MANIFEST_KEY` | Chave do agente dedicado `tier-classifier` no manifest (padrão `MANIFEST_KEY_*` já usado em `deploy/compose/.env`). |
| `CLASSIFIER_TIER` | Valor de `x-manifest-tier` a usar na chamada de classificação (esse agente só precisa de uma tier — não precisa de custom routing multi-opção). |
| `CLASSIFIER_TIMEOUT_MS` | Timeout da chamada de classificação antes do fail-open (default sugerido: 800ms). |

Docker compose: novo serviço `tier-classifier` (Dockerfile no molde do `packages/gateway/Dockerfile`);
`headroom.environment.OPENAI_TARGET_API_URL` e `.ANTHROPIC_TARGET_API_URL` passam de `http://manifest:2099`
para `http://tier-classifier:<porta>`.

**Pré-requisito operacional:** criar o agente `tier-classifier` no dashboard do manifest (mesmo processo
hoje pendente para o `opencode` — ver memória `pending-opencode-key`) e configurar sua tier default
apontando pro Ollama local.

## 5. Lógica de classificação

- Prompt de sistema pede um único label de um conjunto fechado de dois valores: `simple` ou `complex`.
  `reasoning` fica fora da decisão automática porque hoje aponta pro mesmo modelo que `complex`
  (opus-4-8) — nenhum ganho em distingui-los automaticamente enquanto isso não mudar no dashboard.
  `fable` também fica fora: é uma escolha explícita de modelo, não um nível de complexidade, e só chega
  via `x-manifest-tier` manual (D5 já cobre esse caso — nunca é sobrescrito).
- O label devolvido pelo LLM é mapeado (tabela/config, não acoplado 1:1) pro valor de header que o
  `header_tiers` do agente-alvo (`claude-gateway`) realmente espera hoje — evita que uma mudança de nome
  no dashboard do manifest quebre o classificador.
- Nunca loga conteúdo de mensagem do usuário — só metadata (tier escolhido, latência, se caiu em
  fail-open), seguindo a mesma regra de privacidade já aplicada nas investigações desta sessão.

## 6. Testes

TDD no molde de `packages/gateway/test/count-tokens.test.ts`: client de classificação injetável/mockável.
Casos: passthrough quando a request já tem `x-manifest-tier` (nenhuma chamada ao mock de classificação é
feita); timeout/erro do classificador → fail-open (request segue sem header, nenhum bloqueio); extração de
mensagem nos dois shapes (OpenAI/Anthropic); mapeamento label→valor de header; nunca chama `HEADROOM_URL`
(só `MANIFEST_URL`) para a sub-chamada de classificação, provando a ausência do loop (D7).

## 7. Riscos & mitigações

| Risco | Mitigação |
|---|---|
| Novo componente no caminho quente de toda inferência pode virar ponto de falha | Timeout curto + fail-open (D5/§3.3e) — nunca bloqueia a request real, mesmo se o agente/chave do classificador estiver mal configurado (mesma falha já vista com `MANIFEST_KEY_OPENCODE`, ver `pending-opencode-key`) |
| Loop acidental `headroom → tier-classifier → headroom` | Chamada de classificação vai direto a `MANIFEST_URL`, nunca a `HEADROOM_URL` (D7) — coberto por teste dedicado |
| Custo/latência de classificar toda request sem tier explícito | Default local via Ollama (grátis, sem rede externa); trocável no dashboard do manifest sem redeploy se a qualidade não bastar |
| Manifest descontinuar `rule-based routing` (sunset 2026-09-01) | Este design não depende dessa feature — nada muda quando ela for removida |

## 8. Fora de escopo

- Reativar ou usar o `complexity_routing_enabled`/`tier_assignments`/`specificity_assignments` nativos do
  manifest — estão sendo deprecados pelo fabricante.
- Client multi-provider dentro do `tier-classifier` (D6) — o manifest já resolve isso.
- UI de configuração própria — reaproveita o dashboard do manifest.
- Usar Hermes Agent, OpenClaw, substituir o Headroom, ou reescrever gateway+headroom+manifest — avaliadas
  e descartadas nesta sessão de brainstorming (D2).

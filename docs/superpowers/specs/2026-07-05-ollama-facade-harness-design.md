# Harness dedicado para a superfície Ollama do gateway — Design Spec

## 1. Objetivo

Hoje, qualquer chamada anônima (sem `Authorization`/`x-api-key`, vinda de loopback ou de
`GATEWAY_TRUSTED_CIDRS`) chega no manifest com a mesma identidade —
`MANIFEST_KEY_LAN_ANON` — não importa se veio da superfície OpenAI (`/v1/*`),
Anthropic (`/v1/messages`) ou Ollama nativa (`/api/chat`, `/api/generate`). Isso
significa que o tráfego da façade Ollama (ex.: Copilot Free conectado como
provider "Ollama", ou qualquer cliente Ollama-native genérico) é invisível como
categoria própria no dashboard do manifest, e não pode ter roteamento/modelo
diferente do resto do tráfego anônimo.

Este spec cobre dar à façade Ollama uma identidade própria no manifest (um
harness dedicado, no mesmo molde do criado para `tier-classifier`), permitindo:
(a) observabilidade/log separados no dashboard; (b) tier/modelo de roteamento
próprios para esse tráfego — sem tocar em headroom, tier-classifier ou manifest.

## 2. Decisões e fatos verificados (2026-07-05)

- **D1 — Nenhum header de origem existe hoje.** As rotas `/api/chat` e
  `/api/generate` (`packages/gateway/src/routes/ollama.ts`) traduzem o payload
  Ollama-native para formato OpenAI (`ollamaChatToOpenAi()`) **dentro do
  próprio gateway** e encaminham para `${headroomUrl}/v1/chat/completions` —
  a mesma URL usada pela rota OpenAI nativa. A partir daí (headroom →
  tier-classifier → manifest), a request é indistinguível de uma request
  OpenAI nativa. Confirmado por leitura direta do código; nenhum header
  customizado é injetado por `proxyHeaders()` (`packages/gateway/src/proxy-headers.ts`)
  nem por `resolveModel()` (`packages/gateway/src/ollama/models.ts`) — o único
  pseudo-modelo hoje (`auto`) tem `headers: {}`.
- **D2 — A identidade no manifest vem só da credencial, não da rota.**
  `createAuthMiddleware` (`packages/gateway/src/auth.ts:11-41`) já recebe
  `{ trustedCidrs, defaultKey }` como parâmetro. Hoje as duas chamadas em
  `index.ts:19` (`/v1/*`) e `index.ts:25-26` (`/api/chat`, `/api/generate`)
  passam o **mesmo** objeto `config`, logo o mesmo `defaultKey`
  (`GATEWAY_DEFAULT_KEY` → `MANIFEST_KEY_LAN_ANON`). Um cliente que já manda
  sua própria credencial (`Authorization`/`x-api-key`) tem essa credencial
  repassada sem alteração, em qualquer superfície — o gateway não valida
  chaves, só decide o que repassar (`proxy-headers.ts:19-27`).
- **D3 — Mecanismo escolhido: parametrizar o `defaultKey` por superfície, não
  adicionar header.** Como o manifest já roteia tiers/modelos por identidade de
  agente (mesmo mecanismo usado pelo agente `tier-classifier`), basta dar à
  façade Ollama seu próprio `defaultKey` injetado — resolve os dois objetivos
  (a) e (b) do §1 sem tocar em headroom/tier-classifier/manifest. A
  classificação simple/complex/reasoning do `tier-classifier` continua rodando
  exatamente igual; só passa a resolver contra as tier assignments do *novo*
  agente em vez do `LAN_ANON`, porque a credencial que chega no manifest para o
  forward real mudou.
- **D4 — Escopo do override: só o caso anônimo.** Confirmado com o usuário
  (2026-07-05): a nova identidade dedicada só substitui o `defaultKey`
  injetado para o caller anônimo/confiável (loopback ou
  `GATEWAY_TRUSTED_CIDRS`, sem credencial própria). Um cliente que já manda sua
  própria `Authorization`/`x-api-key` na façade Ollama não é afetado —
  preserva qualquer integração existente que dependa disso.
- **D5 — Fallback seguro se não configurado.** Se `GATEWAY_OLLAMA_DEFAULT_KEY`
  não for definido (ou vier vazio), o comportamento cai para o mesmo
  `GATEWAY_DEFAULT_KEY` usado por `/v1/*` hoje — ou seja, atualizar o compose
  sem preencher a nova env var não muda nada em produção. Mesmo padrão de
  bootstrap incremental já usado para `MANIFEST_KEY_TIER_CLASSIFIER`.
- **D6 — Harness já criado no manifest** (2026-07-05, ação do usuário): agente
  dedicado para a façade Ollama, chave colada pelo usuário
  (`MANIFEST_KEY_OLLAMA_FACADE`, já adicionada a `deploy/compose/.env`). A
  tier "Default" desse agente é responsabilidade do usuário configurar no
  dashboard do manifest (fora do escopo de código deste spec), apontando para
  o modelo/tier que ele quiser para tráfego Ollama-native anônimo.

## 3. Arquitetura e fluxo

Nenhuma mudança de topologia — só o gateway ganha um segundo `defaultKey`,
escolhido por qual `app.use(..., createAuthMiddleware(...))` intercepta a
request:

```
cliente anônimo (loopback/CIDR confiável)
  │
  ├─ bate em /v1/*             → injeta Bearer GATEWAY_DEFAULT_KEY       (LAN_ANON)
  └─ bate em /api/chat|generate → injeta Bearer GATEWAY_OLLAMA_DEFAULT_KEY (OLLAMA_FACADE, fallback p/ GATEWAY_DEFAULT_KEY se vazio)
        │
        ▼ (ollama.ts traduz Ollama→OpenAI, igual hoje)
   headroom → tier-classifier (classifica simple/complex/reasoning, igual hoje)
        │
        ▼ (Authorization preservado — é o que veio do gateway)
     manifest resolve tier a partir do agente correspondente à credencial
```

Um cliente que já manda sua própria credencial em `/api/chat`/`/api/generate`
não passa pelo caminho "injetado" — `hasCredential` (`auth.ts:13-18`) já faz
`next()` sem tocar em nada, então esse caso é inerentemente preservado sem
qualquer mudança de código.

## 4. Mudanças de código

**`packages/gateway/src/config.ts`:**
- Novo campo `ollamaDefaultKey: string` em `GatewayConfig`.
- Novo helper `firstNonEmpty(...values)` que retorna o primeiro valor
  não-undefined e não-vazio (trata `""` igual a "não configurado" — necessário
  porque o compose sempre define a env var, possivelmente vazia via
  `${MANIFEST_KEY_OLLAMA_FACADE:-}`).
- `ollamaDefaultKey: firstNonEmpty(env.GATEWAY_OLLAMA_DEFAULT_KEY, env.GATEWAY_DEFAULT_KEY)`.

**`packages/gateway/src/index.ts`:**
- `index.ts:25-26` passam a usar
  `createAuthMiddleware({ trustedCidrs: config.trustedCidrs, defaultKey: config.ollamaDefaultKey })`
  em vez de `createAuthMiddleware(config)`.
- `index.ts:19` (`/v1/*`) fica inalterado (continua com `config.defaultKey` via
  `createAuthMiddleware(config)`).

**`auth.ts`:** nenhuma mudança — já aceita `defaultKey` como parâmetro
independente.

## 5. Config (env vars)

| Var | Default | Efeito |
|---|---|---|
| `GATEWAY_OLLAMA_DEFAULT_KEY` | vazio (cai em `GATEWAY_DEFAULT_KEY`) | Bearer injetado para callers anônimos/confiáveis em `/api/chat` e `/api/generate` |
| `MANIFEST_KEY_OLLAMA_FACADE` | (segredo, `.env`, não versionado) | Chave do agente dedicado no manifest; alimenta `GATEWAY_OLLAMA_DEFAULT_KEY` no compose |

`deploy/compose/docker-compose.yml`, bloco `gateway.environment`, adiciona:
```yaml
- GATEWAY_OLLAMA_DEFAULT_KEY=${MANIFEST_KEY_OLLAMA_FACADE:-}
```

`deploy/compose/.env.example` documenta o novo placeholder
`MANIFEST_KEY_OLLAMA_FACADE=`, no mesmo bloco de "Chaves de agente do
manifest", com comentário explicando o propósito e o fallback seguro.

## 6. Testes

Em `packages/gateway/test/` (arquivo de auth existente, ou
`ollama-discovery.test.ts`/`ollama-chat-route.test.ts` conforme convenção já
usada para essas rotas):

- Caller anônimo/confiável em `/api/chat` recebe `Authorization: Bearer
  <ollamaDefaultKey>` no forward para o headroom, quando
  `GATEWAY_OLLAMA_DEFAULT_KEY` está configurado.
- Mesmo caso, mas com `GATEWAY_OLLAMA_DEFAULT_KEY` vazio/ausente: cai para
  `Bearer <defaultKey>` (comportamento de hoje) — regressão explícita.
- Caller que manda `Authorization` própria em `/api/chat`: passa intocada,
  `ollamaDefaultKey` nunca é usado.
- `/v1/*` (`chat/completions`, `/v1/messages`) continua usando `defaultKey`
  sem alteração — regressão do comportamento existente.
- `config.test.ts` (se existir) ou teste equivalente de `loadConfig()`: valores
  default, override completo, e o caso `GATEWAY_OLLAMA_DEFAULT_KEY=""` caindo
  para `GATEWAY_DEFAULT_KEY`.

## 7. Riscos & mitigações

| Risco | Mitigação |
|---|---|
| Esquecer de configurar `MANIFEST_KEY_OLLAMA_FACADE`/`GATEWAY_OLLAMA_DEFAULT_KEY` | Fallback seguro (D5) — comportamento idêntico ao atual até configurar |
| Confundir com override para callers credenciados | D4 — escopo restrito ao caso anônimo, testado explicitamente |
| Tier "Default" do novo agente mal configurada no dashboard (mesma classe de erro já visto com o agente `tier-classifier` — 400 mascarado por model id inválido) | Passo manual do usuário, fora do código; testar com uma chamada real (`/v1/responses` ou `/v1/messages`) antes de dar como concluído |

## Adendo (2026-07-05, mesmo dia): credencial não-mnfst tratada como ausente

- **D7 — Caso concreto encontrado horas depois do deploy:** o GitHub Copilot
  (BYOK, provider "Ollama") manda o **token GitHub dele** no `Authorization`
  ao inferir — e infere via `/v1/chat/completions` (só usa `/api/tags`/`show`
  pra descoberta, então a chave da façade nem se aplica ao tráfego dele). O
  gateway repassava a credencial intocada (D4), o manifest rejeitava com M003
  ("keys start with mnfst_", **sem logar**), e o headroom embrulhava o 401 num
  200 — erro indecifrável no cliente, invisível nos logs da cadeia.
- **Refinamento de D4:** D4 continua valendo para credencial com formato de
  chave do manifest (`Bearer mnfst_*` / `x-api-key: mnfst_*`) — repassada
  intocada. Credencial **sem** esse formato passa a ser tratada como ausente
  (`packages/gateway/src/auth.ts`, `presentsManifestKey`): caller confiável →
  injeta o `defaultKey` da superfície; não-confiável → 401 limpo do próprio
  gateway. Racional: o manifest é o único upstream e só aceita `mnfst_*`;
  repassar outra coisa é falha garantida com pior diagnóstico.
- **Log estruturado de requests** (`packages/gateway/src/request-log.ts`):
  toda request (exceto `/health`) gera linha JSON content-free com método,
  path, status, latência, origem da credencial efetivamente enviada rio acima
  (`auth`: `client`/`injected-default`/`anonymous`) e a shape da credencial
  que o cliente apresentou (`authHeader` + `manifestKeyShape`) — nunca o
  valor. Foi esse log que revelou o comportamento do Copilot.
- **Operacional:** para o tráfego do host (hairpin do docker-proxy →
  `172.28.1.1`) ser elegível à injeção, o usuário optou conscientemente por
  `GATEWAY_TRUSTED_CIDRS=172.28.1.0/24` no `.env` (risco documentado no
  próprio `.env.example`: qualquer processo do host passa sem chave — máquina
  pessoal single-user). O caminho `/v1/*` injeta `MANIFEST_KEY_LAN_ANON`, que
  precisa estar válida no dashboard.

## Adendo 2 (2026-07-05): canonização de request no tier-classifier

- **Causa raiz das falhas Anthropic (lidas de `agent_messages` no Postgres, não do
  `docker logs` — o manifest não loga o erro do provider quando um fallback ocorre;
  só persiste em `agent_messages.error_message`):** `claude-opus-4-8` devolve
  `400 invalid_request_error: "temperature may only be set to 1 when thinking is
  enabled or in adaptive mode"`. O GitHub Copilot (via agente `ollama-harness`)
  manda `temperature` ≠ 1; o opus roda em thinking/adaptive; a Anthropic rejeita.
  O `temperature` vem do CLIENTE, não da config do manifest (`param_defaults` nulo).
- **D8 — Canonização content-blind no tier-classifier.** O tier-classifier remove
  um conjunto fixo mínimo de params de sampling/thinking de TODO request antes do
  forward: `temperature`, `top_p`, `top_k`, `thinking`. Racional: o manifest é dono
  desses params por tier/agente, então os valores do cliente são redundantes (quem
  aceita usa o default) ou quebram (Anthropic-thinking). Não identifica o modelo
  destino — isso exigiria replicar a tabela de roteamento do manifest (acoplamento
  que D3/D4 evitam) e seria cego a fallback; e como remover esses params é inócuo
  pra quem aceita, a canonização incondicional é segura. `packages/tier-classifier/src/canonicalize.ts`.
- **Fail-safe:** corpo vazio/não-JSON/não-objeto passa intacto; só reserializa se
  removeu algo; nunca lança. Config `CLASSIFIER_CANONICALIZE` (default true) é
  kill-switch. O log `tier-classifier.forward` ganha `stripped: [...]` (só nomes de
  chave, nunca valores).
- **D9 — Bypass por harness destino (2026-07-06).** `CLASSIFIER_CANONICALIZE_BYPASS`
  = lista de credenciais (chaves de harness) separadas por vírgula; requests
  carregando uma delas pulam a canonização. Racional: o Claude Code (harness
  `Claude-Gateway`) manda `thinking`/params próprios que quer preservar, enquanto o
  Copilot (`ollama-harness`) precisa da limpeza. **Restrição estrutural:** o
  tier-classifier não enxerga o NOME do harness destino, só a credencial que a
  request carrega (Bearer ou x-api-key) -- e cada harness = uma chave `mnfst_`;
  então o bypass é por chave, casado contra a lista. Config no compose defaulta pra
  `${MANIFEST_KEY_CLAUDE_CODE}`. O credencial nunca é logado; o forward ganha
  `canonicalizeBypassed: true` quando aplica.
- **Não resolvido por aqui:** (a) `claude-sonnet-4-6` → `400 "You're out of extra
  usage"` (créditos da assinatura, nível de conta); (b) o fallback `glm-5.2` →
  `401 Unauthorized` (auth do opencode-go/ollama-cloud) — ambos fora do escopo da
  canonização.

## 8. Fora de escopo

- Qualquer mudança em `headroom` ou `manifest`.
- Qualquer mudança em `tier-classifier` (classificação continua idêntica).
- Header de origem/superfície (`x-manifest-origin` ou similar) — descartado:
  a credencial dedicada já resolve identidade *e* roteamento sem precisar
  disso (§2, D3).
- Estender esse padrão para clientes que já mandam credencial própria na
  façade Ollama — YAGNI até haver um caso concreto.

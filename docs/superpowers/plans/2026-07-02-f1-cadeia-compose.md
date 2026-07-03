# F1 — Cadeia Compose (headroom → manifest) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Subir e validar a cadeia headroom(:8787) → manifest(:2099) → provedores via Docker Compose, com opencode conversando de ponta a ponta e custo por ferramenta visível no dashboard.

**Architecture:** Compose com 3 serviços (manifest + postgres internos ao stack; headroom publicado só em `127.0.0.1:8787` nesta fase). headroom encaminha as duas pernas (OpenAI e Anthropic) para o manifest via `{OPENAI,ANTHROPIC}_TARGET_API_URL`; chaves `mnfst_*` dos clientes atravessam o headroom intactas. opencode conecta por provider `@ai-sdk/openai-compatible`. Sem gateway ainda (F2).

**Tech Stack:** Docker Compose; imagens `manifestdotbuild/manifest:6.12.0`, `ghcr.io/chopratejas/headroom:0.28.0`, `postgres:16-alpine`; bash + curl + jq para validação; GitHub Actions (compose-validate + gitleaks).

**Plano 1 de ~4.** F2 (gateway passthrough), F3 (façade Ollama) e F4/F5 (CLI corehub + skills hub) ganham planos próprios depois que a F1 entregar a cadeia real (as fixtures de contrato do gateway serão capturadas dela).

## Global Constraints

- Spec de referência: `docs/superpowers/specs/2026-07-02-ia-stack-design.md` (aprovado 2026-07-02).
- Imagens pinadas: `manifestdotbuild/manifest:6.12.0`, `ghcr.io/chopratejas/headroom:0.28.0`, `postgres:16-alpine`. Upgrade só deliberado.
- Portas: `2099` manifest (LAN, `0.0.0.0`); `8787` headroom (**somente `127.0.0.1` na F1**); `11434` fica RESERVADA para o gateway (F2) — nada pode ocupá-la.
- `OLLAMA_HOST` do manifest NUNCA aponta para `host.docker.internal:11434` (risco de loop com o gateway na F2) — default inerte `http://ollama-disabled.invalid:11434`.
- Telemetria desligada: `MANIFEST_TELEMETRY_DISABLED=1`, `HEADROOM_TELEMETRY=off`, `HEADROOM_UPDATE_CHECK=off`.
- Sem Qdrant/Neo4j (memória do headroom fora do escopo).
- Segredos só em `deploy/compose/.env` (gitignorado); `.env.example` versionado sem valores.
- Nomes das chaves no `.env`: `MANIFEST_KEY_OPENCODE`, `MANIFEST_KEY_CLAUDE_CODE`, `MANIFEST_KEY_COPILOT`, `MANIFEST_KEY_OPENWEBUI`, `MANIFEST_KEY_LAN_ANON` (F2+ dependem desses nomes exatos).
- Commits frequentes, mensagens em pt-BR estilo conventional (`feat:`, `docs:`, `ci:`), rodapé `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Licença MIT; specs/planos em pt-BR.

---

### Task 1: Compose + env (arquivos de infra)

**Files:**
- Create: `deploy/compose/docker-compose.yml`
- Create: `deploy/compose/.env.example`
- Create: `deploy/compose/.env` (local, NÃO commitado)

**Interfaces:**
- Produces: serviços `manifest`, `headroom`, `postgres` na rede default do compose (project name `ia-stack`); headroom em `http://127.0.0.1:8787` (host); manifest em `http://<host>:2099`; volumes `pgdata`, `headroom_workspace`. Variáveis de `.env` listadas no `.env.example` abaixo.

- [ ] **Step 1: Verificar pré-requisitos**

Run: `docker compose version && docker info --format '{{.ServerVersion}}'`
Expected: versão do compose v2.x e daemon respondendo. Se falhar: instalar/iniciar Docker antes de continuar.

- [ ] **Step 2: Criar `deploy/compose/docker-compose.yml`**

```yaml
name: ia-stack

services:
  manifest:
    image: manifestdotbuild/manifest:6.12.0
    restart: unless-stopped
    ports:
      - "0.0.0.0:2099:2099"            # dashboard na LAN (auth própria: Better Auth)
    environment:
      - DATABASE_URL=postgresql://manifest:${POSTGRES_PASSWORD}@postgres:5432/manifest
      - BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET:?defina no .env}
      - BETTER_AUTH_URL=${MANIFEST_PUBLIC_URL:-http://localhost:2099}
      - MANIFEST_ENCRYPTION_KEY=${MANIFEST_ENCRYPTION_KEY:?defina no .env}
      - MANIFEST_MODE=selfhosted
      - MANIFEST_TELEMETRY_DISABLED=1
      # inerte de propósito: 11434 do host será o gateway na F2 (loop se apontar pra lá)
      - OLLAMA_HOST=${OLLAMA_HOST:-http://ollama-disabled.invalid:11434}
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      # imagem distroless (sem curl): usar o node embarcado
      test: ["CMD", "/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:2099/api/v1/health').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 30s
    read_only: true
    security_opt:
      - no-new-privileges:true
    cap_drop: [ALL]

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      - POSTGRES_USER=manifest
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD:?defina no .env}
      - POSTGRES_DB=manifest
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U manifest -d manifest"]
      interval: 5s
      timeout: 3s
      retries: 20

  headroom:
    image: ghcr.io/chopratejas/headroom:0.28.0
    restart: unless-stopped
    command: ["--host", "0.0.0.0"]     # entrypoint da imagem é o proxy (mesmo padrão do compose upstream)
    ports:
      - "127.0.0.1:8787:8787"          # F1: host-only. F2 remove (gateway assume a frente)
    environment:
      - HEADROOM_HOST=0.0.0.0
      - OPENAI_TARGET_API_URL=http://manifest:2099
      - ANTHROPIC_TARGET_API_URL=http://manifest:2099
      - HEADROOM_TELEMETRY=off
      - HEADROOM_UPDATE_CHECK=off
      - HEADROOM_DEFAULT_MODE=optimize
    volumes:
      - headroom_workspace:/home/nonroot/.headroom
    depends_on:
      manifest:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "--fail", "--silent", "http://127.0.0.1:8787/readyz"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 20s

volumes:
  pgdata:
    name: ia-stack_pgdata
  headroom_workspace:
    name: ia-stack_headroom
```

- [ ] **Step 3: Criar `deploy/compose/.env.example`**

```bash
# ── Segredos (gerar com: openssl rand -hex 32) ─────────────────────────
BETTER_AUTH_SECRET=
MANIFEST_ENCRYPTION_KEY=
POSTGRES_PASSWORD=

# ── URL que o NAVEGADOR usa para abrir o dashboard ─────────────────────
# Precisa casar com a origem do browser, senão o login falha ("Invalid origin").
# Acesso pela LAN: http://<ip-da-maquina>:2099
MANIFEST_PUBLIC_URL=http://localhost:2099

# ── Chaves de agente do manifest (criadas no dashboard — Task 2) ───────
MANIFEST_KEY_OPENCODE=
MANIFEST_KEY_CLAUDE_CODE=
MANIFEST_KEY_COPILOT=
MANIFEST_KEY_OPENWEBUI=
MANIFEST_KEY_LAN_ANON=
```

- [ ] **Step 4: Gerar o `.env` local**

```bash
cd deploy/compose
cp .env.example .env
sed -i "s/^BETTER_AUTH_SECRET=$/BETTER_AUTH_SECRET=$(openssl rand -hex 32)/" .env
sed -i "s/^MANIFEST_ENCRYPTION_KEY=$/MANIFEST_ENCRYPTION_KEY=$(openssl rand -hex 32)/" .env
sed -i "s/^POSTGRES_PASSWORD=$/POSTGRES_PASSWORD=$(openssl rand -hex 32)/" .env
```

Run: `grep -c '=$' deploy/compose/.env`
Expected: `5` → sobraram vazias apenas as 5 `MANIFEST_KEY_*` (preenchidas na Task 2); os 3 segredos foram gerados e `MANIFEST_PUBLIC_URL` tem valor. Ajuste `MANIFEST_PUBLIC_URL` para o IP da LAN se for acessar o dashboard de outra máquina.

- [ ] **Step 5: Validar sintaxe/interpolação do compose**

Run: `docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env config -q && echo OK`
Expected: `OK` (sem warnings de variável indefinida).

- [ ] **Step 6: Confirmar que `.env` está fora do git e commitar**

Run: `git check-ignore deploy/compose/.env && git status --short`
Expected: caminho do `.env` ecoado (ignorado); status mostra só `docker-compose.yml` e `.env.example`.

```bash
git add deploy/compose/docker-compose.yml deploy/compose/.env.example
git commit -m "feat(f1): compose da cadeia headroom->manifest (postgres, telemetria off, 11434 reservada)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Subir o stack + configurar o manifest (dashboard) 🧑‍💻 checkpoint manual

**Files:**
- Modify: `deploy/compose/.env` (preencher as 5 `MANIFEST_KEY_*`; NÃO commitado)

**Interfaces:**
- Consumes: serviços da Task 1.
- Produces: manifest com admin criado, ≥1 provedor conectado, tier default configurado e 5 agentes (`opencode`, `claude-code`, `copilot`, `openwebui`, `lan-anon`) com chaves `mnfst_*` no `.env`. As Tasks 3–4 e todas as fases seguintes dependem dessas chaves.

- [ ] **Step 1: Subir e aguardar saúde**

Run: `docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env up -d && docker compose -f deploy/compose/docker-compose.yml ps`
Expected: 3 serviços `running`; `manifest` e `headroom` com `(healthy)` em até ~1 min. Se `headroom` reiniciar em loop, ver `docker compose logs headroom` (suspeitos: entrypoint ≠ proxy → ajustar `command`; nesse caso corrigir o compose e commitar fix).

- [ ] **Step 2 (MANUAL — usuário): Setup do dashboard**

No navegador, abrir `MANIFEST_PUBLIC_URL` (ex.: `http://localhost:2099`):
1. Wizard `/setup`: criar a primeira conta → vira admin.
2. **Providers**: conectar pelo menos 1 provedor real (chave de API Anthropic/OpenAI **ou** assinatura Claude Pro/ChatGPT — guiado pela UI). Credenciais ficam cifradas com `MANIFEST_ENCRYPTION_KEY`.
3. **Routing**: configurar o tier **default** — 1 modelo primário + ao menos 1 fallback de outro provedor/modelo (necessário para o teste de fallback da Task 5).
4. **Agents**: criar 5 agentes com estes nomes exatos: `opencode`, `claude-code`, `copilot`, `openwebui`, `lan-anon`. Copiar a chave `mnfst_...` de cada um.

- [ ] **Step 3: Registrar as chaves no `.env`**

Editar `deploy/compose/.env` preenchendo as 5 `MANIFEST_KEY_*`.

Run: `grep -c '^MANIFEST_KEY_.*=mnfst_' deploy/compose/.env`
Expected: `5`

- [ ] **Step 4: Smoke do proxy do manifest (sem headroom no meio)**

```bash
set -a; source deploy/compose/.env; set +a
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $MANIFEST_KEY_OPENCODE" \
  http://localhost:2099/v1/models
```

Expected: `200`. (Sem commit — nada versionável mudou nesta task.)

---

### Task 3: Script de validação da cadeia (o "pré-doctor")

**Files:**
- Create: `deploy/compose/scripts/validate-chain.sh` (executável)

**Interfaces:**
- Consumes: chain up (Task 2), env `MANIFEST_KEY_OPENCODE`.
- Produces: `validate-chain.sh` — usado no critério de aceite da F1 e evolui para `corehub doctor` na F4. Uso: `./deploy/compose/scripts/validate-chain.sh` (lê `deploy/compose/.env` sozinho).

- [ ] **Step 1: Escrever o script (ele é o teste; a cadeia é a implementação)**

```bash
#!/usr/bin/env bash
# validate-chain.sh — valida a cadeia headroom(:8787) -> manifest(:2099) -> provedor
set -u
cd "$(dirname "$0")/.."
set -a; source ./.env; set +a

HR=http://127.0.0.1:8787
MF=http://localhost:2099
KEY="${MANIFEST_KEY_OPENCODE:?MANIFEST_KEY_OPENCODE ausente no .env}"
fail=0
say() { printf '%-46s %s\n' "$1" "$2"; }
check() { # nome, esperado, obtido
  if [ "$2" = "$3" ]; then say "$1" "PASS"; else say "$1" "FAIL (esperado $2, obtido $3)"; fail=1; fi
}

# 1. saúde dos serviços
check "manifest /api/v1/health" 200 "$(curl -sS -o /dev/null -w '%{http_code}' $MF/api/v1/health)"
check "headroom /readyz"        200 "$(curl -sS -o /dev/null -w '%{http_code}' $HR/readyz)"

# 2. passthrough + auth: /v1/models via headroom exige chave mnfst_ valida (D4)
check "GET /v1/models via headroom (com chave)" 200 \
  "$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" $HR/v1/models)"
check "GET /v1/models via headroom (sem chave) => 401" 401 \
  "$(curl -sS -o /dev/null -w '%{http_code}' $HR/v1/models)"
curl -sS -H "Authorization: Bearer $KEY" $HR/v1/models | jq -e '.data[0].id=="auto"' >/dev/null \
  && say "primeiro modelo listado e 'auto'" PASS || { say "primeiro modelo listado e 'auto'" FAIL; fail=1; }

# 3. perna OpenAI: chat roteado (model=auto), nao-streaming
resp_headers=$(mktemp)
body=$(curl -sS -D "$resp_headers" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"Responda apenas: ok"}]}' \
  $HR/v1/chat/completions)
echo "$body" | jq -e '.choices[0].message.content' >/dev/null \
  && say "POST /v1/chat/completions (auto)" PASS || { say "POST /v1/chat/completions (auto)" FAIL; echo "$body" | head -c 400; fail=1; }
grep -qi '^x-manifest-model:' "$resp_headers" \
  && say "headers X-Manifest-* presentes" PASS || { say "headers X-Manifest-* presentes" FAIL; fail=1; }

# 4. perna OpenAI: streaming SSE termina com [DONE]
curl -sSN -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"auto","stream":true,"messages":[{"role":"user","content":"Conte ate 3"}]}' \
  $HR/v1/chat/completions | tail -5 | grep -q '\[DONE\]' \
  && say "streaming SSE com [DONE]" PASS || { say "streaming SSE com [DONE]" FAIL; fail=1; }

# 5. perna Anthropic: /v1/messages via headroom -> manifest (D3)
code=$(curl -sS -o /tmp/anth.json -w '%{http_code}' \
  -H "Authorization: Bearer $KEY" -H 'anthropic-version: 2023-06-01' -H 'Content-Type: application/json' \
  -d '{"model":"auto","max_tokens":32,"messages":[{"role":"user","content":"Responda apenas: ok"}]}' \
  $HR/v1/messages)
check "POST /v1/messages via headroom" 200 "$code"
[ "$code" = 200 ] && jq -e '.content[0]' /tmp/anth.json >/dev/null \
  && say "corpo Anthropic com content[]" PASS || true

# 6. evidencia de compressao
curl -sS $HR/stats | jq -e 'type=="object"' >/dev/null \
  && { say "headroom /stats acessivel" PASS; curl -sS $HR/stats | jq '.' | head -20; } \
  || { say "headroom /stats acessivel" FAIL; fail=1; }

exit $fail
```

Run: `chmod +x deploy/compose/scripts/validate-chain.sh`

- [ ] **Step 2: Rodar e corrigir até verde**

Run: `./deploy/compose/scripts/validate-chain.sh`
Expected: todas as linhas `PASS`, exit 0. Diagnóstico dos FAILs prováveis:
- `401` no teste COM chave → chave errada no `.env` ou agente desabilitado no dashboard.
- `/v1/messages` ≠ 200 → conferir `ANTHROPIC_TARGET_API_URL` no serviço headroom (`docker compose exec headroom env | grep TARGET`).
- Modelo não responde → tier default sem modelo primário (Routing no dashboard).

- [ ] **Step 3: Commit**

```bash
git add deploy/compose/scripts/validate-chain.sh
git commit -m "feat(f1): validate-chain.sh — valida saude, auth passthrough, 2 pernas e streaming

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Conectar o opencode na cadeia

**Files:**
- Create: `opencode.json` (raiz do repo — config de projeto do opencode)

**Interfaces:**
- Consumes: headroom em `127.0.0.1:8787` (Task 1), `MANIFEST_KEY_OPENCODE` (Task 2).
- Produces: provider `iastack` com modelo `iastack/auto` disponível em sessões opencode abertas neste repo. Na F2 o `baseURL` muda para o gateway (`http://<host>:11434/v1`) — mesma estrutura.

- [ ] **Step 1: Criar `opencode.json` na raiz**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "iastack": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "ia-stack (headroom→manifest)",
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1",
        "apiKey": "{env:MANIFEST_KEY_OPENCODE}"
      },
      "models": {
        "auto": {
          "name": "auto (roteado pelo manifest)",
          "limit": { "context": 200000, "output": 64000 }
        }
      }
    }
  }
}
```

(Sem segredo no arquivo — a chave vem de `{env:...}`; commitável.)

- [ ] **Step 2: Teste headless de ponta a ponta**

```bash
set -a; source deploy/compose/.env; set +a
opencode run -m iastack/auto "Responda com uma unica palavra: ok"
```

Expected: resposta impressa (contém "ok"), exit 0. Se `provider not found`: rodar de dentro do repo (config de projeto). Se 401: exportar a env antes de rodar.

- [ ] **Step 3 (MANUAL — usuário): Conferir atribuição de custo**

No dashboard (Messages/Analytics): a request aparece atribuída ao agente **opencode**, com modelo/tier/custo preenchidos.
Expected: 1+ mensagens no log do agente `opencode`.

- [ ] **Step 4: Commit**

```bash
git add opencode.json
git commit -m "feat(f1): provider iastack no opencode (headroom->manifest, chave via env)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Teste de fallback (critério de aceite da F1)

**Files:** nenhum novo (procedimento manual documentado no plano; resultado observável no dashboard).

**Interfaces:**
- Consumes: tier default com primário + fallback (Task 2, passo Routing), `validate-chain.sh`.

- [ ] **Step 1 (MANUAL — usuário): Forçar falha do primário**

No dashboard → Providers: invalidar temporariamente o provedor do modelo primário do tier default (trocar a chave por uma inválida) **ou** configurar como primário um modelo de um provedor desconectado, mantendo o fallback saudável.

- [ ] **Step 2: Disparar request e observar o fallback**

```bash
set -a; source deploy/compose/.env; set +a
curl -sS -D - -o /dev/null -H "Authorization: Bearer $MANIFEST_KEY_OPENCODE" -H 'Content-Type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"ok?"}]}' \
  http://127.0.0.1:8787/v1/chat/completions | grep -i '^x-manifest-fallback'
```

Expected: header `X-Manifest-Fallback-From: <modelo-primario>` presente e resposta 200 (o manifest reencaminhou antes do 1º chunk).

- [ ] **Step 3 (MANUAL — usuário): Restaurar o provedor primário**

Desfazer a alteração do Step 1. Rodar `./deploy/compose/scripts/validate-chain.sh` → tudo `PASS` de novo.

---

### Task 6: CI (GitHub Actions) + README

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `README.md`

**Interfaces:**
- Produces: workflow `ci` (jobs `compose-validate` e `gitleaks`) que a F2 estende com os jobs de TypeScript (typecheck/Biome/`bun test`).

- [ ] **Step 1: Criar `.github/workflows/ci.yml`**

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:

jobs:
  compose-validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: env dummy para interpolação (não sobe serviços)
        run: |
          cp deploy/compose/.env.example deploy/compose/.env
          sed -i 's/^BETTER_AUTH_SECRET=$/BETTER_AUTH_SECRET=ci-dummy/' deploy/compose/.env
          sed -i 's/^MANIFEST_ENCRYPTION_KEY=$/MANIFEST_ENCRYPTION_KEY=ci-dummy/' deploy/compose/.env
          sed -i 's/^POSTGRES_PASSWORD=$/POSTGRES_PASSWORD=ci-dummy/' deploy/compose/.env
      - run: docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env config -q

  gitleaks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 2: Criar `README.md`**

```markdown
# ia-stack

Self-hosted AI stack: a custom gateway (OpenAI + Anthropic + Ollama-compatible surfaces)
in front of [headroom](https://github.com/headroomlabs-ai/headroom) (context compression)
and [manifest](https://github.com/mnfst/manifest) (LLM routing & cost control).
Connect opencode, GitHub Copilot, Claude Code — or anything speaking those protocols.

**Status:** F1 — compose chain (headroom → manifest) up and validated.

## Quick start (F1)

1. `cd deploy/compose && cp .env.example .env` — fill the three secrets (`openssl rand -hex 32`).
2. `docker compose up -d` and open `http://localhost:2099` — create the admin account,
   connect a provider, configure the default routing tier, create the agents
   (`opencode`, `claude-code`, `copilot`, `openwebui`, `lan-anon`) and put their
   `mnfst_` keys in `.env`.
3. `./scripts/validate-chain.sh` — everything must PASS.

Design spec: `docs/superpowers/specs/2026-07-02-ia-stack-design.md` (pt-BR). License: MIT.
```

- [ ] **Step 3: Validar YAML e commitar**

Run: `docker run --rm -v "$PWD":/repo -w /repo python:3-alpine python -c "import yaml,sys;yaml.safe_load(open('.github/workflows/ci.yml'));print('yaml ok')"`
Expected: `yaml ok` (alternativa sem docker: `python3 -c ...` se houver python local).

```bash
git add .github/workflows/ci.yml README.md
git commit -m "ci: compose-validate + gitleaks; docs: README inicial

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Remote GitHub (repo privado `ia-stack`) 🧑‍💻 checkpoint manual

**Files:** nenhum (operação git/GitHub).

**Interfaces:**
- Consumes: commits das Tasks 1–6 em `main`.
- Produces: remote `origin` = repo privado `ia-stack` do usuário; CI da Task 6 executando no primeiro push.

- [ ] **Step 1 (MANUAL — usuário): Criar o repo privado (escolher UMA via)**

**Via A — gh CLI** (não está instalado): instalar (`sudo apt install gh` ou binário em `~/.local/bin`), `gh auth login` (interativo), depois:
```bash
gh repo create ia-stack --private --source . --push
```

**Via B — site**: criar repo privado vazio `ia-stack` em github.com (SEM README/gitignore/license iniciais), depois:
```bash
git remote add origin git@github.com:<user>/ia-stack.git
git push -u origin main
```

- [ ] **Step 2: Verificar CI verde**

Run: `git ls-remote --heads origin main`
Expected: hash de `main` listado. No site: aba Actions com `ci` verde (2 jobs). Se `gitleaks` falhar, tratar o achado antes de seguir (nenhum segredo deve estar versionado).

---

## Critério de aceite da F1 (do spec §9)

- [ ] `validate-chain.sh` todo PASS (saúde, auth passthrough D4, pernas OpenAI e Anthropic D3, streaming, `/stats`)
- [ ] opencode conversando via `iastack/auto` (Task 4)
- [ ] Custo/tier por agente visível no dashboard (Task 4 Step 3)
- [ ] Fallback comprovado com `X-Manifest-Fallback-From` (Task 5)
- [ ] CI verde no GitHub (Task 7)

# `corehub connect` — Design Spec

**Data:** 2026-07-03 · **Status:** aprovado em 2026-07-03 · **Autor:** fkmatsuda + Claude (brainstorming)

## 1. Objetivo

Estender o CLI `corehub` (`packages/cli`, F4) com um novo comando, `corehub connect`, que automatiza o
que hoje é um passo manual documentado em `docs/connecting-tools.md`: apontar opencode e Claude Code
para o gateway do ia-stack (`:11434`), escrevendo a config nativa de cada ferramenta a partir das
chaves `MANIFEST_KEY_*` já existentes em `deploy/compose/.env`.

**Gerenciamento de servidores MCP foi avaliado nesta mesma sessão de brainstorming e explicitamente
adiado** — fica fora de escopo deste documento e de qualquer trabalho imediato.

## 2. Decisões e fatos verificados (2026-07-03)

| # | Decisão | Fato que a sustenta |
|---|---|---|
| D1 | `corehub connect` escreve config real (não só documenta) para **opencode** e **Claude Code**; para **Copilot** só imprime o snippet | GitHub Copilot BYOK grava a chave via secret storage interno do VS Code (`${input:chat.lm.secret...}`) — não há API/CLI documentada pra popular isso de fora; segue manual, como na F2 |
| D2 | Claude Code: config global fica em `~/.claude/settings.json`, bloco `env.ANTHROPIC_BASE_URL`/`env.ANTHROPIC_AUTH_TOKEN`; config de projeto em `.claude/settings.local.json` | Doc oficial (code.claude.com/docs/en/settings); confirmado que config de projeto tem prioridade sobre a global — sem conflito com o `.claude/settings.local.json` que já pode existir num projeto |
| D3 | opencode: config em `opencode.json`, chave `"provider"`, mesma forma já usada no `opencode.json` do próprio ia-stack | Arquivo já existe e funciona neste repo desde a F2 |
| D4 | Config gerada por `corehub connect` usa o **valor literal** da chave `mnfst_...`, nunca a referência `{env:VAR}` que o `opencode.json` do próprio ia-stack usa | Fora do repo ia-stack não há garantia de que `MANIFEST_KEY_*` esteja exportada no shell de destino — `{env:VAR}` quebraria silenciosamente |
| D5 | `corehub connect` roda de qualquer diretório (não precisa estar dentro do ia-stack) | Reaproveita o mecanismo `COREHUB_ROOT` já existente desde a F4 (documentado para o binário compilado) pra localizar `deploy/compose/.env` |
| D6 | Escopo por-projeto é o **padrão**; `--global` é opt-in explícito | Decisão do usuário — escrever na config global muda o backend padrão de TODA sessão futura daquela ferramenta, em qualquer projeto; o padrão seguro é não fazer isso sem pedir |

## 3. Comando

```
corehub connect [tool] [--global]
```

- **Sem `tool`**: conecta `opencode` + `claude-code` (as duas automatizáveis), e imprime o snippet do
  `copilot` (igual ao que já existe em `docs/connecting-tools.md`) como lembrete — sem escrever
  arquivo nenhum para o Copilot.
- **`corehub connect opencode`** / **`corehub connect claude-code`** / **`corehub connect copilot`**:
  só aquela ferramenta.
- **`--global`**: escreve na config global da ferramenta em vez da config do projeto atual (CWD).

### Onde escreve

| Ferramenta | Por-projeto (padrão) | `--global` |
|---|---|---|
| opencode | `<CWD>/opencode.json` | `~/.config/opencode/opencode.json` |
| Claude Code | `<CWD>/.claude/settings.local.json` | `~/.claude/settings.json` |
| Copilot | — (só imprime) | — (só imprime) |

`<CWD>` é o diretório onde o usuário roda o comando — pode ser o próprio ia-stack ou qualquer outro
projeto. A raiz do ia-stack (de onde vêm as chaves) é resolvida separadamente via
`COREHUB_ROOT`/`resolvePaths()` (F4), independente do CWD.

## 4. Comportamento de escrita

- **Merge, nunca sobrescrita total.** `opencode.json`: insere/atualiza só a chave do provider
  `iastack` dentro de `"provider"`, preservando qualquer outro provider já configurado ali. Config
  do Claude Code: insere/atualiza só `env.ANTHROPIC_BASE_URL`/`env.ANTHROPIC_AUTH_TOKEN`, preservando
  o resto do JSON (incluindo um `env` com outras variáveis, se existir).
- **Idempotente.** Rodar de novo atualiza a mesma entrada (mesmo `provider.iastack` / mesmo par de
  chaves `env.ANTHROPIC_*`) em vez de duplicar.
- **Proteção de segredo em projeto alheio.** Quando escreve por-projeto (sem `--global`) e o CWD tem
  um `.gitignore`, adiciona automaticamente o caminho escrito (`opencode.json` e/ou
  `.claude/settings.local.json`) se ainda não estiver coberto por um padrão existente — nunca deixa
  uma chave `mnfst_` exposta a um `git add .` acidental num projeto que não é gerido pelo corehub.
  Isso é uma adição estritamente aditiva ao `.gitignore` de terceiros (nunca remove linhas).
- **Qual chave usar por ferramenta.** opencode usa `MANIFEST_KEY_OPENCODE`; Claude Code usa
  `MANIFEST_KEY_CLAUDE_CODE`; se a chave correspondente estiver vazia no `.env` do ia-stack, o
  comando **pula aquela ferramenta inteiramente** (nenhum arquivo é tocado para ela), imprime um
  aviso explicando qual chave falta e no dashboard do manifest ela é criada, e continua para as
  demais ferramentas pedidas — nunca escreve um provider/env com `Authorization: Bearer ` vazio.
- **URL do gateway.** Usa `http://127.0.0.1:<GATEWAY_HOST_PORT ou 11434>` — mesma lógica de leitura
  de `.env` que `corehub doctor` já usa.

## 5. Testes

Lógica pura (montar o novo conteúdo do JSON a partir do conteúdo existente + a chave a inserir)
testada com `bun test`, no molde de `env.ts`/`skills.ts` da F4 — funções puras `merge*` recebendo o
JSON atual (ou `null`/ausente) e retornando o novo, sem tocar disco. A escrita real de arquivo e o
merge de `.gitignore` são exercitados manualmente com diretórios descartáveis (`mktemp -d`) — nunca
contra `~/.claude`, `~/.config/opencode` reais ou qualquer projeto de verdade do usuário durante o
desenvolvimento/validação.

## 6. Riscos & mitigações

| Risco | Mitigação |
|---|---|
| `--global` muda o backend padrão de toda sessão futura daquela ferramenta, em qualquer projeto | Não é o padrão; exige flag explícita; documentado claramente no `--help` e no `docs/connecting-tools.md` |
| Merge corrompe um `opencode.json`/`settings.json` existente com estrutura inesperada | Merge só toca as chaves conhecidas (`provider.iastack`, `env.ANTHROPIC_*`); se o arquivo existente não for JSON válido, o comando falha alto e claro em vez de sobrescrever |
| Chave `mnfst_` vaza para o histórico git de um projeto alheio | `.gitignore` auto-atualizado (aditivo) quando escreve por-projeto |
| Usuário espera que isso também configure Copilot de ponta a ponta | Documentado explicitamente que Copilot continua manual (limite real da plataforma, não do corehub) |

## 7. Fora de escopo

Gerenciamento de servidores MCP (Context7, Brave Search, Firecrawl) — avaliado e adiado nesta mesma
sessão de brainstorming; nenhum trabalho de MCP faz parte desta spec.

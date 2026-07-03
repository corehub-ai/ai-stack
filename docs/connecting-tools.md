# Conectando ferramentas ao ia-stack

Gateway em `:11434` (LAN). Cada ferramenta usa a chave do seu agente em
`deploy/compose/.env` (`MANIFEST_KEY_*`). Se a sua máquina já tiver um
Ollama nativo ocupando a 11434, ajuste `GATEWAY_HOST_PORT` no `.env` e
troque a porta nos exemplos abaixo.

## opencode
Já configurado em `opencode.json` (raiz do repo) — provider `iastack`, modelo `iastack/auto`.

## Claude Code
Escopo por projeto via `.claude/settings.local.json` (auto-gitignorado, não commitar):
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://<ip-da-maquina>:11434",
    "ANTHROPIC_AUTH_TOKEN": "<MANIFEST_KEY_CLAUDE_CODE do .env>"
  }
}
```
Confirmar com `/status` dentro de uma sessão do Claude Code.

## GitHub Copilot Chat (VS Code) — BYOK Custom Endpoint
Estável desde a v1.122 (2026-05-28), funciona sem login GitHub.

1. Command Palette → **Chat: Manage Models...** → **Custom Endpoint** → **Add Model**.
2. O VS Code abre um `chatLanguageModels.json` para editar. Colar:
```json
[
  {
    "name": "ia-stack (Copilot)",
    "vendor": "customendpoint",
    "apiKey": "<MANIFEST_KEY_COPILOT do .env>",
    "apiType": "chat-completions",
    "models": [
      {
        "id": "auto",
        "name": "ia-stack auto",
        "url": "http://<ip-da-maquina>:11434/v1/chat/completions",
        "toolCalling": true,
        "vision": false,
        "maxInputTokens": 128000,
        "maxOutputTokens": 16000
      }
    ]
  }
]
```
3. Salvar, reabrir o seletor de modelo no Chat — "ia-stack auto" deve aparecer na lista.

## Open WebUI
Sobe junto com o stack pelo profile `ui`:
```bash
docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env \
  --profile local-models --profile ui up -d
```
Abrir `http://<ip-da-maquina>:3000`, criar a conta admin (auth própria do Open WebUI),
e usar o modelo `auto`. A conexão já vem configurada (env `OPENAI_API_BASE_URL` →
`http://gateway:11434/v1`, chave `MANIFEST_KEY_OPENWEBUI`).

## Clientes Ollama genéricos
O gateway expõe a superfície Ollama em `:11434`. Qualquer cliente que fale o protocolo
Ollama conecta apontando `OLLAMA_HOST=http://<ip-da-maquina>:11434`. Modelos disponíveis
via `GET /api/tags` (só `auto` por enquanto). Clientes de loopback ou dentro de
`GATEWAY_TRUSTED_CIDRS` não precisam de chave; os demais mandam a chave `mnfst_` do seu
agente como `Authorization: Bearer`.

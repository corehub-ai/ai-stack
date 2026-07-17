# Relatório: investigação rate-limit Cursor + logs gateway

**Data:** 2026-07-16 17:06:48  
**Branch:** (working tree local; sem commit solicitado)

## Resumo

O erro do Cursor **“User Provided API Key Rate Limit Exceeded”** **não veio do ia-stack**. Nos logs do gateway (48h) **não há nenhum 429**, nem User-Agent do Cursor, e nas **3h** em torno do erro havia **0 requests em `/v1/*`**. O BYOK do Cursor roteia pelo cloud deles, que bloqueia IPs privados (SSRF); a UI mapeia falha de alcance como “rate limit”.

Ajuste no gateway **não resolve** o uso de `http://127.0.0.1:11434/v1` no Cursor. Enriquecemos os logs para, no próximo incidente (ex.: túnel HTTPS), distinguir 429 real vs ausência de tráfego.

## Evidência dos logs

| Fonte | Achado |
|---|---|
| gateway 48h | status só `200` e `404` (discovery); **zero 429** |
| gateway UAs | só Copilot / ollama-js / node — **sem Cursor** |
| gateway `/v1` | só Copilot histórico; **0 em `/v1` nas 3h do erro** |
| headroom / manifest / tier-classifier | sem rate-limit de API ligado ao Cursor |

## Arquivos alterados

| Arquivo | Mudança |
|---|---|
| `packages/gateway/src/request-log.ts` | `gateway.request.start` em paths de inferência; `clientIp`; `respContentType`/`stream`; em 4xx/5xx: `errorType`/`errorCode` + headers `retry-after` / `x-ratelimit-*` (sem logar `message`) |
| `packages/gateway/test/request-log.test.ts` | testes para start/IP/429 content-free + `extractErrorMeta` |
| `docs/connecting-tools.md` | seção Cursor: limitação BYOK/SSRF e workaround (túnel HTTPS) |

## Testes

```text
cd packages/gateway && bun test
103 pass, 0 fail
```

Gateway reconstruído e no ar (`ia-stack-gateway-1`); log de exemplo pós-deploy:

```json
{"event":"gateway.request","method":"GET","path":"/v1/models","status":200,"clientIp":"172.28.1.1","ua":"curl/8.5.0","respContentType":"application/json","auth":"injected-default"}
```

## Como confirmar daqui pra frente

1. Reproduzir o chat no Cursor.
2. `docker logs --since 2m ia-stack-gateway-1 | grep gateway.request`
3. **Sem linhas** → Cursor não alcançou o gateway (SSRF/localhost) — não é rate-limit.
4. **Com `status:429` + `errorType`** → rate-limit real do upstream; agir no manifest/provider.

## Solução para usar o stack no Cursor

Expor `:11434` via **HTTPS público** (Cloudflare Tunnel / ngrok), Base URL = URL do túnel `/v1`, modelo `auto`, chave `mnfst_`.

## Status final

- Causa raiz identificada (fora do gateway).
- Logs enriquecidos + docs + container atualizado.
- Sem merge/commit (não solicitado).

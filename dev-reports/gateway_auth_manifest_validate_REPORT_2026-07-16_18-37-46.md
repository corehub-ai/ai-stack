# Relatório: auth gateway — loopback-only + validação Manifest

**Data:** 2026-07-16 18:37:46  
**Branch:** working tree local (sem commit solicitado)

## Resumo

O gateway agora:
1. **Recusa anônimo fora de loopback** (`127.0.0.1` / `::1`) — `GATEWAY_TRUSTED_CIDRS` é ignorado.
2. **Valida chaves `mnfst_*`** contra o Manifest via `GET {MANIFEST_URL}/v1/models` (sem custo LLM), com cache (60s ok / 5s inválida).

## Alertas / riscos

- Seu `.env` tinha `GATEWAY_TRUSTED_CIDRS=172.28.1.0/24`: isso **liberava de fato** qualquer chamada do host via porta publicada (hairpin → `172.28.1.1`) **sem chave**. Esse bypass acabou.
- `curl http://127.0.0.1:11434/...` **do host** ainda aparece como `172.28.1.1` → **precisa de chave**. Só loopback “de verdade” (processo dentro do container ou network_mode host) injeta `GATEWAY_DEFAULT_KEY`.
- Clientes LAN/Copilot/Ollama que dependiam de anônimo na bridge **quebram** até configurar `mnfst_`.
- Primeira validação de chave paga ~latência de `GET /v1/models` no Manifest; depois entra no cache.

## Arquivos alterados

| Arquivo | Mudança |
|---|---|
| `packages/gateway/src/auth.ts` | Loopback-only anônimo; validação de chave; códigos `gateway_auth` / `gateway_auth_invalid_key` / `gateway_auth_unavailable` |
| `packages/gateway/src/manifest-key.ts` | **Novo** — probe Manifest + cache SHA-256 da chave |
| `packages/gateway/src/index.ts` | Wire do validator; depreca CIDR |
| `packages/gateway/src/config.ts` | `trustedCidrs` marcado deprecated |
| `packages/gateway/src/request-log.ts` | Campo `authValidate` |
| `packages/gateway/test/*` | Auth/manifest-key + stubs; expectativas atualizadas |
| `deploy/compose/docker-compose.yml` | Comentário: CIDR ignorado |
| `README.md`, `docs/connecting-tools.md` | Docs de auth |

## Testes

```text
bun test packages/gateway/test  → 109 pass, 0 fail
bun run typecheck               → ok
```

## Validação ao vivo (pós-rebuild)

| Caso | Resultado |
|---|---|
| Host sem chave → `:11434/v1/models` | `401` `gateway_auth` (`clientIp=172.28.1.1`, `authValidate=reject_anon`) |
| `Bearer mnfst_…` inválida | `401` `gateway_auth_invalid_key` (`authValidate=reject`) |
| Chave `GATEWAY_DEFAULT_KEY` válida (from inside container) | `200`, `authValidate=pass` |

## Status final

Gateway reconstruído e no ar. Sem merge/commit.

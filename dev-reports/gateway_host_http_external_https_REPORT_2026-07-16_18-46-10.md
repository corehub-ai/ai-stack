# Relatório: host HTTP anônimo + HTTPS obrigatório fora do host

**Data:** 2026-07-16 18:46:10  
**Branch:** working tree local (sem commit)

## Resumo

Ajustada a auth do gateway:

| Origem | HTTP | Sem chave | Com `mnfst_*` |
|--------|------|-----------|---------------|
| Host-side (loopback + `GATEWAY_TRUSTED_CIDRS`) | OK | Injeta default | Valida no Manifest |
| Fora do host | **403** sem `X-Forwarded-Proto: https` | **401** (após HTTPS) | Valida (só via proxy TLS) |

SSL continua no proxy externo; o gateway só confia em `X-Forwarded-Proto` / `Forwarded`. Opcional: `GATEWAY_TRUSTED_PROXIES` restringe quem pode afirmar HTTPS.

## Arquivos

- `packages/gateway/src/auth.ts` — host-side + HTTPS externo
- `packages/gateway/src/config.ts` — `trustedProxies`
- `packages/gateway/src/index.ts` — wire
- testes, `docker-compose.yml`, `.env.example`, `README.md`, `docs/connecting-tools.md`

## Testes

`bun test packages/gateway/test` → **111 pass**. `typecheck` ok.

## Ao vivo

- `curl http://127.0.0.1:11434/v1/models` (host, sem chave) → **200**, `authValidate=injected_host`, `clientIp=172.28.1.1`
- chave inválida no host → **401** `gateway_auth_invalid_key`

## Alerta

Seu `.env` tem `GATEWAY_TRUSTED_CIDRS=172.28.1.0/24` (subnet inteira do compose). Isso libera HTTP+anônimo para **todo** container da bridge, não só o hairpin. Mais restrito para “só host”: `172.28.1.1/32` (aí Open WebUI precisa da chave `mnfst_` — já tem). Para o proxy TLS, defina `GATEWAY_TRUSTED_PROXIES` com o IP do Caddy/nginx.

#!/usr/bin/env bash
# validate-gateway.sh — valida a cadeia gateway(:11434) -> headroom -> manifest -> provedor
set -u
cd "$(dirname "$0")/.."
set -a; source ./.env; set +a

GW="http://127.0.0.1:${GATEWAY_HOST_PORT:-11434}"
KEY="${MANIFEST_KEY_OPENCODE:?MANIFEST_KEY_OPENCODE ausente no .env}"
fail=0
say() { printf '%-52s %s\n' "$1" "$2"; }
check() {
  if [ "$2" = "$3" ]; then say "$1" "PASS"; else say "$1" "FAIL (esperado $2, obtido $3)"; fail=1; fi
}

check "GET /health" 200 "$(curl -sS -o /dev/null -w '%{http_code}' $GW/health)"

check "GET /v1/models (com chave)" 200 \
  "$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" $GW/v1/models)"
check "GET /v1/models (sem chave, fora da CIDR confiavel) => 401" 401 \
  "$(curl -sS -o /dev/null -w '%{http_code}' $GW/v1/models)"

body=$(curl -sS -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"auto","max_tokens":16,"messages":[{"role":"user","content":"gateway-validate-openai"}]}' \
  $GW/v1/chat/completions)
echo "$body" | jq -e '.choices[0].message.content' >/dev/null \
  && say "POST /v1/chat/completions" PASS || { say "POST /v1/chat/completions" FAIL; echo "$body" | head -c 300; fail=1; }

curl -sSN -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"auto","stream":true,"max_tokens":16,"messages":[{"role":"user","content":"gateway-validate-stream"}]}' \
  $GW/v1/chat/completions | tail -5 | grep -q '\[DONE\]' \
  && say "streaming SSE com [DONE]" PASS || { say "streaming SSE com [DONE]" FAIL; fail=1; }

code=$(curl -sS -o /tmp/gw_anth.json -w '%{http_code}' \
  -H "Authorization: Bearer $KEY" -H 'anthropic-version: 2023-06-01' -H 'Content-Type: application/json' \
  -d '{"model":"auto","max_tokens":16,"messages":[{"role":"user","content":"gateway-validate-anthropic"}]}' \
  $GW/v1/messages)
check "POST /v1/messages" 200 "$code"

resp=$(curl -sS -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"auto","max_tokens":16,"input":"gateway-validate-responses"}' \
  $GW/v1/responses)
echo "$resp" | jq -e '.object=="response"' >/dev/null \
  && say "POST /v1/responses" PASS || { say "POST /v1/responses" FAIL; echo "$resp" | head -c 300; fail=1; }

exit $fail

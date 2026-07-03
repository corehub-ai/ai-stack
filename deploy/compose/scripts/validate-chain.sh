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

# 1. saude dos servicos
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
  -d '{"model":"auto","messages":[{"role":"user","content":"Responda apenas: openai-leg-ok"}]}' \
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
# prompt distinto do passo 3: o cache semantico do headroom (default on, ver --no-cache)
# e keyed por conteudo, nao por formato/endpoint -- prompt igual faria a perna Anthropic
# devolver (incorretamente) a resposta com forma OpenAI cacheada do passo 3, e vice-versa.
code=$(curl -sS -o /tmp/anth.json -w '%{http_code}' \
  -H "Authorization: Bearer $KEY" -H 'anthropic-version: 2023-06-01' -H 'Content-Type: application/json' \
  -d '{"model":"auto","max_tokens":32,"messages":[{"role":"user","content":"Responda apenas: anthropic-leg-ok"}]}' \
  $HR/v1/messages)
check "POST /v1/messages via headroom" 200 "$code"
[ "$code" = 200 ] && jq -e '.content[0]' /tmp/anth.json >/dev/null \
  && say "corpo Anthropic com content[]" PASS || true

# 6. evidencia de compressao
curl -sS $HR/stats | jq -e 'type=="object"' >/dev/null \
  && { say "headroom /stats acessivel" PASS; curl -sS $HR/stats | jq '.' | head -20; } \
  || { say "headroom /stats acessivel" FAIL; fail=1; }

exit $fail

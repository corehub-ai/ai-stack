#!/usr/bin/env bash
# validate-ollama.sh — valida a superficie Ollama do gateway (:11434 ou override)
set -u
cd "$(dirname "$0")/.."
set -a; source ./.env; set +a

GW="http://127.0.0.1:${GATEWAY_HOST_PORT:-11434}"
KEY="${MANIFEST_KEY_OPENCODE:?MANIFEST_KEY_OPENCODE ausente no .env}"
fail=0
say() { printf '%-50s %s\n' "$1" "$2"; }
check() { if [ "$2" = "$3" ]; then say "$1" "PASS"; else say "$1" "FAIL (esperado $2, obtido $3)"; fail=1; fi; }

# 1. discovery (sem auth)
check "GET / == Ollama is running" "Ollama is running" "$(curl -sS $GW/)"
check "GET /api/version 200" 200 "$(curl -sS -o /dev/null -w '%{http_code}' $GW/api/version)"
curl -sS $GW/api/tags | jq -e '.models[] | select(.name=="auto")' >/dev/null \
  && say "/api/tags lista 'auto'" PASS || { say "/api/tags lista 'auto'" FAIL; fail=1; }
curl -sS -X POST $GW/api/show -d '{"model":"auto"}' | jq -e '.capabilities | index("completion")' >/dev/null \
  && say "/api/show tem capabilities" PASS || { say "/api/show tem capabilities" FAIL; fail=1; }

# 2. /api/chat NDJSON (stream) terminando com done:true
last=$(curl -sSN -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"auto","stream":true,"messages":[{"role":"user","content":"diga oi"}]}' \
  $GW/api/chat | tail -1)
echo "$last" | jq -e '.done==true and .message.role=="assistant"' >/dev/null \
  && say "/api/chat NDJSON done:true" PASS || { say "/api/chat NDJSON done:true" FAIL; echo "$last" | head -c 200; fail=1; }
echo "$last" | jq -e 'has("total_duration") and has("eval_count")' >/dev/null \
  && say "/api/chat chunk final tem stats" PASS || { say "/api/chat chunk final tem stats" FAIL; fail=1; }

# 3. /api/chat nao-streaming
curl -sS -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"auto","stream":false,"messages":[{"role":"user","content":"diga oi"}]}' \
  $GW/api/chat | jq -e '.done==true and (.message.content|type=="string")' >/dev/null \
  && say "/api/chat nao-stream ok" PASS || { say "/api/chat nao-stream ok" FAIL; fail=1; }

# 4. /api/generate stream
gl=$(curl -sSN -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"auto","stream":true,"prompt":"diga oi"}' $GW/api/generate | tail -1)
echo "$gl" | jq -e '.done==true and has("response")' >/dev/null \
  && say "/api/generate NDJSON done:true" PASS || { say "/api/generate NDJSON done:true" FAIL; fail=1; }

# 5. embeddings 501
check "/api/embeddings => 501" 501 \
  "$(curl -sS -o /dev/null -w '%{http_code}' -X POST $GW/api/embeddings -d '{"model":"auto","input":"x"}')"

# 6. superficies da F2 continuam vivas
check "/v1/models (com chave) 200" 200 \
  "$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" $GW/v1/models)"

exit $fail

# F3 — Façade Ollama no Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar ao gateway (`:11434`) a **superfície Ollama** (`GET /`, `/api/version`, `/api/tags`, `/api/show`, `/api/chat`, `/api/generate`, embeddings 501, stubs) traduzindo Ollama ⇄ OpenAI, para que qualquer ferramenta que fale o protocolo Ollama (Open WebUI, extensão Ollama, clientes genéricos) use a mesma cadeia headroom→manifest.

**Architecture:** As rotas `/api/*` são **terminadas no gateway** (nunca encaminhadas ao manifest — lá `/api/*` é a API do dashboard). `/api/chat` e `/api/generate` traduzem o request Ollama → request OpenAI, mandam pro `headroom:8787/v1/chat/completions` (mesma perna OpenAI da F2, com a mesma auth), recebem o SSE OpenAI e traduzem → NDJSON Ollama (um JSON por linha, terminador `"done":true`, durações em **nanossegundos**, `tool_calls.arguments` como **objeto**). Discovery (`tags`/`show`/`version`/`GET /`) é sintetizado de um config estático de pseudo-modelos, sem auth. As superfícies OpenAI/Anthropic da F2 continuam intactas.

**Tech Stack:** Bun + Hono (TypeScript estrito, já no monorepo). Tradutores puros testados com `bun test` contra fixtures capturadas ao vivo do Ollama real (0.31.1) e da cadeia F2. Open WebUI `ghcr.io/open-webui/open-webui:0.6.18` no compose (profile `ui`).

## Global Constraints

- Spec de referência: `docs/superpowers/specs/2026-07-02-ia-stack-design.md` §4.1 (superfícies), §4.2 (tradução `/api/chat`), §4.3 (pseudo-modelos), §3 (Open WebUI). Planos anteriores: F1 `docs/superpowers/plans/2026-07-02-f1-cadeia-compose.md`, F2 `docs/superpowers/plans/2026-07-03-f2-gateway-passthrough.md` (ambos executados — gateway Bun+Hono já roda, passthrough OpenAI+Anthropic validado).
- **`/api/*` NUNCA é encaminhado ao manifest** (spec §4.1, nota crítica): lá esse prefixo é a API interna do dashboard. `/api/chat` e `/api/generate` chamam `headroom:8787/v1/chat/completions`; o resto de `/api/*` é sintetizado/stub no gateway.
- Formato NDJSON de saída (spec §4.2, **confirmado ao vivo 2026-07-03 contra Ollama 0.31.1**): `application/x-ndjson`, um objeto JSON por linha, **sem** prefixo `data:`, **sem** sentinela `[DONE]`; o terminador é a linha com `"done":true`. Durações em **nanossegundos**. `tool_calls[].function.arguments` é **objeto** (não string). `done_reason` é `"stop"` mesmo quando houve tool call (confirmado na fixture real).
- Tradução de tool calling (spec §4.2): OpenAI manda `arguments` como string (pode vir fragmentada em vários deltas — provedores reais fragmentam; o backend Ollado do manifest manda inteiro num delta só) → **acumular** e emitir **um** `tool_calls` com `arguments` parseado pra objeto. Resultado de tool no request Ollama usa `tool_name` (não `tool_call_id`) → mapear pro `tool_call_id` OpenAI a partir dos `tool_calls` do assistant anterior no mesmo array.
- `think` (boolean ou `low|medium|high|max`) → `reasoning_effort` (`max`→`high`). `options` (temperature, top_p, num_predict→max_tokens, stop, seed) → params OpenAI; sem equivalente (num_ctx, keep_alive) → dropar em silêncio.
- Erros (spec §4.2): antes do 1º chunk → HTTP 4xx/5xx `{"error":"..."}`; no meio do stream → linha NDJSON `{"error":"..."}`. HTTP 424 do manifest (fallbacks esgotados) → erro claro.
- **Tolerância SSE-sem-stream (spec §4.2) — deferida na F3**: o manifest pode devolver SSE mesmo com `stream:false` se o tier tiver `response_mode:'stream'`. O tier `default` da nossa cadeia é `buffered` (configurado na F1), então o caminho não-streaming assume JSON. Cobrir esse quirk (detectar `content-type: text/event-stream` na resposta não-streaming e coletar via o tradutor de stream) fica pra quando um tier com stream-mode existir — não bloqueia o aceite da F3.
- Auth (spec §4.4): discovery (`GET /`, `/api/version`, `/api/tags`, `/api/show`) é **sem auth** (Ollama real não tem auth; só expõe a lista de pseudo-modelos, nenhum segredo). Inferência (`/api/chat`, `/api/generate`) passa pelo **mesmo `createAuthMiddleware` da F2** (credencial passa intacta; sem credencial só de loopback/`GATEWAY_TRUSTED_CIDRS` com injeção de `GATEWAY_DEFAULT_KEY`).
- Pseudo-modelos (spec §4.3): config estático mapeia nome→destino. F3 expõe só `auto` (`{model:"auto"}`), com a estrutura pronta pra `corehub-fast`/`corehub-deep` (header `x-manifest-tier`) quando os tiers existirem no manifest. `exposeProviderModels:false`.
- Embeddings fora de escopo (spec D8): `/api/embed`, `/api/embeddings`, `/v1/embeddings` → **501** com mensagem clara.
- **Porta 11434 liberada** (2026-07-03: `ollama.service` nativo desabilitado pelo usuário) → o gateway volta pro padrão documentado `11434` no `.env` local (era `21434` por causa do conflito).
- Versões pinadas (checadas nos registries reais 2026-07-03): `open-webui:0.6.18` (paginei o ghcr até o fim, como no headroom — a 1ª página só mostrava 0.1.x antigas); `hono@4.12.27` (inalterado).
- Rodar testes com `bun test packages/gateway/test` (nunca `bun test packages/gateway` — pega os `.js` compilados em `dist/`). Fixtures capturadas NÃO passam por Biome (`biome.json` já exclui `test/fixtures`).
- Commits frequentes, pt-BR conventional (`feat:`/`fix:`), rodapé `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

## File Structure

- `packages/gateway/src/ollama/types.ts` — tipos TS de request/response Ollama e OpenAI (compartilhados pelos tradutores).
- `packages/gateway/src/ollama/models.ts` — config de pseudo-modelos + `resolveModel()` + `buildTags()`/`buildShow()`.
- `packages/gateway/src/ollama/translate-request.ts` — `ollamaChatToOpenAi()` (request Ollama → request OpenAI).
- `packages/gateway/src/ollama/sse.ts` — parser incremental de linhas SSE OpenAI (helper compartilhado).
- `packages/gateway/src/ollama/translate-chat.ts` — `translateChatNonStream()` + `translateChatStream()` (async gen) + `translateGenerateStream()`/`translateGenerateNonStream()`.
- `packages/gateway/src/routes/ollama.ts` — registra todas as rotas `/api/*` + `GET /`.
- `packages/gateway/src/config.ts` (modificar) — campo `ollamaVersion`.
- `packages/gateway/src/index.ts` (modificar) — montar as rotas Ollama no `buildApp`.
- `deploy/compose/docker-compose.yml` (modificar) — serviço `openwebui` (profile `ui`).
- `deploy/compose/.env` / `.env.example` (modificar) — `GATEWAY_HOST_PORT=11434`, `WEBUI_SECRET_KEY`.
- `deploy/compose/scripts/validate-ollama.sh` (criar) — validação ao vivo da superfície Ollama.
- `docs/connecting-tools.md` (modificar) — seção Open WebUI + clientes Ollama.

---

### Task 1: Tipos + tradução do request (Ollama → OpenAI) + resolução de pseudo-modelos

**Files:**
- Create: `packages/gateway/src/ollama/types.ts`
- Create: `packages/gateway/src/ollama/models.ts`
- Create: `packages/gateway/src/ollama/translate-request.ts`
- Create: `packages/gateway/test/ollama-request.test.ts`

**Interfaces:**
- Produces:
  - Tipos em `types.ts`: `OllamaMessage`, `OllamaToolCall`, `OllamaTool`, `OllamaChatRequest`, `OllamaChatChunk`, `OllamaGenerateChunk`, `OpenAiChatRequest`, `OllamaDurations`, `TranslateCtx`.
  - `resolveModel(name: string): { model: string; headers: Record<string, string> }` em `models.ts`.
  - `ollamaChatToOpenAi(req: OllamaChatRequest): OpenAiChatRequest` em `translate-request.ts` — traduz messages (mapeia `tool_name`→`tool_call_id`, `tool_calls.arguments` objeto→string), `tools`, `options`, `think`; `model` sai como veio (a rota sobrepõe com `resolveModel`).

- [ ] **Step 1: Criar `packages/gateway/src/ollama/types.ts`**

```typescript
// ── Ollama wire types (verificados ao vivo contra Ollama 0.31.1, 2026-07-03) ──
export type OllamaToolCall = {
  id?: string;
  function: { index?: number; name: string; arguments: Record<string, unknown> };
};

export type OllamaMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string; // request-side tool result identifier (não tool_call_id)
  images?: string[];
};

export type OllamaTool = {
  type: "function";
  function: { name: string; description?: string; parameters?: unknown };
};

export type OllamaChatRequest = {
  model: string;
  messages: OllamaMessage[];
  tools?: OllamaTool[];
  stream?: boolean;
  think?: boolean | "low" | "medium" | "high" | "max";
  options?: Record<string, unknown>;
  format?: unknown;
};

export type OllamaGenerateRequest = {
  model: string;
  prompt: string;
  system?: string;
  stream?: boolean;
  think?: boolean | "low" | "medium" | "high" | "max";
  options?: Record<string, unknown>;
};

export type OllamaDurations = {
  total_duration: number;
  load_duration: number;
  prompt_eval_duration: number;
  eval_duration: number;
};

export type OllamaChatChunk = {
  model: string;
  created_at: string;
  message: { role: "assistant"; content: string; tool_calls?: OllamaToolCall[] };
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
};

export type OllamaGenerateChunk = {
  model: string;
  created_at: string;
  response: string;
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
};

// ── OpenAI chat completion request (subconjunto que o gateway monta) ──
export type OpenAiChatRequest = {
  model: string;
  messages: unknown[];
  tools?: unknown[];
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
  seed?: number;
  reasoning_effort?: "low" | "medium" | "high";
};

export type TranslateCtx = {
  model: string;
  createdAt: string;
  durations: OllamaDurations;
  promptEvalCount: number;
  evalCount: number;
};
```

- [ ] **Step 2: Criar `packages/gateway/src/ollama/models.ts` (config + resolveModel)**

```typescript
export type PseudoModel = {
  /** modelo real mandado ao manifest (ou "auto" pra roteamento) */
  model: string;
  /** headers extras (ex.: seleção de tier) — vazio por enquanto */
  headers: Record<string, string>;
  /** metadata pra /api/show */
  contextLength: number;
  capabilities: string[];
};

// F3: só "auto". Estrutura pronta pra corehub-fast/deep (header x-manifest-tier)
// quando os tiers existirem no manifest (spec §4.3).
export const PSEUDO_MODELS: Record<string, PseudoModel> = {
  auto: {
    model: "auto",
    headers: {},
    contextLength: 200000,
    capabilities: ["completion", "tools"],
  },
};

export function resolveModel(name: string): { model: string; headers: Record<string, string> } {
  const pseudo = PSEUDO_MODELS[name];
  if (pseudo) return { model: pseudo.model, headers: pseudo.headers };
  // Nome desconhecido passa direto (cliente pode pedir um id real se o manifest expuser).
  return { model: name, headers: {} };
}
```

- [ ] **Step 3: Escrever `packages/gateway/test/ollama-request.test.ts` (falhando)**

```typescript
import { describe, expect, it } from "bun:test";
import { resolveModel } from "../src/ollama/models.js";
import { ollamaChatToOpenAi } from "../src/ollama/translate-request.js";
import type { OllamaChatRequest } from "../src/ollama/types.js";

describe("resolveModel", () => {
  it("maps the 'auto' pseudo-model to model=auto with no extra headers", () => {
    expect(resolveModel("auto")).toEqual({ model: "auto", headers: {} });
  });
  it("passes an unknown model name through unchanged", () => {
    expect(resolveModel("llama3:8b")).toEqual({ model: "llama3:8b", headers: {} });
  });
});

describe("ollamaChatToOpenAi", () => {
  it("passes plain user/assistant messages through and carries model as-is", () => {
    const req: OllamaChatRequest = {
      model: "auto",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
    };
    const out = ollamaChatToOpenAi(req);
    expect(out.model).toBe("auto");
    expect(out.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
  });

  it("stringifies assistant tool_call arguments (object → JSON string) for OpenAI", () => {
    const req: OllamaChatRequest = {
      model: "auto",
      messages: [
        { role: "user", content: "weather in Paris?" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_1", function: { name: "get_weather", arguments: { city: "Paris" } } }],
        },
      ],
    };
    const out = ollamaChatToOpenAi(req);
    const assistant = out.messages[1] as {
      tool_calls: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
    };
    expect(assistant.tool_calls[0]?.function.arguments).toBe('{"city":"Paris"}');
    expect(assistant.tool_calls[0]?.type).toBe("function");
  });

  it("maps a tool-result message's tool_name to the matching tool_call_id from the prior assistant turn", () => {
    const req: OllamaChatRequest = {
      model: "auto",
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_abc", function: { name: "get_weather", arguments: { city: "Paris" } } }],
        },
        { role: "tool", tool_name: "get_weather", content: "22C" },
      ],
    };
    const out = ollamaChatToOpenAi(req);
    const toolMsg = out.messages[2] as { role: string; tool_call_id: string; content: string };
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.tool_call_id).toBe("call_abc");
    expect(toolMsg.content).toBe("22C");
  });

  it("translates options and think into OpenAI params", () => {
    const req: OllamaChatRequest = {
      model: "auto",
      messages: [{ role: "user", content: "hi" }],
      think: "max",
      options: { temperature: 0.2, top_p: 0.9, num_predict: 128, stop: ["END"], num_ctx: 4096 },
    };
    const out = ollamaChatToOpenAi(req);
    expect(out.temperature).toBe(0.2);
    expect(out.top_p).toBe(0.9);
    expect(out.max_tokens).toBe(128);
    expect(out.stop).toEqual(["END"]);
    expect(out.reasoning_effort).toBe("high"); // max → high
    expect("num_ctx" in out).toBe(false); // sem equivalente → dropado
  });

  it("forwards tools and requests usage in the stream", () => {
    const req: OllamaChatRequest = {
      model: "auto",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } }],
    };
    const out = ollamaChatToOpenAi(req);
    expect(out.stream).toBe(true);
    expect(out.stream_options).toEqual({ include_usage: true });
    expect(out.tools).toHaveLength(1);
  });
});
```

- [ ] **Step 4: Rodar e ver falhar**

Run: `bun test packages/gateway/test/ollama-request.test.ts`
Expected: FAIL — `Cannot find module '../src/ollama/translate-request.js'`.

- [ ] **Step 5: Implementar `packages/gateway/src/ollama/translate-request.ts`**

```typescript
import type { OllamaChatRequest, OllamaMessage, OpenAiChatRequest } from "./types.js";

function thinkToReasoningEffort(
  think: OllamaChatRequest["think"],
): "low" | "medium" | "high" | undefined {
  if (think === undefined || think === false) return undefined;
  if (think === true) return "medium";
  if (think === "max") return "high";
  return think; // "low" | "medium" | "high"
}

function translateMessages(messages: OllamaMessage[]): unknown[] {
  // name → tool_call_id, colhido dos tool_calls dos assistants anteriores,
  // pra remapear as mensagens role:"tool" (que no Ollama usam tool_name).
  const nameToId = new Map<string, string>();

  return messages.map((msg) => {
    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      const tool_calls = msg.tool_calls.map((tc, i) => {
        const id = tc.id ?? `call_${i}`;
        nameToId.set(tc.function.name, id);
        return {
          id,
          type: "function" as const,
          function: { name: tc.function.name, arguments: JSON.stringify(tc.function.arguments) },
        };
      });
      return { role: "assistant", content: msg.content ?? "", tool_calls };
    }

    if (msg.role === "tool") {
      const tool_call_id = msg.tool_name ? (nameToId.get(msg.tool_name) ?? msg.tool_name) : "";
      return { role: "tool", tool_call_id, content: msg.content };
    }

    return { role: msg.role, content: msg.content };
  });
}

export function ollamaChatToOpenAi(req: OllamaChatRequest): OpenAiChatRequest {
  const out: OpenAiChatRequest = {
    model: req.model,
    messages: translateMessages(req.messages),
  };

  if (req.tools && req.tools.length > 0) out.tools = req.tools;
  if (req.stream) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }

  const reasoning = thinkToReasoningEffort(req.think);
  if (reasoning) out.reasoning_effort = reasoning;

  const opts = req.options ?? {};
  if (typeof opts.temperature === "number") out.temperature = opts.temperature;
  if (typeof opts.top_p === "number") out.top_p = opts.top_p;
  if (typeof opts.num_predict === "number") out.max_tokens = opts.num_predict;
  if (typeof opts.seed === "number") out.seed = opts.seed;
  if (Array.isArray(opts.stop)) out.stop = opts.stop as string[];

  return out;
}
```

- [ ] **Step 6: Rodar e ver passar**

Run: `bun test packages/gateway/test/ollama-request.test.ts`
Expected: `9 pass`.

- [ ] **Step 7: Typecheck + lint + commit**

```bash
cd /home/fkmatsuda/workspace/corehub.ia/ia-stack
bun run typecheck && bun run lint
git add packages/gateway/src/ollama/types.ts packages/gateway/src/ollama/models.ts \
  packages/gateway/src/ollama/translate-request.ts packages/gateway/test/ollama-request.test.ts
git commit -m "$(cat <<'EOF'
feat(f3): tipos Ollama + traducao do request (Ollama->OpenAI) + resolveModel

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Parser SSE + tradução da resposta não-streaming (OpenAI → Ollama)

**Files:**
- Create: `packages/gateway/src/ollama/sse.ts`
- Create: `packages/gateway/src/ollama/translate-chat.ts`
- Create: `packages/gateway/test/ollama-nonstream.test.ts`

**Interfaces:**
- Consumes: `types.ts` (Task 1).
- Produces:
  - `parseSseData(line: string): "DONE" | Record<string, unknown> | null` em `sse.ts` — decodifica uma linha SSE (`data: {...}` → objeto; `data: [DONE]` → `"DONE"`; qualquer outra → `null`).
  - `translateChatNonStream(openAiResponse: Record<string, unknown>, ctx: TranslateCtx): OllamaChatChunk` em `translate-chat.ts` — resposta OpenAI não-streaming → chunk Ollama único `done:true`.

- [ ] **Step 1: Escrever `packages/gateway/test/ollama-nonstream.test.ts` (falhando)**

```typescript
import { describe, expect, it } from "bun:test";
import { translateChatNonStream } from "../src/ollama/translate-chat.js";
import type { TranslateCtx } from "../src/ollama/types.js";

const ctx: TranslateCtx = {
  model: "auto",
  createdAt: "2026-07-03T00:00:00Z",
  durations: { total_duration: 1000, load_duration: 100, prompt_eval_duration: 0, eval_duration: 900 },
  promptEvalCount: 0,
  evalCount: 0,
};

describe("translateChatNonStream", () => {
  it("maps content, finish_reason and usage into a single done Ollama chunk", () => {
    const openai = {
      choices: [{ index: 0, message: { role: "assistant", content: "Olá!" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 34, completion_tokens: 12 },
    };
    const chunk = translateChatNonStream(openai, ctx);
    expect(chunk.model).toBe("auto");
    expect(chunk.message.content).toBe("Olá!");
    expect(chunk.done).toBe(true);
    expect(chunk.done_reason).toBe("stop");
    expect(chunk.prompt_eval_count).toBe(34);
    expect(chunk.eval_count).toBe(12);
    expect(chunk.total_duration).toBe(1000);
  });

  it("converts an OpenAI tool_call (arguments string) into an Ollama tool_call (arguments object) and done_reason stop", () => {
    const openai = {
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 154, completion_tokens: 20 },
    };
    const chunk = translateChatNonStream(openai, ctx);
    expect(chunk.done_reason).toBe("stop"); // Ollama usa "stop" mesmo com tool call
    expect(chunk.message.tool_calls?.[0]?.function.name).toBe("get_weather");
    expect(chunk.message.tool_calls?.[0]?.function.arguments).toEqual({ city: "Paris" });
  });

  it("maps finish_reason length to done_reason length", () => {
    const openai = {
      choices: [{ index: 0, message: { role: "assistant", content: "trunc" }, finish_reason: "length" }],
      usage: { prompt_tokens: 5, completion_tokens: 16 },
    };
    expect(translateChatNonStream(openai, ctx).done_reason).toBe("length");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test packages/gateway/test/ollama-nonstream.test.ts`
Expected: FAIL — módulo `translate-chat.js` não existe.

- [ ] **Step 3: Criar `packages/gateway/src/ollama/sse.ts`**

```typescript
// Decodifica uma linha de stream SSE OpenAI.
// "data: {...}"  → objeto parseado
// "data: [DONE]" → "DONE"
// "" / comentário / linha não-data → null
export function parseSseData(line: string): "DONE" | Record<string, unknown> | null {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice("data:".length).trim();
  if (payload.length === 0) return null;
  if (payload === "[DONE]") return "DONE";
  try {
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Criar `packages/gateway/src/ollama/translate-chat.ts` (parte não-streaming)**

```typescript
import type { OllamaChatChunk, OllamaToolCall, TranslateCtx } from "./types.js";

// OpenAI finish_reason → Ollama done_reason. Ollama usa "stop" tanto pra
// parada normal quanto pra tool call (confirmado ao vivo 2026-07-03).
function doneReason(finishReason: unknown): string {
  if (finishReason === "length") return "length";
  return "stop";
}

type OpenAiToolCall = {
  id?: string;
  function?: { name?: string; arguments?: string };
};

function toOllamaToolCalls(raw: unknown): OllamaToolCall[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const calls: OllamaToolCall[] = [];
  raw.forEach((tc, index) => {
    const call = tc as OpenAiToolCall;
    const name = call.function?.name ?? "";
    let args: Record<string, unknown> = {};
    const rawArgs = call.function?.arguments;
    if (typeof rawArgs === "string" && rawArgs.length > 0) {
      try {
        args = JSON.parse(rawArgs) as Record<string, unknown>;
      } catch {
        args = {};
      }
    }
    // exactOptionalPropertyTypes:true — não atribuir id:undefined explícito.
    const toolCall: OllamaToolCall = { function: { index, name, arguments: args } };
    if (typeof call.id === "string") toolCall.id = call.id;
    calls.push(toolCall);
  });
  return calls;
}

export function translateChatNonStream(
  openAiResponse: Record<string, unknown>,
  ctx: TranslateCtx,
): OllamaChatChunk {
  const choices = openAiResponse.choices as Array<Record<string, unknown>> | undefined;
  const choice = choices?.[0] ?? {};
  const message = (choice.message as Record<string, unknown> | undefined) ?? {};
  const usage = (openAiResponse.usage as Record<string, unknown> | undefined) ?? {};

  const content = typeof message.content === "string" ? message.content : "";
  const tool_calls = toOllamaToolCalls(message.tool_calls);

  const promptEvalCount =
    typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : ctx.promptEvalCount;
  const evalCount =
    typeof usage.completion_tokens === "number" ? usage.completion_tokens : ctx.evalCount;

  return {
    model: ctx.model,
    created_at: ctx.createdAt,
    message: tool_calls
      ? { role: "assistant", content, tool_calls }
      : { role: "assistant", content },
    done: true,
    done_reason: doneReason(choice.finish_reason),
    total_duration: ctx.durations.total_duration,
    load_duration: ctx.durations.load_duration,
    prompt_eval_count: promptEvalCount,
    prompt_eval_duration: ctx.durations.prompt_eval_duration,
    eval_count: evalCount,
    eval_duration: ctx.durations.eval_duration,
  };
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `bun test packages/gateway/test/ollama-nonstream.test.ts`
Expected: `3 pass`.

- [ ] **Step 6: Typecheck + lint + commit**

```bash
cd /home/fkmatsuda/workspace/corehub.ia/ia-stack
bun run typecheck && bun run lint
git add packages/gateway/src/ollama/sse.ts packages/gateway/src/ollama/translate-chat.ts \
  packages/gateway/test/ollama-nonstream.test.ts
git commit -m "$(cat <<'EOF'
feat(f3): parser SSE + traducao nao-streaming (OpenAI->Ollama chat)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Tradução do stream (OpenAI SSE → Ollama NDJSON) com acumulação de tool_calls

**Files:**
- Modify: `packages/gateway/src/ollama/translate-chat.ts` (adicionar `translateChatStream`)
- Create: `packages/gateway/test/fixtures/openai-tools-fragmented.sse` (fixture sintética de arguments fragmentado)
- Create: `packages/gateway/test/ollama-stream.test.ts`

**Interfaces:**
- Consumes: `parseSseData` (Task 2), `types.ts`.
- Produces: `translateChatStream(lines: AsyncIterable<string>, ctx: TranslateCtx): AsyncGenerator<OllamaChatChunk>` — consome linhas SSE OpenAI e emite chunks Ollama: um por delta de conteúdo (`done:false`), acumula tool_calls (arguments fragmentado ou não) e emite o chunk final `done:true` com tool_calls parseados + durações/contagens.

- [ ] **Step 1: Criar a fixture sintética de arguments fragmentado**

Provedores OpenAI/Anthropic reais fragmentam o `arguments` em vários deltas (o backend Ollama do manifest não — manda inteiro). O tradutor precisa acumular. Esta fixture representa o caso fragmentado.

Criar `packages/gateway/test/fixtures/openai-tools-fragmented.sse` com exatamente este conteúdo:

```
data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"","tool_calls":[{"id":"call_frag","index":0,"type":"function","function":{"name":"get_weather","arguments":"{\"ci"}}]},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\":\"Pa"}}]},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ris\"}"}}]},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

data: {"choices":[],"usage":{"prompt_tokens":154,"completion_tokens":20,"total_tokens":174}}

data: [DONE]
```

- [ ] **Step 2: Escrever `packages/gateway/test/ollama-stream.test.ts` (falhando)**

```typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { translateChatStream } from "../src/ollama/translate-chat.js";
import type { OllamaChatChunk, TranslateCtx } from "../src/ollama/types.js";

const ctx: TranslateCtx = {
  model: "auto",
  createdAt: "2026-07-03T00:00:00Z",
  durations: { total_duration: 1000, load_duration: 100, prompt_eval_duration: 0, eval_duration: 900 },
  promptEvalCount: 0,
  evalCount: 0,
};

async function* linesOf(text: string): AsyncGenerator<string> {
  for (const line of text.split("\n")) yield line;
}

async function collect(text: string): Promise<OllamaChatChunk[]> {
  const chunks: OllamaChatChunk[] = [];
  for await (const chunk of translateChatStream(linesOf(text), ctx)) chunks.push(chunk);
  return chunks;
}

describe("translateChatStream", () => {
  it("emits one chunk per content delta plus a final done chunk with usage counts", async () => {
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Oi"},"finish_reason":null}]}',
      'data: {"choices":[{"index":0,"delta":{"content":" mundo"},"finish_reason":null}]}',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}',
      "data: [DONE]",
    ].join("\n");
    const chunks = await collect(sse);
    const contentChunks = chunks.filter((c) => !c.done);
    expect(contentChunks.map((c) => c.message.content)).toEqual(["Oi", " mundo"]);
    const final = chunks[chunks.length - 1];
    expect(final?.done).toBe(true);
    expect(final?.done_reason).toBe("stop");
    expect(final?.prompt_eval_count).toBe(10);
    expect(final?.eval_count).toBe(2);
    expect(final?.message.content).toBe("");
  });

  it("accumulates tool_call arguments fragmented across deltas into a single object", async () => {
    const sse = readFileSync(
      join(import.meta.dir, "fixtures", "openai-tools-fragmented.sse"),
      "utf8",
    );
    const chunks = await collect(sse);
    const final = chunks[chunks.length - 1];
    expect(final?.done).toBe(true);
    expect(final?.done_reason).toBe("stop");
    expect(final?.message.tool_calls?.[0]?.function.name).toBe("get_weather");
    expect(final?.message.tool_calls?.[0]?.function.arguments).toEqual({ city: "Paris" });
  });

  it("handles a single-delta tool_call (Ollama backend shape) too", async () => {
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"","tool_calls":[{"id":"call_1","index":0,"type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Paris\\"}"}}]},"finish_reason":null}]}',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
    ].join("\n");
    const chunks = await collect(sse);
    const final = chunks[chunks.length - 1];
    expect(final?.message.tool_calls?.[0]?.function.arguments).toEqual({ city: "Paris" });
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `bun test packages/gateway/test/ollama-stream.test.ts`
Expected: FAIL — `translateChatStream` não existe.

- [ ] **Step 4: Adicionar `translateChatStream` ao fim de `packages/gateway/src/ollama/translate-chat.ts`**

Adicionar os imports que faltam no topo (`parseSseData`) e a função no fim do arquivo:

```typescript
// (no topo do arquivo, junto aos imports existentes)
import { parseSseData } from "./sse.js";
```

```typescript
// (adicionar ao fim do arquivo)
type ToolAccumulator = { id?: string; name: string; argsBuffer: string };

function buildAccumulatedToolCalls(acc: Map<number, ToolAccumulator>): OllamaToolCall[] | undefined {
  if (acc.size === 0) return undefined;
  const calls: OllamaToolCall[] = [];
  for (const [index, tool] of [...acc.entries()].sort((a, b) => a[0] - b[0])) {
    let args: Record<string, unknown> = {};
    if (tool.argsBuffer.length > 0) {
      try {
        args = JSON.parse(tool.argsBuffer) as Record<string, unknown>;
      } catch {
        args = {};
      }
    }
    calls.push({ id: tool.id, function: { index, name: tool.name, arguments: args } });
  }
  return calls;
}

export async function* translateChatStream(
  lines: AsyncIterable<string>,
  ctx: TranslateCtx,
): AsyncGenerator<OllamaChatChunk> {
  const toolAcc = new Map<number, ToolAccumulator>();
  let finishReason: unknown = null;
  let promptEvalCount = ctx.promptEvalCount;
  let evalCount = ctx.evalCount;

  for await (const line of lines) {
    const parsed = parseSseData(line);
    if (parsed === null) continue;
    if (parsed === "DONE") break;

    const usage = parsed.usage as Record<string, unknown> | undefined;
    if (usage) {
      if (typeof usage.prompt_tokens === "number") promptEvalCount = usage.prompt_tokens;
      if (typeof usage.completion_tokens === "number") evalCount = usage.completion_tokens;
    }

    const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    if (!choice) continue;

    if (choice.finish_reason != null) finishReason = choice.finish_reason;

    const delta = (choice.delta as Record<string, unknown> | undefined) ?? {};

    const deltaTools = delta.tool_calls as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(deltaTools)) {
      for (const raw of deltaTools) {
        const index = typeof raw.index === "number" ? raw.index : 0;
        const fn = (raw.function as Record<string, unknown> | undefined) ?? {};
        const existing = toolAcc.get(index) ?? { name: "", argsBuffer: "" };
        if (typeof raw.id === "string") existing.id = raw.id;
        if (typeof fn.name === "string") existing.name = fn.name;
        if (typeof fn.arguments === "string") existing.argsBuffer += fn.arguments;
        toolAcc.set(index, existing);
      }
    }

    const content = delta.content;
    if (typeof content === "string" && content.length > 0) {
      yield {
        model: ctx.model,
        created_at: ctx.createdAt,
        message: { role: "assistant", content },
        done: false,
      };
    }
  }

  const tool_calls = buildAccumulatedToolCalls(toolAcc);
  yield {
    model: ctx.model,
    created_at: ctx.createdAt,
    message: tool_calls
      ? { role: "assistant", content: "", tool_calls }
      : { role: "assistant", content: "" },
    done: true,
    done_reason: doneReason(finishReason),
    total_duration: ctx.durations.total_duration,
    load_duration: ctx.durations.load_duration,
    prompt_eval_count: promptEvalCount,
    prompt_eval_duration: ctx.durations.prompt_eval_duration,
    eval_count: evalCount,
    eval_duration: ctx.durations.eval_duration,
  };
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `bun test packages/gateway/test/ollama-stream.test.ts`
Expected: `3 pass`.

- [ ] **Step 6: Rodar a suíte inteira (garantir que nada quebrou)**

Run: `bun test packages/gateway/test`
Expected: tudo verde (F2 32 + F3 até aqui).

- [ ] **Step 7: Typecheck + lint + commit**

```bash
cd /home/fkmatsuda/workspace/corehub.ia/ia-stack
bun run typecheck && bun run lint
git add packages/gateway/src/ollama/translate-chat.ts \
  packages/gateway/test/fixtures/openai-tools-fragmented.sse packages/gateway/test/ollama-stream.test.ts
git commit -m "$(cat <<'EOF'
feat(f3): traducao do stream OpenAI SSE -> Ollama NDJSON (acumula tool_calls)

Fixture sintetica cobre arguments fragmentado em varios deltas (o caso dos
provedores reais); o backend Ollama do manifest manda inteiro num delta so,
tambem coberto. done_reason mapeia tool_calls->stop (comportamento real do
Ollama verificado 2026-07-03).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Rotas de discovery (`GET /`, version, tags, show) + embeddings 501 + stubs

**Files:**
- Modify: `packages/gateway/src/ollama/models.ts` (adicionar `buildTags`, `buildShow`)
- Modify: `packages/gateway/src/config.ts` (campo `ollamaVersion`)
- Create: `packages/gateway/src/routes/ollama.ts` (só discovery/stubs nesta task; chat/generate na Task 5)
- Create: `packages/gateway/test/ollama-discovery.test.ts`
- Modify: `packages/gateway/test/config.test.ts` (assert do novo default)

**Interfaces:**
- Consumes: `PSEUDO_MODELS` (Task 1), `GatewayConfig`.
- Produces:
  - `buildTags(): { models: unknown[] }` e `buildShow(model: string): Record<string, unknown> | null` em `models.ts`.
  - `registerOllamaRoutes(app: Hono<AuthEnv>, config: GatewayConfig): void` em `routes/ollama.ts` — nesta task só as rotas de discovery + embeddings 501 + stubs (as de inferência entram na Task 5, na mesma função).
  - `config.ollamaVersion: string` (default `"0.31.1"`).

- [ ] **Step 1: Adicionar `ollamaVersion` ao `loadConfig` e ao tipo**

Em `packages/gateway/src/config.ts`, adicionar o campo ao tipo `GatewayConfig` (logo após `corsOrigins`):

```typescript
  corsOrigins: string[];
  ollamaVersion: string;
```

E no objeto retornado por `loadConfig` (após `corsOrigins: splitList(...)`):

```typescript
    corsOrigins: splitList(env.GATEWAY_CORS_ORIGINS),
    ollamaVersion: env.GATEWAY_OLLAMA_VERSION ?? "0.31.1",
```

- [ ] **Step 2: Atualizar `packages/gateway/test/config.test.ts` pro novo default**

No teste `"applies documented defaults when env is empty"`, adicionar a asserção (logo após `expect(config.corsOrigins).toEqual([]);`):

```typescript
    expect(config.ollamaVersion).toBe("0.31.1");
```

- [ ] **Step 3: Escrever `packages/gateway/test/ollama-discovery.test.ts` (falhando)**

```typescript
import { describe, expect, it } from "bun:test";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/index.js";

function app() {
  return buildApp(loadConfig({ GATEWAY_OLLAMA_VERSION: "0.31.1" }));
}

describe("Ollama discovery surface", () => {
  it("GET / returns the Ollama banner", async () => {
    const res = await app().request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Ollama is running");
  });

  it("HEAD / returns 200", async () => {
    const res = await app().request("/", { method: "HEAD" });
    expect(res.status).toBe(200);
  });

  it("GET /api/version returns the configured version", async () => {
    const res = await app().request("/api/version");
    expect(res.status).toBe(200);
    expect((await res.json()) as { version: string }).toEqual({ version: "0.31.1" });
  });

  it("GET /api/tags lists the pseudo-models with Ollama-shaped entries", async () => {
    const res = await app().request("/api/tags");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: Array<{ name: string; model: string; details: unknown }> };
    expect(body.models.some((m) => m.name === "auto")).toBe(true);
    const auto = body.models.find((m) => m.name === "auto");
    expect(auto?.model).toBe("auto");
    expect(auto?.details).toBeDefined();
  });

  it("POST /api/show returns capabilities and context_length for a known model", async () => {
    const res = await app().request("/api/show", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { capabilities: string[]; model_info: Record<string, number> };
    expect(body.capabilities).toContain("completion");
    expect(body.model_info["general.context_length"]).toBeGreaterThan(0);
  });

  it("POST /api/show 404s for an unknown model", async () => {
    const res = await app().request("/api/show", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "nope:1b" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /api/embeddings returns 501 (embeddings out of scope)", async () => {
    const res = await app().request("/api/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", input: "hi" }),
    });
    expect(res.status).toBe(501);
  });

  it("GET /api/ps returns an empty running-models list", async () => {
    const res = await app().request("/api/ps");
    expect(res.status).toBe(200);
    expect((await res.json()) as { models: unknown[] }).toEqual({ models: [] });
  });
});
```

- [ ] **Step 4: Rodar e ver falhar**

Run: `bun test packages/gateway/test/ollama-discovery.test.ts`
Expected: FAIL — as rotas `/api/*` ainda não existem (retornam 404 do Hono).

- [ ] **Step 5: Adicionar `buildTags`/`buildShow` a `packages/gateway/src/ollama/models.ts`**

```typescript
// (adicionar ao fim de models.ts)

// Data fixa e determinística pros campos que o Ollama real preencheria com
// metadata do arquivo GGUF — clientes só precisam de name/model/details.
const SYNTHETIC_MODIFIED_AT = "2026-07-03T00:00:00Z";

export function buildTags(): { models: unknown[] } {
  const models = Object.entries(PSEUDO_MODELS).map(([name, meta]) => ({
    name,
    model: name,
    modified_at: SYNTHETIC_MODIFIED_AT,
    size: 0,
    digest: "",
    details: {
      parent_model: "",
      format: "gguf",
      family: "corehub",
      families: ["corehub"],
      parameter_size: "",
      quantization_level: "",
      context_length: meta.contextLength,
    },
    capabilities: meta.capabilities,
  }));
  return { models };
}

export function buildShow(model: string): Record<string, unknown> | null {
  const meta = PSEUDO_MODELS[model];
  if (!meta) return null;
  return {
    capabilities: meta.capabilities,
    details: {
      parent_model: "",
      format: "gguf",
      family: "corehub",
      families: ["corehub"],
      parameter_size: "",
      quantization_level: "",
    },
    model_info: {
      "general.architecture": "corehub",
      // ambas as chaves: clientes olham ora "general.context_length",
      // ora "<arch>.context_length" (formato real do Ollama)
      "general.context_length": meta.contextLength,
      "corehub.context_length": meta.contextLength,
    },
    modified_at: SYNTHETIC_MODIFIED_AT,
  };
}
```

- [ ] **Step 6: Criar `packages/gateway/src/routes/ollama.ts` (discovery + stubs)**

```typescript
import type { Hono } from "hono";
import type { AuthEnv } from "../auth.js";
import type { GatewayConfig } from "../config.js";
import { buildShow, buildTags } from "../ollama/models.js";

const EMBEDDINGS_501 = {
  error: {
    message:
      "Embeddings are out of scope for this gateway (spec D8). Point embedding clients at a dedicated embeddings backend.",
    type: "not_implemented",
    code: "embeddings_unsupported",
  },
};

export function registerOllamaRoutes(app: Hono<AuthEnv>, config: GatewayConfig): void {
  // Banner que os clientes Ollama usam pra detectar o servidor.
  app.on(["GET", "HEAD"], "/", (c) => c.text("Ollama is running"));

  app.get("/api/version", (c) => c.json({ version: config.ollamaVersion }));

  app.get("/api/tags", (c) => c.json(buildTags()));

  app.post("/api/show", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { model?: string };
    const show = body.model ? buildShow(body.model) : null;
    if (!show) return c.json({ error: `model '${body.model ?? ""}' not found` }, 404);
    return c.json(show);
  });

  // Embeddings fora de escopo (spec D8).
  app.post("/api/embed", (c) => c.json(EMBEDDINGS_501, 501));
  app.post("/api/embeddings", (c) => c.json(EMBEDDINGS_501, 501));
  app.post("/v1/embeddings", (c) => c.json(EMBEDDINGS_501, 501));

  // Stubs de gerência de modelo (o gateway não gerencia pesos).
  app.get("/api/ps", (c) => c.json({ models: [] }));
  app.post("/api/pull", (c) => c.body('{"status":"success"}\n', 200, { "content-type": "application/x-ndjson" }));
  app.post("/api/push", (c) => c.body('{"status":"success"}\n', 200, { "content-type": "application/x-ndjson" }));
  app.post("/api/create", (c) => c.body('{"status":"success"}\n', 200, { "content-type": "application/x-ndjson" }));
  app.post("/api/copy", (c) => c.body("", 200));
  app.delete("/api/delete", (c) => c.body("", 200));
  // blobs: o gateway não guarda pesos — HEAD sempre "não tenho", POST aceita e descarta.
  app.on("HEAD", "/api/blobs/:digest", (c) => c.body("", 404));
  app.post("/api/blobs/:digest", (c) => c.body("", 201));
}
```

- [ ] **Step 7: Montar as rotas Ollama no `buildApp`**

Em `packages/gateway/src/index.ts`, importar e registrar (as discovery ANTES do middleware de auth do `/v1/*` não importa, mas registrar `registerOllamaRoutes` depois das rotas OpenAI/Anthropic mantém tudo junto). Adicionar o import:

```typescript
import { registerOllamaRoutes } from "./routes/ollama.js";
```

E dentro de `buildApp`, após `registerAnthropicRoutes(app, config);`:

```typescript
  registerOllamaRoutes(app, config);
```

- [ ] **Step 8: Rodar e ver passar**

Run: `bun test packages/gateway/test/ollama-discovery.test.ts packages/gateway/test/config.test.ts`
Expected: tudo verde (8 discovery + 3 config).

- [ ] **Step 9: Typecheck + lint + commit**

```bash
cd /home/fkmatsuda/workspace/corehub.ia/ia-stack
bun run typecheck && bun run lint
git add packages/gateway/src/ollama/models.ts packages/gateway/src/config.ts \
  packages/gateway/src/routes/ollama.ts packages/gateway/src/index.ts \
  packages/gateway/test/ollama-discovery.test.ts packages/gateway/test/config.test.ts
git commit -m "$(cat <<'EOF'
feat(f3): discovery Ollama (GET /, version, tags, show) + embeddings 501 + stubs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `/api/chat` + `/api/generate` (proxy pela cadeia + tradução) + auth

**Files:**
- Modify: `packages/gateway/src/ollama/translate-chat.ts` (adicionar tradutores de `generate`)
- Modify: `packages/gateway/src/routes/ollama.ts` (adicionar `/api/chat`, `/api/generate` + auth)
- Modify: `packages/gateway/src/index.ts` (auth middleware pra `/api/chat` e `/api/generate`)
- Create: `packages/gateway/test/ollama-generate.test.ts`
- Create: `packages/gateway/test/ollama-chat-route.test.ts`

**Interfaces:**
- Consumes: `ollamaChatToOpenAi` (T1), `translateChatNonStream`/`translateChatStream` (T2/T3), `resolveModel` (T1), `proxyHeaders` (F2), `startMockUpstream` (F2), `parseSseData` (T2).
- Produces:
  - `translateGenerateNonStream(openAiResponse, ctx): OllamaGenerateChunk` e `translateGenerateStream(lines, ctx): AsyncGenerator<OllamaGenerateChunk>` em `translate-chat.ts`.
  - Rotas `POST /api/chat` e `POST /api/generate` em `routes/ollama.ts` (streaming NDJSON e não-streaming), passando por `headroom/v1/chat/completions`.

- [ ] **Step 1: Escrever `packages/gateway/test/ollama-generate.test.ts` (falhando)**

```typescript
import { describe, expect, it } from "bun:test";
import { translateGenerateNonStream, translateGenerateStream } from "../src/ollama/translate-chat.js";
import type { OllamaGenerateChunk, TranslateCtx } from "../src/ollama/types.js";

const ctx: TranslateCtx = {
  model: "auto",
  createdAt: "2026-07-03T00:00:00Z",
  durations: { total_duration: 1000, load_duration: 100, prompt_eval_duration: 0, eval_duration: 900 },
  promptEvalCount: 0,
  evalCount: 0,
};

async function* linesOf(text: string): AsyncGenerator<string> {
  for (const line of text.split("\n")) yield line;
}

describe("translateGenerate", () => {
  it("maps a non-streaming OpenAI response into an Ollama generate chunk (response field)", () => {
    const openai = {
      choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    };
    const chunk = translateGenerateNonStream(openai, ctx);
    expect(chunk.response).toBe("hello");
    expect(chunk.done).toBe(true);
    expect(chunk.done_reason).toBe("stop");
    expect(chunk.eval_count).toBe(1);
  });

  it("streams content deltas as `response` chunks plus a final done chunk", async () => {
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"content":"he"},"finish_reason":null}]}',
      'data: {"choices":[{"index":0,"delta":{"content":"llo"},"finish_reason":null}]}',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
      "data: [DONE]",
    ].join("\n");
    const chunks: OllamaGenerateChunk[] = [];
    for await (const c of translateGenerateStream(linesOf(sse), ctx)) chunks.push(c);
    const nonDone = chunks.filter((c) => !c.done);
    expect(nonDone.map((c) => c.response)).toEqual(["he", "llo"]);
    expect(chunks[chunks.length - 1]?.done).toBe(true);
    expect(chunks[chunks.length - 1]?.eval_count).toBe(2);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test packages/gateway/test/ollama-generate.test.ts`
Expected: FAIL — `translateGenerateNonStream` não existe.

- [ ] **Step 3: Adicionar tradutores de generate ao fim de `translate-chat.ts`**

```typescript
// (adicionar ao fim de translate-chat.ts; precisa dos imports OllamaGenerateChunk)
// No import de tipos do topo, incluir OllamaGenerateChunk:
//   import type { OllamaChatChunk, OllamaGenerateChunk, OllamaToolCall, TranslateCtx } from "./types.js";

// exactOptionalPropertyTypes:true não deixa copiar `x: chat.done_reason`
// (string|undefined) num literal cujo campo é opcional → helper que copia
// só os campos definidos (sempre presentes num chunk done).
type DoneStats = Pick<
  OllamaChatChunk,
  | "done_reason"
  | "total_duration"
  | "load_duration"
  | "prompt_eval_count"
  | "prompt_eval_duration"
  | "eval_count"
  | "eval_duration"
>;

function applyStats<T extends DoneStats>(target: T, source: DoneStats): T {
  if (source.done_reason !== undefined) target.done_reason = source.done_reason;
  if (source.total_duration !== undefined) target.total_duration = source.total_duration;
  if (source.load_duration !== undefined) target.load_duration = source.load_duration;
  if (source.prompt_eval_count !== undefined) target.prompt_eval_count = source.prompt_eval_count;
  if (source.prompt_eval_duration !== undefined)
    target.prompt_eval_duration = source.prompt_eval_duration;
  if (source.eval_count !== undefined) target.eval_count = source.eval_count;
  if (source.eval_duration !== undefined) target.eval_duration = source.eval_duration;
  return target;
}

export function translateGenerateNonStream(
  openAiResponse: Record<string, unknown>,
  ctx: TranslateCtx,
): OllamaGenerateChunk {
  const chat = translateChatNonStream(openAiResponse, ctx);
  const out: OllamaGenerateChunk = {
    model: chat.model,
    created_at: chat.created_at,
    response: chat.message.content,
    done: true,
  };
  return applyStats(out, chat);
}

export async function* translateGenerateStream(
  lines: AsyncIterable<string>,
  ctx: TranslateCtx,
): AsyncGenerator<OllamaGenerateChunk> {
  for await (const chunk of translateChatStream(lines, ctx)) {
    if (!chunk.done) {
      yield {
        model: chunk.model,
        created_at: chunk.created_at,
        response: chunk.message.content,
        done: false,
      };
    } else {
      const out: OllamaGenerateChunk = {
        model: chunk.model,
        created_at: chunk.created_at,
        response: "",
        done: true,
      };
      yield applyStats(out, chunk);
    }
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun test packages/gateway/test/ollama-generate.test.ts`
Expected: `2 pass`.

- [ ] **Step 5: Escrever `packages/gateway/test/ollama-chat-route.test.ts` (falhando)**

Reusa o `startMockUpstream` da F2, servindo uma fixture SSE OpenAI, e verifica que `/api/chat` devolve NDJSON Ollama.

```typescript
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { type AuthEnv, createAuthMiddleware } from "../src/auth.js";
import type { GatewayConfig } from "../src/config.js";
import { registerOllamaRoutes } from "../src/routes/ollama.js";
import { startMockUpstream } from "./support/mock-upstream.js";

function buildApp(headroomUrl: string) {
  const config: GatewayConfig = {
    port: 0,
    headroomUrl,
    manifestUrl: "http://unused:2099",
    trustedCidrs: [],
    defaultKey: "mnfst_default",
    corsOrigins: [],
    ollamaVersion: "0.31.1",
  };
  const app = new Hono<AuthEnv>();
  app.use("/api/chat", createAuthMiddleware(config));
  app.use("/api/generate", createAuthMiddleware(config));
  registerOllamaRoutes(app, config);
  return app;
}

describe("POST /api/chat", () => {
  it("translates the OpenAI SSE stream into Ollama NDJSON terminated by done:true", async () => {
    const upstream = startMockUpstream("chat-completions-stream");
    try {
      const app = buildApp(upstream.url);
      const res = await app.request(
        "/api/chat",
        {
          method: "POST",
          headers: { authorization: "Bearer mnfst_opencode", "content-type": "application/json" },
          body: JSON.stringify({ model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] }),
        },
        { ip: "127.0.0.1" },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/x-ndjson");
      const text = await res.text();
      const lines = text.trim().split("\n").filter(Boolean);
      const last = JSON.parse(lines[lines.length - 1] ?? "{}") as { done: boolean; message: { role: string } };
      expect(last.done).toBe(true);
      expect(last.message.role).toBe("assistant");
      // nenhuma linha tem prefixo data: nem sentinela [DONE]
      expect(text.includes("data:")).toBe(false);
      expect(text.includes("[DONE]")).toBe(false);
    } finally {
      upstream.stop();
    }
  });

  it("401s a credential-less caller from outside the trusted set", async () => {
    const upstream = startMockUpstream("chat-completions-stream");
    try {
      const app = buildApp(upstream.url);
      const res = await app.request(
        "/api/chat",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
        },
        { ip: "203.0.113.9" },
      );
      expect(res.status).toBe(401);
    } finally {
      upstream.stop();
    }
  });
});
```

- [ ] **Step 6: Rodar e ver falhar**

Run: `bun test packages/gateway/test/ollama-chat-route.test.ts`
Expected: FAIL — `/api/chat` ainda não existe (404) ou a resposta não é NDJSON.

- [ ] **Step 7: Adicionar `/api/chat` e `/api/generate` a `routes/ollama.ts`**

Adicionar os imports no topo:

```typescript
import { proxyHeaders } from "../proxy-headers.js";
import { ollamaChatToOpenAi } from "../ollama/translate-request.js";
import { resolveModel } from "../ollama/models.js";
import {
  translateChatNonStream,
  translateChatStream,
  translateGenerateNonStream,
  translateGenerateStream,
} from "../ollama/translate-chat.js";
import type {
  OllamaChatChunk,
  OllamaChatRequest,
  OllamaGenerateChunk,
  OllamaGenerateRequest,
  OpenAiChatRequest,
  TranslateCtx,
} from "../ollama/types.js";
```

Adicionar estes helpers e rotas dentro de `registerOllamaRoutes` (após os stubs):

```typescript
  app.post("/api/chat", (c) => handleOllamaInference(c, config, "chat"));
  app.post("/api/generate", (c) => handleOllamaInference(c, config, "generate"));
}

// ── helpers de inferência ────────────────────────────────────────────────

const NS_PER_MS = 1_000_000;

async function* readSseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        yield buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
    }
    if (buffer.length > 0) yield buffer;
  } finally {
    reader.releaseLock();
  }
}

function makeCtx(model: string, startMs: number): TranslateCtx {
  const totalNs = Math.max(1, Math.round((performance.now() - startMs) * NS_PER_MS));
  const loadNs = Math.min(totalNs, Math.round(50 * NS_PER_MS));
  return {
    model,
    createdAt: new Date().toISOString(),
    durations: {
      total_duration: totalNs,
      load_duration: loadNs,
      prompt_eval_duration: 0,
      eval_duration: Math.max(1, totalNs - loadNs),
    },
    promptEvalCount: 0,
    evalCount: 0,
  };
}

type Mode = "chat" | "generate";

// biome-ignore lint/suspicious/noExplicitAny: Hono Context genérico simplifica os dois modos
async function handleOllamaInference(c: any, config: GatewayConfig, mode: Mode): Promise<Response> {
  const startMs = performance.now();
  const raw = (await c.req.json().catch(() => null)) as
    | (OllamaChatRequest & OllamaGenerateRequest)
    | null;
  if (!raw || typeof raw.model !== "string") {
    return c.json({ error: "invalid request body" }, 400);
  }

  const stream = raw.stream !== false; // Ollama faz stream por padrão
  const resolved = resolveModel(raw.model);

  let openAiBody: OpenAiChatRequest;
  if (mode === "generate") {
    const messages: OllamaChatRequest["messages"] = [];
    if (typeof raw.system === "string" && raw.system.length > 0) {
      messages.push({ role: "system", content: raw.system });
    }
    messages.push({ role: "user", content: raw.prompt ?? "" });
    openAiBody = ollamaChatToOpenAi({
      model: raw.model,
      messages,
      stream,
      ...(raw.think !== undefined ? { think: raw.think } : {}),
      ...(raw.options ? { options: raw.options } : {}),
    });
  } else {
    openAiBody = ollamaChatToOpenAi({ ...raw, stream });
  }
  openAiBody.model = resolved.model;
  if (stream) openAiBody.stream_options = { include_usage: true };

  const headers: Record<string, string> = { ...proxyHeaders(c), ...resolved.headers };
  headers["content-type"] = "application/json";
  delete headers["content-length"];

  const upstream = await fetch(`${config.headroomUrl}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(openAiBody),
  });

  // Erro antes do 1º chunk → repassa status + corpo de erro (semântica Ollama).
  if (!upstream.ok) {
    const errText = await upstream.text();
    return c.json({ error: errText || `upstream ${upstream.status}` }, upstream.status);
  }

  if (!stream) {
    const json = (await upstream.json()) as Record<string, unknown>;
    const ctx = makeCtx(resolved.model, startMs);
    const out =
      mode === "generate"
        ? translateGenerateNonStream(json, ctx)
        : translateChatNonStream(json, ctx);
    return c.json(out);
  }

  const body = upstream.body;
  if (!body) return c.json({ error: "empty upstream stream" }, 502);

  const ndjson = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const ctx = makeCtx(resolved.model, startMs);
      try {
        const lines = readSseLines(body);
        const gen =
          mode === "generate" ? translateGenerateStream(lines, ctx) : translateChatStream(lines, ctx);
        for await (const chunk of gen as AsyncGenerator<OllamaChatChunk | OllamaGenerateChunk>) {
          controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`));
        }
      } catch (err) {
        // Falha no meio do stream → linha de erro NDJSON (semântica Ollama).
        const msg = err instanceof Error ? err.message : String(err);
        controller.enqueue(encoder.encode(`${JSON.stringify({ error: msg })}\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(ndjson, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}
```

Remover a chave `}` extra que fechava `registerOllamaRoutes` antes (agora as rotas chat/generate estão dentro dela e os helpers ficam no escopo de módulo, fora da função). Conferir que `registerOllamaRoutes` fecha logo após a linha `app.post("/api/generate", ...)`.

- [ ] **Step 8: Aplicar o auth middleware às rotas de inferência no `buildApp`**

Em `packages/gateway/src/index.ts`, antes de `registerOllamaRoutes(app, config);`, adicionar:

```typescript
  app.use("/api/chat", createAuthMiddleware(config));
  app.use("/api/generate", createAuthMiddleware(config));
```

(As rotas de discovery continuam sem auth — o middleware só cobre esses dois paths.)

- [ ] **Step 9: Rodar e ver passar**

Run: `bun test packages/gateway/test/ollama-chat-route.test.ts packages/gateway/test/ollama-generate.test.ts`
Expected: tudo verde.

- [ ] **Step 10: Rodar a suíte inteira + typecheck + lint**

Run: `cd /home/fkmatsuda/workspace/corehub.ia/ia-stack && bun test packages/gateway/test && bun run typecheck && bun run lint`
Expected: tudo verde. Se o Biome reclamar do `// biome-ignore` mal posicionado, ajustar a posição do comentário pra imediatamente antes da linha da função.

- [ ] **Step 11: Commit**

```bash
git add packages/gateway/src/ollama/translate-chat.ts packages/gateway/src/routes/ollama.ts \
  packages/gateway/src/index.ts packages/gateway/test/ollama-generate.test.ts \
  packages/gateway/test/ollama-chat-route.test.ts
git commit -m "$(cat <<'EOF'
feat(f3): /api/chat + /api/generate (proxy pela cadeia + traducao NDJSON) + auth

Inferencia Ollama passa por headroom/v1/chat/completions (mesma perna e
auth da F2); discovery continua sem auth. Streaming real via ReadableStream
lendo o SSE upstream linha a linha. Erro antes do 1o chunk -> status+corpo;
erro no meio -> linha NDJSON {"error":...} (semantica Ollama).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Porta 11434 + validação ao vivo da superfície Ollama

**Files:**
- Modify: `deploy/compose/.env` (local — `GATEWAY_HOST_PORT=11434`)
- Create: `deploy/compose/scripts/validate-ollama.sh`

**Interfaces:**
- Consumes: gateway rebuildado com as rotas Ollama (Tasks 1–5), cadeia F1 no ar.
- Produces: `validate-ollama.sh` — critério de aceite da superfície Ollama da F3.

- [ ] **Step 1: Confirmar que a porta 11434 está livre e voltar o gateway pra ela**

Run: `ss -tlnp | grep 11434 || echo LIVRE`
Expected: `LIVRE` (o `ollama.service` nativo foi desabilitado 2026-07-03). Se algo ainda ocupar a 11434, manter `GATEWAY_HOST_PORT` alternativa e ajustar os comandos abaixo.

Editar `deploy/compose/.env` (local, não commitado) trocando a linha:

```bash
GATEWAY_HOST_PORT=21434
```

por:

```bash
GATEWAY_HOST_PORT=11434
```

- [ ] **Step 2: Rebuildar e subir o gateway na porta nova**

Run:
```bash
cd /home/fkmatsuda/workspace/corehub.ia/ia-stack
docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env --profile local-models up -d --build gateway
sleep 10
docker compose -f deploy/compose/docker-compose.yml --profile local-models ps gateway
```
Expected: `gateway` `Up (healthy)`, `PORTS` mostrando `0.0.0.0:11434->11434/tcp`.

- [ ] **Step 3: Criar `deploy/compose/scripts/validate-ollama.sh`**

```bash
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

# 2. inferencia sem auth de fora => 401 (aqui roda de loopback, entao injeta a default;
#    validamos que COM chave funciona)
# 3. /api/chat NDJSON (stream) terminando com done:true
last=$(curl -sSN -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"auto","stream":true,"messages":[{"role":"user","content":"diga oi"}]}' \
  $GW/api/chat | tail -1)
echo "$last" | jq -e '.done==true and .message.role=="assistant"' >/dev/null \
  && say "/api/chat NDJSON done:true" PASS || { say "/api/chat NDJSON done:true" FAIL; echo "$last" | head -c 200; fail=1; }
echo "$last" | jq -e 'has("total_duration") and has("eval_count")' >/dev/null \
  && say "/api/chat chunk final tem stats" PASS || { say "/api/chat chunk final tem stats" FAIL; fail=1; }

# 4. /api/chat nao-streaming
curl -sS -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"auto","stream":false,"messages":[{"role":"user","content":"diga oi"}]}' \
  $GW/api/chat | jq -e '.done==true and (.message.content|type=="string")' >/dev/null \
  && say "/api/chat nao-stream ok" PASS || { say "/api/chat nao-stream ok" FAIL; fail=1; }

# 5. /api/generate stream
gl=$(curl -sSN -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"auto","stream":true,"prompt":"diga oi"}' $GW/api/generate | tail -1)
echo "$gl" | jq -e '.done==true and has("response")' >/dev/null \
  && say "/api/generate NDJSON done:true" PASS || { say "/api/generate NDJSON done:true" FAIL; fail=1; }

# 6. embeddings 501
check "/api/embeddings => 501" 501 \
  "$(curl -sS -o /dev/null -w '%{http_code}' -X POST $GW/api/embeddings -d '{"model":"auto","input":"x"}')"

# 7. superficies da F2 continuam vivas
check "/v1/models (com chave) 200" 200 \
  "$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" $GW/v1/models)"

exit $fail
```

- [ ] **Step 4: Rodar e corrigir até verde**

Run: `chmod +x deploy/compose/scripts/validate-ollama.sh && ./deploy/compose/scripts/validate-ollama.sh`
Expected: todas as linhas `PASS`, exit 0. Diagnóstico:
- `/api/chat` sem `done:true` → conferir `docker compose logs gateway`; provavelmente o SSE upstream não está sendo lido linha a linha (checar `readSseLines`).
- 401 inesperado com chave → a chave `mnfst_` não está atravessando (`proxyHeaders`).

- [ ] **Step 5: Confirmar por um cliente Ollama real (opcional mas recomendado)**

Run (se `ollama` CLI estiver instalado no host — aponta pro gateway):
```bash
OLLAMA_HOST=http://127.0.0.1:${GATEWAY_HOST_PORT:-11434} ollama list
```
Expected: lista contendo `auto`. (Se o `ollama` CLI não estiver instalado, pular — o `validate-ollama.sh` já cobre o contrato.)

- [ ] **Step 6: Commit**

```bash
cd /home/fkmatsuda/workspace/corehub.ia/ia-stack
git add deploy/compose/scripts/validate-ollama.sh
git commit -m "$(cat <<'EOF'
feat(f3): validate-ollama.sh (discovery + /api/chat + /api/generate ao vivo)

Gateway de volta na porta padrao 11434 (.env local; ollama.service nativo
desabilitado liberou a porta). Superficie Ollama validada 100% contra a
cadeia real; superficies OpenAI/Anthropic da F2 seguem vivas.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Open WebUI no compose + docs + push

**Files:**
- Modify: `deploy/compose/docker-compose.yml` (serviço `openwebui`, profile `ui`)
- Modify: `deploy/compose/.env.example` (`WEBUI_SECRET_KEY`)
- Modify: `deploy/compose/.env` (local — `WEBUI_SECRET_KEY` gerado)
- Modify: `docs/connecting-tools.md` (seção Open WebUI + clientes Ollama)
- Modify: `README.md` (status F3)

**Interfaces:**
- Consumes: gateway na rede do compose (`http://gateway:11434/v1`), `MANIFEST_KEY_OPENWEBUI` (F1).
- Produces: serviço `openwebui` em `0.0.0.0:3000` (profile `ui`), conectado à cadeia via conexão tipo OpenAI.

- [ ] **Step 1: Adicionar o serviço `openwebui` ao `deploy/compose/docker-compose.yml`**

Adicionar (após o serviço `gateway`, antes de `manifest`):

```yaml
  openwebui:
    image: ghcr.io/open-webui/open-webui:0.6.18
    restart: unless-stopped
    profiles: [ui]
    ports:
      - "0.0.0.0:3000:8080"            # UI de chat na LAN (auth própria do Open WebUI)
    environment:
      # Conexão tipo OpenAI apontando pro gateway (spec §3: mais simples que a
      # conexão Ollama pra portar credencial). RAG interno usa embeddings
      # locais próprios do Open WebUI, sem tocar na cadeia.
      - OPENAI_API_BASE_URL=http://gateway:11434/v1
      - OPENAI_API_KEY=${MANIFEST_KEY_OPENWEBUI}
      - ENABLE_OLLAMA_API=false
      - WEBUI_AUTH=true
      - WEBUI_SECRET_KEY=${WEBUI_SECRET_KEY:?defina no .env}
    volumes:
      - openwebui_data:/app/backend/data
    depends_on:
      gateway:
        condition: service_healthy
```

E adicionar o volume no bloco `volumes:` do fim do arquivo:

```yaml
  openwebui_data:
    name: ia-stack_openwebui
```

- [ ] **Step 2: Adicionar `WEBUI_SECRET_KEY` ao `.env.example`**

Adicionar no bloco do gateway/UI do `deploy/compose/.env.example`:

```bash
# ── Open WebUI (profile ui) — segredo da sessão da UI ─────────────────
WEBUI_SECRET_KEY=
```

E documentar no comentário do `COMPOSE_PROFILES` que `ui` ativa o Open WebUI (não obrigatório).

- [ ] **Step 3: Gerar `WEBUI_SECRET_KEY` no `.env` local**

Run:
```bash
cd /home/fkmatsuda/workspace/corehub.ia/ia-stack/deploy/compose
grep -q '^WEBUI_SECRET_KEY=' .env || echo "WEBUI_SECRET_KEY=$(openssl rand -hex 32)" >> .env
grep -c '^WEBUI_SECRET_KEY=.\+' .env
```
Expected: `1`.

- [ ] **Step 4: Validar o compose e subir o Open WebUI**

Run:
```bash
cd /home/fkmatsuda/workspace/corehub.ia/ia-stack
docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env config -q && echo OK
docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env --profile local-models --profile ui up -d
sleep 20
docker compose -f deploy/compose/docker-compose.yml --profile local-models --profile ui ps openwebui
```
Expected: `OK`; `openwebui` `Up`. (Pode levar mais tempo pro primeiro boot — se ainda subindo, checar `docker compose logs openwebui`.)

- [ ] **Step 5: Smoke da conexão OpenWebUI → gateway (de dentro da rede do compose)**

Run:
```bash
docker compose -f /home/fkmatsuda/workspace/corehub.ia/ia-stack/deploy/compose/docker-compose.yml \
  exec -T openwebui sh -c 'curl -sS -o /dev/null -w "%{http_code}\n" http://gateway:11434/health' 2>&1 || \
docker run --rm --network ia-stack_net curlimages/curl:latest -sS -o /dev/null -w '%{http_code}\n' http://gateway:11434/health
```
Expected: `200` (o Open WebUI enxerga o gateway na rede interna). Se a imagem não tiver `curl`, o fallback com o sidecar cobre.

- [ ] **Step 6 (MANUAL — usuário): Validar no navegador**

Abrir `http://localhost:3000` (ou `http://<ip-lan>:3000`), criar a conta admin do Open WebUI, e mandar uma mensagem escolhendo o modelo `auto`. Conferir no dashboard do manifest (`:2099`) que a request aparece atribuída ao agente **openwebui**.

- [ ] **Step 7: Atualizar `docs/connecting-tools.md`**

Adicionar ao fim de `docs/connecting-tools.md`:

```markdown
## Open WebUI
Sobe junto com o stack pelo profile `ui`:
\`\`\`bash
docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env \
  --profile local-models --profile ui up -d
\`\`\`
Abrir `http://<ip-da-maquina>:3000`, criar a conta admin (auth própria do Open WebUI),
e usar o modelo `auto`. A conexão já vem configurada (env `OPENAI_API_BASE_URL` →
`http://gateway:11434/v1`, chave `MANIFEST_KEY_OPENWEBUI`).

## Clientes Ollama genéricos
O gateway expõe a superfície Ollama em `:11434`. Qualquer cliente que fale o protocolo
Ollama conecta apontando `OLLAMA_HOST=http://<ip-da-maquina>:11434`. Modelos disponíveis
via `GET /api/tags` (só `auto` por enquanto). Clientes de loopback ou dentro de
`GATEWAY_TRUSTED_CIDRS` não precisam de chave; os demais mandam a chave `mnfst_` do seu
agente como `Authorization: Bearer`.
```

- [ ] **Step 8: Atualizar o `README.md` pro status F3**

Trocar a linha de status e o quick start:

```markdown
**Status:** F3 — Ollama façade live (`/api/chat`, `/api/generate`, `tags`/`show`/`version`);
Open WebUI in the stack; OpenAI + Anthropic surfaces from F2 still up. Gateway on `:11434`.

## Quick start (F3)

1. `cd deploy/compose && cp .env.example .env` — fill the three secrets (`openssl rand -hex 32`)
   plus `WEBUI_SECRET_KEY` if you'll use the `ui` profile.
2. `docker compose --profile local-models up -d --build` (add `--profile ui` for Open WebUI).
3. Open `http://localhost:2099` — create the admin account, connect a provider (bundled
   Ollama tile works once you `docker exec <ollama-container> ollama pull <model>`), set the
   default routing tier, create the agents and put their `mnfst_` keys in `.env`.
4. `./scripts/validate-ollama.sh` (and `./scripts/validate-gateway.sh`) — everything must PASS.
5. See `docs/connecting-tools.md` for opencode / Claude Code / Copilot / Open WebUI / Ollama clients.
```

- [ ] **Step 9: Rodar a suíte completa uma última vez**

Run:
```bash
cd /home/fkmatsuda/workspace/corehub.ia/ia-stack
bun run typecheck && bun run lint && bun test packages/gateway/test
docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env config -q && echo COMPOSE_OK
./deploy/compose/scripts/validate-ollama.sh
```
Expected: tudo verde.

- [ ] **Step 10: Commit e push**

```bash
git add deploy/compose/docker-compose.yml deploy/compose/.env.example \
  docs/connecting-tools.md README.md
git commit -m "$(cat <<'EOF'
feat(f3): Open WebUI no compose (profile ui) + docs de conexao; README da F3

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
git push origin main
```

- [ ] **Step 11: Verificar CI verde no GitHub**

Run: `git ls-remote --heads origin main`
Expected: hash de `main` listado. No site: aba Actions com `ci` verde (3 jobs). O `gateway-checks` já roda todos os testes novos da F3 (`bun test packages/gateway/test`).

---

## Critério de aceite da F3 (do spec §9)

- [ ] `validate-ollama.sh` todo PASS (discovery, `/api/chat` stream+não-stream, `/api/generate`, embeddings 501, F2 viva)
- [ ] Cliente Ollama genérico conversa via `:11434` (tradução NDJSON + tool_calls como objeto)
- [ ] Open WebUI operacional em `:3000`, request atribuída ao agente `openwebui` no dashboard (Task 7 Step 6)
- [ ] Superfícies OpenAI/Anthropic da F2 intactas
- [ ] CI verde no GitHub (3 jobs)

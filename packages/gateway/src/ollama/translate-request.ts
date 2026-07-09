import type { OllamaChatRequest, OllamaMessage, OllamaTool, OpenAiChatRequest } from "./types.js";

function thinkToReasoningEffort(
  think: OllamaChatRequest["think"],
): "low" | "medium" | "high" | undefined {
  if (think === undefined || think === false) return undefined;
  if (think === true) return "medium";
  if (think === "max") return "high";
  return think; // "low" | "medium" | "high"
}

// Providers estritos (deepseek, opencode-go; reproduzido ao vivo 2026-07-09)
// rejeitam tool_call com id vazio/duplicado e tool_call sem mensagem de
// resposta -- e o fallback do manifest mascara o 400 como 200, só trocando o
// provider. A tradução garante: (1) todo tool_call sai com id válido e único
// no request (id do cliente mantido quando ok); (2) respostas role:"tool"
// casam por nome em ordem FIFO (semântica Ollama: nome + ordem, sem id),
// cobrindo calls paralelos do mesmo tool; (3) call que ficou sem resposta
// (ex.: cancelado pelo usuário) ganha um stub antes da próxima mensagem
// não-tool, preservando a adjacência que os providers exigem.
const VALID_TOOL_ID = /^[a-zA-Z0-9_-]+$/;
const MISSING_RESULT_STUB = "[tool result not provided by client]";

function translateMessages(messages: OllamaMessage[]): unknown[] {
  const out: unknown[] = [];
  const usedIds = new Set<string>();
  let synthCounter = 0;
  // Pendências do bloco assistant-com-tools corrente: fila por nome (casar
  // resposta com call do mesmo tool) + ordem global (stub e resposta sem
  // tool_name usam o call mais antigo).
  let pendingByName = new Map<string, string[]>();
  let pendingOrder: string[] = [];

  const freshId = (): string => {
    let id: string;
    do {
      id = `call_${synthCounter}`;
      synthCounter += 1;
    } while (usedIds.has(id));
    return id;
  };

  const takePending = (id: string): void => {
    pendingOrder = pendingOrder.filter((pending) => pending !== id);
    for (const queue of pendingByName.values()) {
      const at = queue.indexOf(id);
      if (at !== -1) {
        queue.splice(at, 1);
        break;
      }
    }
  };

  const flushPending = (): void => {
    for (const id of pendingOrder) {
      out.push({ role: "tool", tool_call_id: id, content: MISSING_RESULT_STUB });
    }
    pendingByName = new Map();
    pendingOrder = [];
  };

  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      flushPending(); // bloco anterior ainda aberto -> stubs antes de abrir outro
      const tool_calls = msg.tool_calls.map((tc) => {
        const id =
          tc.id !== undefined && VALID_TOOL_ID.test(tc.id) && !usedIds.has(tc.id)
            ? tc.id
            : freshId();
        usedIds.add(id);
        pendingByName.set(tc.function.name, [...(pendingByName.get(tc.function.name) ?? []), id]);
        pendingOrder.push(id);
        return {
          id,
          type: "function" as const,
          function: { name: tc.function.name, arguments: JSON.stringify(tc.function.arguments) },
        };
      });
      out.push({ role: "assistant", content: msg.content ?? "", tool_calls });
      continue;
    }

    if (msg.role === "tool") {
      const queue = msg.tool_name ? pendingByName.get(msg.tool_name) : undefined;
      const matched = msg.tool_name ? queue?.[0] : pendingOrder[0];
      if (matched !== undefined) takePending(matched);
      // Fallback degenerado (tool msg órfã): mantém o comportamento antigo
      // (tool_name como id, ou vazio) -- entrada já era inválida.
      const tool_call_id = matched ?? msg.tool_name ?? "";
      out.push({ role: "tool", tool_call_id, content: msg.content });
      continue;
    }

    flushPending(); // user/system fecha o bloco: pendência vira stub (adjacência)
    out.push({ role: msg.role, content: msg.content });
  }

  flushPending(); // histórico terminando em tool_calls sem resposta
  return out;
}

// deepseek rejeita DECLARAÇÃO de tool com schema nulo ("null is not of type
// 'object'" / "got 'type: null'") -- o harness ollama-js declara tools sem
// parâmetros com `parameters: {type: null, properties: null}` (reproduzido ao
// vivo 2026-07-09). parameters AUSENTE é aceito; normaliza só o
// presente-mas-nulo, preservando o resto do schema.
function translateTools(tools: OllamaTool[]): unknown[] {
  return tools.map((tool) => {
    if (!("parameters" in tool.function)) return tool;
    const params = tool.function.parameters;
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      return {
        ...tool,
        function: { ...tool.function, parameters: { type: "object", properties: {} } },
      };
    }
    const record = params as Record<string, unknown>;
    if (record.type === "object" && record.properties !== null) return tool;
    const patched: Record<string, unknown> = { ...record };
    if (patched.type == null) patched.type = "object";
    if (patched.properties === null) patched.properties = {};
    return { ...tool, function: { ...tool.function, parameters: patched } };
  });
}

export function ollamaChatToOpenAi(req: OllamaChatRequest): OpenAiChatRequest {
  const out: OpenAiChatRequest = {
    model: req.model,
    messages: translateMessages(req.messages),
  };

  if (req.tools && req.tools.length > 0) out.tools = translateTools(req.tools);
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

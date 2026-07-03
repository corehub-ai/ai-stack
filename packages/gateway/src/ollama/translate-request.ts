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

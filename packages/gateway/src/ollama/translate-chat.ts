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

import { parseSseData } from "./sse.js";
import type {
  OllamaChatChunk,
  OllamaGenerateChunk,
  OllamaToolCall,
  TranslateCtx,
} from "./types.js";

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
    // id vazio não é repassado: o cliente ecoaria "" de volta e providers
    // estritos (deepseek) rejeitam (achado 2026-07-09). Sem id, o request-side
    // sintetiza um válido.
    if (typeof call.id === "string" && call.id.length > 0) toolCall.id = call.id;
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

type ToolAccumulator = { id?: string; name: string; argsBuffer: string };

function buildAccumulatedToolCalls(
  acc: Map<number, ToolAccumulator>,
): OllamaToolCall[] | undefined {
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
    const call: OllamaToolCall = { function: { index, name: tool.name, arguments: args } };
    if (tool.id !== undefined) call.id = tool.id;
    calls.push(call);
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
        // id vazio em delta não sobrescreve o id real do 1o delta nem chega ao
        // cliente (mesmo motivo do não-stream: eco de "" quebra o deepseek).
        if (typeof raw.id === "string" && raw.id.length > 0) existing.id = raw.id;
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

// Campos de estatística compartilhados por chat e generate no chunk final.
// exactOptionalPropertyTypes:true não deixa atribuir `x: undefined` explícito,
// então copiamos só os que estão definidos (sempre estão num chunk done).
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

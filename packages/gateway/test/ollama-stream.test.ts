import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { translateChatStream } from "../src/ollama/translate-chat.js";
import type { OllamaChatChunk, TranslateCtx } from "../src/ollama/types.js";

const ctx: TranslateCtx = {
  model: "auto",
  createdAt: "2026-07-03T00:00:00Z",
  durations: {
    total_duration: 1000,
    load_duration: 100,
    prompt_eval_duration: 0,
    eval_duration: 900,
  },
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

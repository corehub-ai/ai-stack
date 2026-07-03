import { describe, expect, it } from "bun:test";
import {
  translateGenerateNonStream,
  translateGenerateStream,
} from "../src/ollama/translate-chat.js";
import type { OllamaGenerateChunk, TranslateCtx } from "../src/ollama/types.js";

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

describe("translateGenerate", () => {
  it("maps a non-streaming OpenAI response into an Ollama generate chunk (response field)", () => {
    const openai = {
      choices: [
        { index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" },
      ],
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

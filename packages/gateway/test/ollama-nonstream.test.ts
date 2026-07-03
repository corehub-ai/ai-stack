import { describe, expect, it } from "bun:test";
import { translateChatNonStream } from "../src/ollama/translate-chat.js";
import type { TranslateCtx } from "../src/ollama/types.js";

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

describe("translateChatNonStream", () => {
  it("maps content, finish_reason and usage into a single done Ollama chunk", () => {
    const openai = {
      choices: [
        { index: 0, message: { role: "assistant", content: "Olá!" }, finish_reason: "stop" },
      ],
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
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"Paris"}' },
              },
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
      choices: [
        { index: 0, message: { role: "assistant", content: "trunc" }, finish_reason: "length" },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 16 },
    };
    expect(translateChatNonStream(openai, ctx).done_reason).toBe("length");
  });
});
